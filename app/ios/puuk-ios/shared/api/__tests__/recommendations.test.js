import { fetchPersonalizedRecommendations } from '../recommendations';
import { authFetch } from '../api';

jest.mock('../api', () => ({
  SERVER_URL: 'https://puuk.app',
  authFetch: jest.fn(),
}));

describe('fetchPersonalizedRecommendations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('fetches without params using default endpoint', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sections: [] }),
    });

    const result = await fetchPersonalizedRecommendations();
    expect(authFetch).toHaveBeenCalledWith('/api/recommendations/youll-like-this', { signal: undefined });
    expect(result).toEqual({ sections: [] });
  });

  test('passes query parameters when options are provided', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sections: [] }),
    });

    await fetchPersonalizedRecommendations({ limit: 15, sections: 2 });
    expect(authFetch).toHaveBeenCalledWith(
      '/api/recommendations/youll-like-this?limit=15&sections=2',
      { signal: undefined },
    );
  });

  test('normalizes raw track payloads in sections', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        sections: [
          {
            id: 'genre-rock',
            type: 'genre',
            title: 'Rock for you',
            genre: 'Rock',
            description: 'Rock mix',
            tracks: [
              {
                track_id: 'tr-1',
                title: 'Stairway',
                artist: 'Led Zep',
              },
            ],
          },
        ],
      }),
    });

    const result = await fetchPersonalizedRecommendations();
    expect(result.sections).toHaveLength(1);
    const sec = result.sections[0];
    expect(sec.id).toBe('genre-rock');
    expect(sec.genre).toBe('Rock');
    expect(sec.tracks).toHaveLength(1);
    expect(sec.tracks[0].id).toBe('tr-1');
    expect(sec.tracks[0].title).toBe('Stairway');
    expect(sec.tracks[0].coverArt).toBe('https://puuk.app/api/cover/tr-1');
  });

  test('throws error when response is not ok', async () => {
    authFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    await expect(fetchPersonalizedRecommendations()).rejects.toThrow('HTTP 500');
  });
});
