import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Modal, TouchableOpacity } from 'react-native';
import TrackEditScreen from '../TrackEditScreen';
import AlbumEditScreen from '../../albums/AlbumEditScreen';
import { setTrackArtists, setAlbumArtists } from '../../../shared/api/artistCredits';
import { authFetch } from '../../../shared/api/api';
import * as ImagePicker from 'expo-image-picker';

jest.mock('../../../shared/api/artistCredits', () => ({ setTrackArtists: jest.fn(), setAlbumArtists: jest.fn() }));
jest.mock('../../../shared/api/artists', () => ({ getArtists: jest.fn() }));
jest.mock('../../../shared/api/api', () => ({ SERVER_URL: 'https://puuk.app', authFetch: jest.fn(), parseApiErrorMessage: (_, fallback) => fallback }));
jest.mock('../../../shared/storage/settings', () => ({ getSettings: () => ({}), addSettingsListener: () => () => {} }));
jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');
jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const change = async (root, placeholder, value) => act(async () => root.findByProps({ placeholder }).props.onChangeText(value));
const press = async (root, label) => { let node = root.findByProps({ children: label }).parent; while (node && node.type !== TouchableOpacity) node = node.parent; await act(async () => node.props.onPress()); };
beforeEach(() => { jest.clearAllMocks(); ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true }); ImagePicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'draft-cover', base64: 'abc' }] }); });
test('track draft survives delayed load and credits save', async () => {
  const request = deferred(); authFetch.mockReturnValueOnce(request.promise).mockResolvedValueOnce({ ok: true, json: async () => ({}) });
  let tree; await act(async () => { tree = TestRenderer.create(<TrackEditScreen route={{ params: { track: { id: 't', title: 'Old' } } }} navigation={{ goBack: jest.fn() }} />); });
  await change(tree.root, 'Track title', 'Draft title'); await change(tree.root, 'No lyrics saved yet...', 'Draft lyrics');
  setTrackArtists.mockResolvedValue({ id: 't', artists: [{ id: 'a', name: 'A' }], artists_revision: 2, artist: 'A' });
  await act(async () => tree.root.findByProps({ accessibilityLabel: 'Изменить исполнителей' }).props.onPress());
  await act(async () => tree.root.findByType(Modal).props.onShow());
  await press(tree.root, 'Сохранить состав в Puuk');
  await act(async () => { request.resolve({ ok: true, json: async () => ({ title: 'Server', lyrics: 'Server lyrics' }) }); await request.promise; });
  expect(tree.root.findByProps({ placeholder: 'Track title' }).props.value).toBe('Draft title');
  expect(tree.root.findByProps({ placeholder: 'No lyrics saved yet...' }).props.value).toBe('Draft lyrics');
  await press(tree.root, 'Save Changes'); const body = authFetch.mock.calls.find(([, options]) => options?.method === 'PATCH')[1].body;
  expect(body).toMatchObject({ title: 'Draft title', lyrics: 'Draft lyrics' }); expect(body).not.toHaveProperty('artist');
});
test('album draft cover and title survive delayed load and credits save', async () => {
  const request = deferred(); authFetch.mockReturnValueOnce(request.promise).mockResolvedValueOnce({ ok: true, json: async () => ({ album: {} }) });
  let tree; await act(async () => { tree = TestRenderer.create(<AlbumEditScreen route={{ params: { albumId: 1, album: { title: 'Old' } } }} navigation={{ goBack: jest.fn() }} />); });
  await change(tree.root, 'Album title', 'Draft album'); await press(tree.root, 'Выбрать');
  setAlbumArtists.mockResolvedValue({ album: { artists: [{ id: 'a', name: 'A' }], artists_revision: 2 }, tracks: [] });
  await act(async () => tree.root.findByProps({ accessibilityLabel: 'Изменить исполнителей' }).props.onPress());
  await act(async () => tree.root.findByType(Modal).props.onShow());
  await press(tree.root, 'Сохранить состав в Puuk');
  await act(async () => { request.resolve({ ok: true, json: async () => ({ album: { title: 'Server', coverArt: 'server-cover' } }) }); await request.promise; });
  expect(tree.root.findByProps({ placeholder: 'Album title' }).props.value).toBe('Draft album');
  await press(tree.root, 'Сохранить альбом'); const body = authFetch.mock.calls.find(([, options]) => options?.method === 'PATCH')[1].body;
  expect(body).toMatchObject({ title: 'Draft album', cover_action: 'replace', cover_base64: 'data:image/jpeg;base64,abc' }); expect(body).not.toHaveProperty('album_artist');
});

test.each([
  ['track', TrackEditScreen, { params: { track: { id: 't', title: 'Old' } } }, 'Track title', setTrackArtists],
  ['album', AlbumEditScreen, { params: { albumId: 1, album: { title: 'Old' } } }, 'Album title', setAlbumArtists],
])('%s parent keeps draft after conflict, failure and cancel', async (_, Screen, route, placeholder, save) => {
  authFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  save.mockRejectedValueOnce({ code: 'artists_revision_conflict', current_revision: 3, artists: [{ id: 'b', name: 'B' }] }).mockRejectedValueOnce(new Error('offline'));
  let tree; await act(async () => { tree = TestRenderer.create(<Screen route={route} navigation={{ goBack: jest.fn() }} />); });
  await change(tree.root, placeholder, 'Unsaved');
  await act(async () => tree.root.findByProps({ accessibilityLabel: 'Изменить исполнителей' }).props.onPress());
  await act(async () => tree.root.findByType(Modal).props.onShow());
  await press(tree.root, 'Сохранить состав в Puuk');
  await press(tree.root, 'Обновить ревизию и продолжить правку');
  await press(tree.root, 'Сохранить состав в Puuk');
  await press(tree.root, 'Отмена');
  expect(tree.root.findByProps({ placeholder }).props.value).toBe('Unsaved');
});
