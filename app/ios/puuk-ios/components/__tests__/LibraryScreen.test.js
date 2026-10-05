import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DeviceEventEmitter, RefreshControl, ActivityIndicator } from 'react-native';
import LibraryScreen from '../LibraryScreen';
import { fetchCatalogWithCache, setCachedCatalog } from '../../utils/apiCache';
import { authFetch } from '../../utils/api';

jest.mock('../../utils/api', () => ({
  SERVER_URL: 'https://puuk.app',
  authFetch: jest.fn(),
}));

jest.mock('../../utils/apiCache', () => ({
  fetchCatalogWithCache: jest.fn(),
  setCachedCatalog: jest.fn().mockResolvedValue({}),
  DEFAULT_TTL_MS: {
    favorites: 30000,
    playlists: 60000,
    history: 30000,
  },
}));

jest.mock('../../utils/settings', () => ({
  getSettings: jest.fn(() => ({ accentColor: '#FFDAB9' })),
  addSettingsListener: jest.fn(() => () => {}),
}));

jest.mock('../CoverImage', () => 'CoverImage');

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (Comp) => Comp,
      View,
    },
    FadeInDown: {
      delay: () => ({ duration: () => ({}) }),
    },
    FadeInRight: {
      delay: () => ({ duration: () => ({}) }),
    },
    LinearTransition: {
      springify: () => ({}),
    },
  };
});

