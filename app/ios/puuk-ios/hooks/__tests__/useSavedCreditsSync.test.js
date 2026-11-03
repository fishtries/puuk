import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DeviceEventEmitter } from 'react-native';
import useSavedCreditsSync from '../useSavedCreditsSync';
const api = require('../../shared/api/api');
import { getSavedLastTrack, setSavedLastTrack } from '../../shared/storage/settings';

const mockListeners = new Set();
jest.mock('../../shared/api/api', () => ({ SERVER_URL: 'https://one', authFetch: jest.fn(), addAuthListener: (fn) => { mockListeners.add(fn); return () => mockListeners.delete(fn); } }));
jest.mock('../../shared/storage/settings', () => ({ getSavedLastTrack: jest.fn(), setSavedLastTrack: jest.fn() }));
const emit = (event) => DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED', event);
const bulk = (id) => ({ scope: 'bulk', affected: { track_ids: [id] } });
const defaultUser = { id: 1 };
function Harness({ currentTrack = null, user = defaultUser }) { useSavedCreditsSync(currentTrack, user); return null; }

// Aborting deliberately does not settle these requests. A slot is released only
// when the test resolves the response or delivers a delayed abort rejection.
function deferRequests() {
  const requests = [];
  let outstanding = 0;
  let maximum = 0;
  api.authFetch.mockImplementation((url, { signal }) => {
    outstanding += 1;
    maximum = Math.max(maximum, outstanding);
    return new Promise((resolve, reject) => requests.push({
      signal,
      finish(artist, rejectAbort = false) {
        outstanding -= 1;
        if (rejectAbort && signal.aborted) reject(new Error('Delayed abort'));
        else resolve({ ok: true, json: async () => ({ id: 'a', artist, title: 'Must not replace title' }) });
      },
    }));
  });
  return { requests, get outstanding() { return outstanding; }, get maximum() { return maximum; } };
}

