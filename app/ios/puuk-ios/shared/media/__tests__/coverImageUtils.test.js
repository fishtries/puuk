import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Image, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import CoverImage, {
  isServerCoverUri,
  isArtistArtworkUri,
  resolveLockScreenCover,
  resolveCoverUri,
  prefetchCover,
  NeutralPlaceholder,
  DEFAULT_COVER,
  coverPreviewSize,
} from '../CoverImage';
import * as api from '../../api/api';

describe('components/CoverImage and utils', () => {
  it('selects bounded previews for native pixel dimensions', () => {
    expect(coverPreviewSize({ width: 50, height: 50 }, 3)).toBe(256);
    expect(coverPreviewSize({ width: 300, height: 300 }, 3)).toBe(1024);
    expect(coverPreviewSize({ width: '100%' }, 3)).toBe(1024);
  });

  it('keeps preview authorization and version while leaving artist artwork alone', () => {
    const uri = new URL(resolveCoverUri('/api/cover/example?v=7', { size: 256 }));
    expect(uri.searchParams.get('v')).toBe('7');
    expect(uri.searchParams.has('token')).toBe(false);
    expect(uri.searchParams.get('size')).toBe('256');
    expect(resolveCoverUri('/api/artists/example/artwork', { size: 256 })).not.toContain('size=');
  });
  const originalServerUrl = api.SERVER_URL;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    api.setServerUrl(originalServerUrl);
  });

  describe('isArtistArtworkUri', () => {
    it('returns true for relative artist artwork paths', () => {
      expect(isArtistArtworkUri('/api/artists/art_62602a42/artwork')).toBe(true);
      expect(isArtistArtworkUri('/api/artists/art_62602a42/artwork?v=2')).toBe(true);
      expect(isArtistArtworkUri('/api/artists/art_62602a42/artwork/')).toBe(true);
    });

    it('returns true for absolute URLs on any host', () => {
      expect(isArtistArtworkUri('https://web.puuk.fun/api/artists/art_123/artwork?v=1')).toBe(true);
      expect(isArtistArtworkUri('http://192.168.1.117:8000/api/artists/art_456/artwork')).toBe(true);
    });

    it('returns false for non-artwork artist endpoints and general paths', () => {
      expect(isArtistArtworkUri('/api/artists')).toBe(false);
      expect(isArtistArtworkUri('/api/artists/art_123')).toBe(false);
      expect(isArtistArtworkUri('/api/artists/art_123/tracks')).toBe(false);
      expect(isArtistArtworkUri('/api/cover/track-123')).toBe(false);
      expect(isArtistArtworkUri('https://external.com/artwork.jpg')).toBe(false);
    });

    it('returns false for non-string inputs', () => {
      expect(isArtistArtworkUri(null)).toBe(false);
      expect(isArtistArtworkUri(undefined)).toBe(false);
      expect(isArtistArtworkUri(12345)).toBe(false);
      expect(isArtistArtworkUri({})).toBe(false);
    });
  });

  describe('isServerCoverUri', () => {
    it('returns true for relative /api/cover/ endpoints', () => {
      expect(isServerCoverUri('/api/cover/62602a42-a336-5080-bc07-6634c48a3564?v=0')).toBe(true);
    });

    it('returns true for full backend cover URLs regardless of host', () => {
      expect(isServerCoverUri('https://web.puuk.fun/api/cover/62602a42-a336-5080-bc07-6634c48a3564?v=0')).toBe(true);
      expect(isServerCoverUri('http://192.168.1.117:8000/api/cover/62602a42-a336-5080-bc07-6634c48a3564')).toBe(true);
    });

    it('returns true for artist artwork paths as authenticated server resources', () => {
      expect(isServerCoverUri('/api/artists/art_abc123/artwork')).toBe(true);
      expect(isServerCoverUri('/api/artists/art_abc123/artwork?v=3')).toBe(true);
      expect(isServerCoverUri('https://web.puuk.fun/api/artists/art_abc123/artwork?v=3')).toBe(true);
      expect(isServerCoverUri('http://192.168.1.117:8000/api/artists/art_abc123/artwork')).toBe(true);
    });

    it('returns false for external third-party cover URLs', () => {
      expect(isServerCoverUri('https://e-cdns-images.dzcdn.net/images/cover/12345.jpg')).toBe(false);
      expect(isServerCoverUri('https://is1-ssl.mzstatic.com/image/thumb/Music/v4/cover.jpg')).toBe(false);
    });

    it('returns false for non-string inputs', () => {
      expect(isServerCoverUri(null)).toBe(false);
      expect(isServerCoverUri(undefined)).toBe(false);
      expect(isServerCoverUri(12345)).toBe(false);
    });
  });

  describe('resolveCoverUri', () => {
    it('normalizes foreign host to active SERVER_URL', () => {
      const input = 'https://web.puuk.fun/api/cover/62602a42-a336-5080-bc07-6634c48a3564?v=0';
      const resolved = resolveCoverUri(input);
      expect(resolved.startsWith(api.SERVER_URL)).toBe(true);
      expect(resolved).toBe(`${api.SERVER_URL}/api/cover/62602a42-a336-5080-bc07-6634c48a3564?v=0`);
    });

    it('normalizes relative /api/cover/ to active SERVER_URL', () => {
      const input = '/api/cover/test-uuid';
      const resolved = resolveCoverUri(input);
      expect(resolved).toBe(`${api.SERVER_URL}/api/cover/test-uuid`);
    });

    it('removes historical account tokens from cover URLs', () => {
      expect(resolveCoverUri('/api/cover/test?token=old&v=1&token=older', 'account-secret')).toBe(`${api.SERVER_URL}/api/cover/test?v=1`);
    });

    it('only requests a narrowly scoped permission for native artwork', async () => {
      const fetch = jest.spyOn(api, 'authFetch').mockResolvedValue({
        ok: true, json: async () => ({ ticket: 'cover-only' }),
      });
      try {
        const uri = await resolveLockScreenCover('/api/cover/abcd?v=1&token=old');
        expect(fetch).toHaveBeenCalledWith('/api/cover/abcd/ticket', expect.objectContaining({ method: 'POST' }));
        expect(uri).toBe(`${api.SERVER_URL}/api/cover/abcd?v=1&ct=cover-only`);
      } finally { fetch.mockRestore(); }
    });

    it('does not trust hosts that start with the API origin', () => {
      expect(isServerCoverUri(api.SERVER_URL + '.untrusted.test/image')).toBe(false);
    });

    it('does not touch external URLs and does not leak token to them', () => {
      const external = 'https://e-cdns-images.dzcdn.net/images/cover/12345.jpg';
      const resolved = resolveCoverUri(external);
      expect(resolved).toBe(external);
      expect(resolved).not.toContain('secret_token');
    });

    it('normalizes foreign host to active SERVER_URL for artist artwork', () => {
      const foreign = 'https://other-host.org/api/artists/art_123/artwork?v=2';
      const resolved = resolveCoverUri(foreign);
      expect(resolved).toBe(`${api.SERVER_URL}/api/artists/art_123/artwork?v=2`);
    });

    it('never builds a raw token query for artist artwork', () => {
      const resolved = resolveCoverUri('/api/artists/art_123/artwork');
      expect(resolved).toBe(`${api.SERVER_URL}/api/artists/art_123/artwork`);
      expect(resolved).not.toContain('token=');
    });

    it('strips pre-existing token parameter from artist artwork URLs', () => {
      const resolved = resolveCoverUri('/api/artists/art_123/artwork?token=leaked&v=2');
      expect(resolved).toBe(`${api.SERVER_URL}/api/artists/art_123/artwork?v=2`);
      expect(resolved).not.toContain('token=');
    });

    it('preserves media ticket parameter for artist artwork', () => {
      const resolved = resolveCoverUri('/api/artists/art_123/artwork?mt=ticket_xyz&v=1');
      expect(resolved).toBe(`${api.SERVER_URL}/api/artists/art_123/artwork?mt=ticket_xyz&v=1`);
    });

    it('busts cache when version option is provided', () => {
      const resolvedNoVersion = resolveCoverUri('/api/artists/art_123/artwork', 2);
      expect(resolvedNoVersion).toBe(`${api.SERVER_URL}/api/artists/art_123/artwork?v=2`);

      const resolvedUpdateVersion = resolveCoverUri('/api/artists/art_123/artwork?v=1', { artwork_version: 3 });
      expect(resolvedUpdateVersion).toBe(`${api.SERVER_URL}/api/artists/art_123/artwork?v=3`);
    });
  });

  describe('prefetchCover', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('loads protected covers into the native loader with authorization headers', () => {
      jest.spyOn(api, 'getCachedAuthHeaders').mockReturnValue({ Authorization: 'Bearer token_abc' });
      const load = jest.spyOn(Image, 'getSizeWithHeaders').mockResolvedValue({width: 10, height: 10});
      prefetchCover('/api/cover/track-123');
      expect(load).toHaveBeenCalledWith(`${api.SERVER_URL}/api/cover/track-123`, { Authorization: 'Bearer token_abc' });
    });

    it('gracefully ignores empty or invalid inputs', () => {
      const prefetchSpy = jest.spyOn(Image, 'prefetch').mockImplementation(() => Promise.resolve(true));
      prefetchCover('');
      prefetchCover(null);
      prefetchCover(undefined);
      expect(prefetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('CoverImage component', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('renders a neutral placeholder when artwork_url is null', () => {
      let renderer;
      act(() => {
        renderer = TestRenderer.create(
          <CoverImage artwork_url={null} style={{ width: 140, height: 140, borderRadius: 70 }} />
        );
      });

      const placeholder = renderer.root.findByType(NeutralPlaceholder);
      expect(placeholder).toBeTruthy();

      const icon = renderer.root.findByType(Ionicons);
      expect(icon.props.name).toBe('person');
      expect(icon.props.size).toBe(56); // 140 * 0.4
      expect(renderer.root.findAllByType(Image).length).toBe(0);
    });

    it('renders a neutral placeholder when artworkUrl is null', () => {
      let renderer;
      act(() => {
        renderer = TestRenderer.create(
          <CoverImage artworkUrl={null} style={{ width: 56, height: 56, borderRadius: 28 }} />
        );
      });

      const placeholder = renderer.root.findByType(NeutralPlaceholder);
      expect(placeholder).toBeTruthy();

      const icon = renderer.root.findByType(Ionicons);
      expect(icon.props.size).toBe(22); // 56 * 0.4 = 22.4 rounded
    });

    it('renders a neutral placeholder when source is object with artwork_url: null', () => {
      let renderer;
      act(() => {
        renderer = TestRenderer.create(
          <CoverImage source={{ artwork_url: null }} style={{ width: 80, height: 80 }} />
        );
      });

      expect(renderer.root.findByType(NeutralPlaceholder)).toBeTruthy();
    });

    it('renders a neutral placeholder when type is artist and source is null', () => {
      let renderer;
      act(() => {
        renderer = TestRenderer.create(
          <CoverImage source={null} type="artist" style={{ width: 80, height: 80 }} />
        );
      });

      expect(renderer.root.findByType(NeutralPlaceholder)).toBeTruthy();
    });

    it('preserves testID and accessibility props on neutral placeholder', () => {
      let renderer;
      act(() => {
        renderer = TestRenderer.create(
          <CoverImage
            artwork_url={null}
            testID="artist-no-artwork"
            accessibilityRole="image"
            accessibilityLabel="Нет обложки артиста"
          />
        );
      });

      const view = renderer.root.findByType(View);
      expect(view.props.testID).toBe('artist-no-artwork');
      expect(view.props.accessibilityRole).toBe('image');
      expect(view.props.accessibilityLabel).toBe('Нет обложки артиста');
    });

    it('renders Image with Bearer auth headers and resolved URL when artwork_url is present', () => {
      jest.spyOn(api, 'getCachedAuthHeaders').mockReturnValue({ Authorization: 'Bearer test_jwt' });
      jest.spyOn(api, 'getCachedAuthToken').mockReturnValue('test_jwt');

      let renderer;
      act(() => {
        renderer = TestRenderer.create(
          <CoverImage artwork_url="/api/artists/art_123/artwork?v=1" style={{ width: 100, height: 100 }} />
        );
      });

      const image = renderer.root.findByType(Image);
      expect(image.props.source).toEqual({
        uri: `${api.SERVER_URL}/api/artists/art_123/artwork?v=1`,
        headers: { Authorization: 'Bearer test_jwt' },
      });
      expect(image.props.source.uri).not.toContain('token=');
    });

    it('busts cache when artwork_version changes', () => {
      jest.spyOn(api, 'getCachedAuthHeaders').mockReturnValue({ Authorization: 'Bearer test_jwt' });

      let renderer;
      act(() => {
        renderer = TestRenderer.create(
          <CoverImage
            artwork_url="/api/artists/art_123/artwork"
            artwork_version={1}
            style={{ width: 100, height: 100 }}
          />
        );
      });

      let image = renderer.root.findByType(Image);
      expect(image.props.source.uri).toBe(`${api.SERVER_URL}/api/artists/art_123/artwork?v=1`);

      act(() => {
        renderer.update(
          <CoverImage
            artwork_url="/api/artists/art_123/artwork"
            artwork_version={2}
            style={{ width: 100, height: 100 }}
          />
        );
      });

      image = renderer.root.findByType(Image);
      expect(image.props.source.uri).toBe(`${api.SERVER_URL}/api/artists/art_123/artwork?v=2`);
    });

    it('falls back to neutral placeholder on error for artist artwork (never track cover)', () => {
      jest.spyOn(api, 'getCachedAuthHeaders').mockReturnValue({ Authorization: 'Bearer test_jwt' });

      let renderer;
      act(() => {
        renderer = TestRenderer.create(
          <CoverImage artwork_url="/api/artists/art_123/artwork?v=1" style={{ width: 100, height: 100 }} />
        );
      });

      const image = renderer.root.findByType(Image);
      act(() => {
        image.props.onError({ nativeEvent: { error: '404' } });
      });

      expect(renderer.root.findByType(NeutralPlaceholder)).toBeTruthy();
      expect(renderer.root.findAllByType(Image).length).toBe(0);
    });

    it('does not regress existing cover behavior when non-artist source is null', () => {
      let renderer;
      act(() => {
        renderer = TestRenderer.create(
          <CoverImage source={null} style={{ width: 50, height: 50 }} />
        );
      });

      const image = renderer.root.findByType(Image);
      expect(image.props.source).toBe(DEFAULT_COVER);
      expect(renderer.root.findAllByType(NeutralPlaceholder).length).toBe(0);
    });

    it('sends track cover credentials only in the header', () => {
      jest.spyOn(api, 'getCachedAuthHeaders').mockReturnValue({ Authorization: 'Bearer token_123' });
      jest.spyOn(api, 'getCachedAuthToken').mockReturnValue('token_123');

      let renderer;
      act(() => {
        renderer = TestRenderer.create(
          <CoverImage source="/api/cover/track-456" style={{ width: 50, height: 50 }} />
        );
      });

      const image = renderer.root.findByType(Image);
      expect(image.props.source.uri).toBe(`${api.SERVER_URL}/api/cover/track-456?size=128`);
      expect(image.props.source.headers).toEqual({ Authorization: 'Bearer token_123' });
    });
  });
});