describe('LibraryScreen', () => {
  const mockNavigation = {
    navigate: jest.fn(),
  };

  const sampleFavorites = [
    { id: 'fav-1', title: 'Favorite Song 1', artist: 'Artist 1', coverArt: 'https://puuk.app/api/cover/fav-1' },
  ];

  const samplePlaylists = [
    { id: 'pl-1', name: 'Chill Vibes', track_count: 5, coverArt: 'https://puuk.app/api/cover/pl-1' },
  ];

  const sampleHistory = [
    { id: 'hist-1', title: 'Recent Song 1', artist: 'Artist 2', played_at: new Date().toISOString() },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('показывает кэшированные данные мгновенно (SWR) без зависания на индикаторе загрузки', async () => {
    fetchCatalogWithCache.mockImplementation(async (endpoint, options) => {
      if (endpoint === '/api/favorites' && options?.onData) {
        options.onData(sampleFavorites);
      }
      if (endpoint === '/api/playlists' && options?.onData) {
        options.onData(samplePlaylists);
      }
      if (endpoint === '/api/history' && options?.onData) {
        options.onData(sampleHistory);
      }
      return { data: [], fromCache: true, isStale: false };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LibraryScreen
          navigation={mockNavigation}
          currentUser={{ id: 1, name: 'Alice' }}
        />
      );
    });

    // Индикатор загрузки не должен отображаться, так как кэшированные данные уже доступны
    const indicators = renderer.root.findAllByType(ActivityIndicator);
    expect(indicators).toHaveLength(0);

    // Проверяем наличие текста из кэша
    const playlistNodes = renderer.root.findAll((node) => node.props.children === 'Chill Vibes');
    expect(playlistNodes.length).toBeGreaterThan(0);

    const historyNodes = renderer.root.findAll((node) => node.props.children === 'Recent Song 1');
    expect(historyNodes.length).toBeGreaterThan(0);
  });

  it('обновляет состояние при поступлении свежих данных по сети', async () => {
    let historyCallback;
    fetchCatalogWithCache.mockImplementation(async (endpoint, options) => {
      if (endpoint === '/api/history') {
        historyCallback = options.onData;
        options.onData([{ id: 'hist-initial', title: 'Cached Song', artist: 'Artist' }]);
      }
      return { data: [], fromCache: true, isStale: true };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LibraryScreen
          navigation={mockNavigation}
          currentUser={{ id: 1 }}
        />
      );
    });

    expect(renderer.root.findAll((n) => n.props.children === 'Cached Song').length).toBeGreaterThan(0);

    // Приходят свежие данные по сети
    await act(async () => {
      if (historyCallback) {
        historyCallback([{ id: 'hist-fresh', title: 'Network Fresh Song', artist: 'Artist' }]);
      }
    });

    expect(renderer.root.findAll((n) => n.props.children === 'Cached Song').length).toBe(0);
    expect(renderer.root.findAll((n) => n.props.children === 'Network Fresh Song').length).toBeGreaterThan(0);
  });

  it('частичный сбой одного ресурса (/api/history) не ломает отображение остальных (Promise.allSettled)', async () => {
    fetchCatalogWithCache.mockImplementation(async (endpoint, options) => {
      if (endpoint === '/api/favorites') {
        if (options?.onData) options.onData(sampleFavorites);
        return { data: sampleFavorites };
      }
      if (endpoint === '/api/playlists') {
        if (options?.onData) options.onData(samplePlaylists);
        return { data: samplePlaylists };
      }
      if (endpoint === '/api/history') {
        throw new Error('500 Internal Server Error in history');
      }
      return { data: [] };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LibraryScreen
          navigation={mockNavigation}
          currentUser={{ id: 1 }}
        />
      );
    });

    // Экран не должен зависнуть на ActivityIndicator
    const indicators = renderer.root.findAllByType(ActivityIndicator);
    expect(indicators).toHaveLength(0);

    // Плейлисты и избранное должны успешно отрендериться
    expect(renderer.root.findAll((n) => n.props.children === 'Chill Vibes').length).toBeGreaterThan(0);
    expect(renderer.root.findAll((n) => n.props.children === 'Favorites').length).toBeGreaterThan(0);
  });

  it('pull-to-refresh передаёт forceRefresh=true во все 3 вызова fetchCatalogWithCache', async () => {
    fetchCatalogWithCache.mockImplementation(async (endpoint, options) => {
      if (options?.onData) options.onData([]);
      return { data: [] };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LibraryScreen
          navigation={mockNavigation}
          currentUser={{ id: 1 }}
        />
      );
    });

    fetchCatalogWithCache.mockClear();

    // Находим RefreshControl и вызываем onRefresh
    const refreshControl = renderer.root.findByType(RefreshControl);
    expect(refreshControl).toBeDefined();

    await act(async () => {
      refreshControl.props.onRefresh();
    });

    expect(fetchCatalogWithCache).toHaveBeenCalledTimes(3);
    expect(fetchCatalogWithCache).toHaveBeenCalledWith(
      '/api/favorites',
      expect.objectContaining({ forceRefresh: true, userId: 1 })
    );
    expect(fetchCatalogWithCache).toHaveBeenCalledWith(
      '/api/playlists',
      expect.objectContaining({ forceRefresh: true, userId: 1 })
    );
    expect(fetchCatalogWithCache).toHaveBeenCalledWith(
      '/api/history',
      expect.objectContaining({ forceRefresh: true, userId: 1 })
    );
  });

  it('при смене пользователя активные запросы отменяются и списки очищаются', async () => {
    let capturedUser1Signal;
    fetchCatalogWithCache.mockImplementation(async (endpoint, options) => {
      if (options.userId === 1) {
        capturedUser1Signal = options.signal;
        return new Promise(() => {}); // in flight
      }
      if (options.userId === 2) {
        if (endpoint === '/api/playlists' && options?.onData) {
          options.onData([{ id: 'pl-user2', name: 'User 2 Playlist' }]);
        }
        return { data: [] };
      }
      return { data: [] };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LibraryScreen
          navigation={mockNavigation}
          currentUser={{ id: 1 }}
        />
      );
    });

    expect(capturedUser1Signal).toBeDefined();
    expect(capturedUser1Signal.aborted).toBe(false);

    // Смена пользователя на User 2
    await act(async () => {
      renderer.update(
        <LibraryScreen
          navigation={mockNavigation}
          currentUser={{ id: 2 }}
        />
      );
    });

    // Запрос User 1 должен быть отменен
    expect(capturedUser1Signal.aborted).toBe(true);

    // В интерфейсе должны быть данные User 2
    expect(renderer.root.findAll((n) => n.props.children === 'User 2 Playlist').length).toBeGreaterThan(0);
  });

  it('при logout (currentUser=null) списки очищаются и запросы не выполняются', async () => {
    fetchCatalogWithCache.mockImplementation(async (endpoint, options) => {
      if (options?.onData) options.onData(samplePlaylists);
      return { data: samplePlaylists };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LibraryScreen
          navigation={mockNavigation}
          currentUser={{ id: 1 }}
        />
      );
    });

    expect(renderer.root.findAll((n) => n.props.children === 'Chill Vibes').length).toBeGreaterThan(0);

    fetchCatalogWithCache.mockClear();

    // Logout
    await act(async () => {
      renderer.update(
        <LibraryScreen
          navigation={mockNavigation}
          currentUser={null}
        />
      );
    });

    expect(renderer.root.findAll((n) => n.props.children === 'Chill Vibes').length).toBe(0);
    expect(fetchCatalogWithCache).not.toHaveBeenCalled();
  });

  it('переключение лайка удаляет трек из favorites и сохраняет в setCachedCatalog', async () => {
    authFetch.mockResolvedValue({ ok: true });
    fetchCatalogWithCache.mockImplementation(async (endpoint, options) => {
      if (endpoint === '/api/favorites' && options?.onData) {
        options.onData(sampleFavorites);
      }
      if (endpoint === '/api/history' && options?.onData) {
        options.onData(sampleHistory);
      }
      return { data: [] };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LibraryScreen
          navigation={mockNavigation}
          currentUser={{ id: 1 }}
        />
      );
    });

    expect(renderer.root.findAll((n) => n.props.children === 'Recent Song 1').length).toBeGreaterThan(0);

    // Находим кнопку лайка
    const likeButtons = renderer.root.findAll(
      (node) => node.props.style && node.props.style.padding === 6 && typeof node.props.onPress === 'function'
    );
    expect(likeButtons.length).toBeGreaterThan(0);

    // Нажимаем like на треке
    await act(async () => {
      await likeButtons[0].props.onPress();
    });

    expect(setCachedCatalog).toHaveBeenCalledWith(
      'favorites',
      expect.any(Array),
      expect.objectContaining({ userId: 1 })
    );
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/tracks/'),
      expect.objectContaining({ method: expect.stringMatching(/POST|DELETE/) })
    );
  });

  it('событие PUUK_TRACK_DELETED удаляет трек из списков и обновляет кэш', async () => {
    fetchCatalogWithCache.mockImplementation(async (endpoint, options) => {
      if (endpoint === '/api/favorites' && options?.onData) {
        options.onData(sampleFavorites);
      }
      if (endpoint === '/api/history' && options?.onData) {
        options.onData(sampleHistory);
      }
      return { data: [] };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LibraryScreen
          navigation={mockNavigation}
          currentUser={{ id: 1 }}
        />
      );
    });

    expect(renderer.root.findAll((n) => n.props.children === 'Recent Song 1').length).toBeGreaterThan(0);

    // Генерируем событие удаления трека
    await act(async () => {
      DeviceEventEmitter.emit('PUUK_TRACK_DELETED', { id: 'hist-1' });
    });

    expect(renderer.root.findAll((n) => n.props.children === 'Recent Song 1').length).toBe(0);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'history',
      [],
      expect.objectContaining({ userId: 1 })
    );
  });

  it('событие PUUK_TRACK_UPDATED обновляет метаданные трека в списках и кэше', async () => {
    fetchCatalogWithCache.mockImplementation(async (endpoint, options) => {
      if (endpoint === '/api/history' && options?.onData) {
        options.onData(sampleHistory);
      }
      return { data: [] };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LibraryScreen
          navigation={mockNavigation}
          currentUser={{ id: 1 }}
        />
      );
    });

    expect(renderer.root.findAll((n) => n.props.children === 'Recent Song 1').length).toBeGreaterThan(0);

    // Генерируем событие обновления трека
    await act(async () => {
      DeviceEventEmitter.emit('PUUK_TRACK_UPDATED', { id: 'hist-1', title: 'Renamed Song' });
    });

    expect(renderer.root.findAll((n) => n.props.children === 'Renamed Song').length).toBeGreaterThan(0);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'history',
      expect.arrayContaining([expect.objectContaining({ id: 'hist-1', title: 'Renamed Song' })]),
      expect.objectContaining({ userId: 1 })
    );
  });
});
