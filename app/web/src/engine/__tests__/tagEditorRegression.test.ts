import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLRC } from '../lrcParser.ts';
import { getCoverUrl } from '../../api/tracks.ts';
import type { Track, TrackEditPayloadDTO } from '../../types/track.ts';

describe('Tag Editor & Store Integration Tests', () => {
  it('1. getCoverUrl appends cover_version correctly for cache busting', () => {
    const trackWithVersion: Track = {
      id: 'test-track-123',
      title: 'Echoes',
      artist: 'Pink Floyd',
      duration: 300,
      cover_version: 3,
    };

    const url = getCoverUrl(trackWithVersion);
    assert.equal(url, '/api/cover/test-track-123?v=3');

    const trackWithoutVersion: Track = {
      id: 'test-track-456',
      title: 'Time',
      artist: 'Pink Floyd',
      duration: 400,
    };

    const urlNoVersion = getCoverUrl(trackWithoutVersion);
    assert.equal(urlNoVersion, '/api/cover/test-track-456');

    // With explicit coverArt URL
    const trackWithCoverArt: Track = {
      id: 'test-track-789',
      title: 'Money',
      artist: 'Pink Floyd',
      duration: 380,
      coverArt: '/api/cover/custom-cover-id',
      cover_version: 5,
    };
    assert.equal(getCoverUrl(trackWithCoverArt), '/api/cover/custom-cover-id?v=5');
  });

  it('2. parseLRC cleanly separates synced lyrics from plain text during tag update', () => {
    const syncedLrc = `[ti:Test Title]
[00:10.50]First line of synced lyrics
[00:25.00]Second line of synced lyrics`;

    const parsedSynced = parseLRC(syncedLrc);
    assert.equal(parsedSynced.length, 2);
    assert.equal(parsedSynced[0].time, 10.5);
    assert.equal(parsedSynced[0].text, 'First line of synced lyrics');
    assert.equal(parsedSynced[1].time, 25.0);
    assert.equal(parsedSynced[1].text, 'Second line of synced lyrics');

    const plainText = `Just regular lyrics text without timestamps
Line two of regular song`;

    const parsedPlain = parseLRC(plainText);
    assert.equal(parsedPlain.length, 0, 'Plain text should not synthesize artificial timestamps');
  });

  it('3. TrackEditPayloadDTO accepts all required metadata mutation fields', () => {
    const payload: TrackEditPayloadDTO = {
      title: 'Solar Echoes (Remastered)',
      artist: 'Antigravity Studio',
      album: 'Deep Space Horizon Deluxe',
      album_artist: 'Antigravity Ensemble',
      year: 2026,
      genre: 'Ambient Space',
      track_number: '1/10',
      disc_number: '1/1',
      comment: 'Edited via Puuk ID3 Tag Editor',
      lyrics: '[00:05.00]Ambient sound starts...',
      cover_action: 'replace',
      cover_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      cover_mime: 'image/png',
    };

    assert.equal(payload.title, 'Solar Echoes (Remastered)');
    assert.equal(payload.year, 2026);
    assert.equal(payload.cover_action, 'replace');
    assert.ok(payload.cover_base64);
  });
});