describe('inactive saved track credit updates', () => {
  let renderer, saved, resolve;
  beforeEach(async () => {
    jest.clearAllMocks(); api.SERVER_URL = 'https://one'; saved = { id: 'a', artist: 'Old' };
    getSavedLastTrack.mockImplementation(async () => saved);
    setSavedLastTrack.mockImplementation(async (track) => { saved = track; });
    api.authFetch.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await act(async () => { renderer = TestRenderer.create(<Harness />); });
  });
  afterEach(async () => { await act(async () => renderer.unmount()); });
  const finish = async () => { await act(async () => { resolve({ ok: true, json: async () => ({ id: 'a', artist: 'New' }) }); }); };
  test('unrelated single and bulk events do not cancel the saved track', async () => {
    await act(async () => { emit(bulk('a')); });
    await act(async () => { emit({ scope: 'track', track: { id: 'b', artist: 'B' } }); emit(bulk('b')); });
    await finish(); expect(saved.artist).toBe('New'); expect(api.authFetch).toHaveBeenCalledTimes(1);
  });
  test('newer same-track event wins', async () => {
    await act(async () => { emit(bulk('a')); });
    await act(async () => { emit({ scope: 'track', track: { id: 'a', artist: 'Newest' } }); });
    await finish(); expect(saved.artist).toBe('Newest');
  });
  test.each(['saved track', 'user', 'server', 'active track'])('discards pending data after %s changes', async (change) => {
    await act(async () => { emit(bulk('a')); });
    await act(async () => {
      if (change === 'saved track') saved = { id: 'b', artist: 'B' };
      if (change === 'user') mockListeners.forEach((fn) => fn({ id: 2 }));
      if (change === 'server') api.SERVER_URL = 'https://two';
      if (change === 'active track') renderer.update(<Harness currentTrack={{ id: 'b' }} />);
    });
    await finish(); expect(setSavedLastTrack).not.toHaveBeenCalled();
  });

  test.each([false, true])('keeps four slots across repeated user and current-track restarts (delayed abort rejection: %s)', async (rejectAbort) => {
    saved = { id: 'a', artist: 'Old', title: 'Saved title', position: 27 };
    const deferred = deferRequests();
    const burst = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { emit(bulk('a')); }); };
    await burst();
    expect(deferred.outstanding).toBe(4);

    await act(async () => { renderer.update(<Harness user={{ id: 2 }} />); });
    expect(deferred.requests.every(({ signal }) => signal.aborted)).toBe(true);
    await burst();
    await act(async () => { renderer.update(<Harness user={{ id: 3 }} currentTrack={{ id: 'b' }} />); });
    await burst(); // Active player owns saved-track updates; this queue is obsolete.
    await act(async () => { renderer.update(<Harness user={{ id: 4 }} />); });
    await burst();
    expect(deferred.requests).toHaveLength(4);

    // An old effect's completion must wake the latest queue without another event.
    await act(async () => { deferred.requests[0].finish('Stale user 1', rejectAbort); });
    expect(deferred.requests).toHaveLength(5);
    expect(deferred.outstanding).toBe(4);
    expect(deferred.requests[4].signal.aborted).toBe(false);
    expect(setSavedLastTrack).not.toHaveBeenCalled();

    // Repeat cleanup after a new request has started; keep all four slots owned.
    await act(async () => { renderer.update(<Harness user={{ id: 5 }} currentTrack={{ id: 'c' }} />); });
    await act(async () => { renderer.update(<Harness user={{ id: 6 }} />); });
    await burst();
    expect(deferred.requests[4].signal.aborted).toBe(true);
    expect(deferred.requests).toHaveLength(5);
    await act(async () => { deferred.requests[4].finish('Stale user 4', rejectAbort); });
    expect(deferred.requests).toHaveLength(6);
    for (let i = 1; i < 4; i += 1) {
      await act(async () => { deferred.requests[i].finish('Stale user 1', rejectAbort); });
    }
    expect(setSavedLastTrack).not.toHaveBeenCalled();
    await act(async () => { deferred.requests[5].finish('Newest'); });
    expect(deferred.maximum).toBe(4);
    expect(deferred.outstanding).toBe(0);
    expect(deferred.requests).toHaveLength(6);
    expect(setSavedLastTrack).toHaveBeenCalledTimes(1);
    expect(saved).toEqual({ id: 'a', artist: 'Newest', title: 'Saved title', position: 27 });
  });

  test('auth events cancel old requests without freeing slots and current work drains', async () => {
    const deferred = deferRequests();
    for (let i = 0; i < 4; i += 1) await act(async () => { emit(bulk('a')); });
    await act(async () => { mockListeners.forEach((fn) => fn({ id: 2 })); emit(bulk('a')); });
    expect(deferred.requests).toHaveLength(4);
    expect(deferred.requests.every(({ signal }) => signal.aborted)).toBe(true);
    await act(async () => { deferred.requests[0].finish('Stale'); });
    expect(deferred.requests).toHaveLength(5);
    expect(deferred.requests[4].signal.aborted).toBe(false);
    // A newer same-ID single event must supersede the newly started bulk too.
    await act(async () => { emit({ scope: 'track', track: { id: 'a', artist: 'Newest single' } }); });
    for (let i = 1; i < 5; i += 1) await act(async () => { deferred.requests[i].finish('Stale'); });
    expect(deferred.maximum).toBe(4);
    expect(deferred.outstanding).toBe(0);
    expect(saved.artist).toBe('Newest single');
    expect(setSavedLastTrack).toHaveBeenCalledTimes(1);
  });

  test('unmount cancels outstanding requests and never starts stranded pending work', async () => {
    const deferred = deferRequests();
    for (let i = 0; i < 5; i += 1) await act(async () => { emit(bulk('a')); });
    expect(deferred.requests).toHaveLength(4);
    await act(async () => { renderer.unmount(); });
    expect(deferred.requests.every(({ signal }) => signal.aborted)).toBe(true);
    for (let i = 0; i < 4; i += 1) await act(async () => { deferred.requests[i].finish('Stale'); });
    expect(deferred.requests).toHaveLength(4);
    expect(deferred.outstanding).toBe(0);
    expect(setSavedLastTrack).not.toHaveBeenCalled();
  });
});
