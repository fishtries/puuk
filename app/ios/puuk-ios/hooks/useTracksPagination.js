import { useState, useEffect, useRef, useCallback } from 'react';
import { SERVER_URL } from '../utils/api';
import {
  fetchTracksPage,
  mergeTracks,
  TRACKS_PAGE_SIZE,
} from '../utils/apiCache';

/**
 * Хук для пагинированной загрузки каталога треков со Stale-While-Revalidate кэшированием страниц.
 *
 * @param {object} params
 * @param {object|null} params.currentUser Текущий авторизованный пользователь
 * @param {object|null} params.currentTrack Текущий играющий трек
 * @param {function} [params.setCurrentTrack] Сеттер текущего трека
 * @param {string} [params.serverUrl] URL сервера
 */
export default function useTracksPagination({
  currentUser,
  currentTrack,
  setCurrentTrack,
  serverUrl = SERVER_URL,
} = {}) {
  const [tracks, setTracks] = useState([]);
  const [hasMoreTracks, setHasMoreTracks] = useState(true);
  const [isLoadingMoreTracks, setIsLoadingMoreTracks] = useState(false);

  const tracksOffsetRef = useRef(0);
  const isLoadingMoreRef = useRef(false);
  const userGenerationRef = useRef(0);
  const tracksAbortRef = useRef(null);
  const loadMoreAbortRef = useRef(null);

  const currentTrackRef = useRef(currentTrack);
  useEffect(() => {
    currentTrackRef.current = currentTrack;
  }, [currentTrack]);

  // Начальная загрузка первой страницы (offset = 0) с использованием SWR
  useEffect(() => {
    if (!currentUser) {
      setTracks([]);
      setHasMoreTracks(true);
      setIsLoadingMoreTracks(false);
      tracksOffsetRef.current = 0;
      isLoadingMoreRef.current = false;
      if (tracksAbortRef.current) {
        tracksAbortRef.current.abort();
        tracksAbortRef.current = null;
      }
      if (loadMoreAbortRef.current) {
        loadMoreAbortRef.current.abort();
        loadMoreAbortRef.current = null;
      }
      return;
    }

    userGenerationRef.current += 1;
    const currentGeneration = userGenerationRef.current;

    if (tracksAbortRef.current) {
      tracksAbortRef.current.abort();
    }
    if (loadMoreAbortRef.current) {
      loadMoreAbortRef.current.abort();
      loadMoreAbortRef.current = null;
    }
    const controller = new AbortController();
    tracksAbortRef.current = controller;

    // Мгновенно очищаем треки предыдущего пользователя при переключении namespace
    setTracks([]);
    setHasMoreTracks(true);
    setIsLoadingMoreTracks(false);
    tracksOffsetRef.current = 0;
    isLoadingMoreRef.current = false;

    const fetchInitialPage = async () => {
      try {
        await fetchTracksPage(0, TRACKS_PAGE_SIZE, {
          userId: currentUser.id,
          serverUrl,
          signal: controller.signal,
          onData: (pageData) => {
            if (controller.signal.aborted || userGenerationRef.current !== currentGeneration) {
              return;
            }
            const items = pageData?.items || (Array.isArray(pageData) ? pageData : []);
            setTracks(items);
            tracksOffsetRef.current = items.length;
            const hasMore = pageData?.hasMore ?? (items.length === TRACKS_PAGE_SIZE);
            setHasMoreTracks(hasMore);

            // Не выбираем первый трек повторно, если currentTrack уже восстановлен из хранилища
            if (items.length > 0 && !currentTrackRef.current && typeof setCurrentTrack === 'function') {
              setCurrentTrack(items[0]);
            }
          },
        });
      } catch (err) {
        if (err?.name !== 'AbortError' && !err?.message?.includes('AbortError')) {
          console.warn('[useTracksPagination] Fetch initial page error:', err?.message || err);
        }
      }
    };

    fetchInitialPage();

    return () => {
      controller.abort();
      if (loadMoreAbortRef.current) {
        loadMoreAbortRef.current.abort();
        loadMoreAbortRef.current = null;
      }
    };
  }, [currentUser?.id, serverUrl]);

  // Загрузка следующей страницы треков
  const loadMoreTracks = useCallback(async () => {
    // 1. Выйти, если нет пользователя
    if (!currentUser) return;

    // 2. Выйти, если больше нет треков
    if (!hasMoreTracks) return;

    // 3. Синхронная блокировка через ref против параллельных вызовов до рендера React
    if (isLoadingMoreRef.current) return;

    isLoadingMoreRef.current = true;
    setIsLoadingMoreTracks(true);

    const currentGeneration = userGenerationRef.current;
    const currentOffset = tracksOffsetRef.current;

    if (loadMoreAbortRef.current) {
      loadMoreAbortRef.current.abort();
    }
    const loadMoreController = new AbortController();
    loadMoreAbortRef.current = loadMoreController;

    try {
      const pageResult = await fetchTracksPage(currentOffset, TRACKS_PAGE_SIZE, {
        userId: currentUser.id,
        serverUrl,
        signal: loadMoreController.signal,
        onData: (pageData) => {
          if (loadMoreController.signal.aborted || userGenerationRef.current !== currentGeneration) return;

          const incomingItems = pageData?.items || (Array.isArray(pageData) ? pageData : []);
          if (incomingItems.length === 0) {
            setHasMoreTracks(false);
            return;
          }

          setTracks((prevTracks) => mergeTracks(prevTracks, incomingItems));
          tracksOffsetRef.current = currentOffset + incomingItems.length;
          const hasMore = pageData?.hasMore ?? (incomingItems.length === TRACKS_PAGE_SIZE);
          setHasMoreTracks(hasMore);
        },
      });

      if (userGenerationRef.current === currentGeneration && !loadMoreController.signal.aborted) {
        const finalData = pageResult?.data;
        const incomingItems = finalData?.items || (Array.isArray(finalData) ? finalData : []);
        const hasMore = finalData?.hasMore ?? (incomingItems.length === TRACKS_PAGE_SIZE);
        setHasMoreTracks(hasMore);
      }
    } catch (err) {
      if (err?.name !== 'AbortError' && !err?.message?.includes('AbortError')) {
        console.warn('[useTracksPagination] Load more error:', err?.message || err);
      }
    } finally {
      if (loadMoreAbortRef.current === loadMoreController) {
        loadMoreAbortRef.current = null;
      }
      if (userGenerationRef.current === currentGeneration) {
        isLoadingMoreRef.current = false;
        setIsLoadingMoreTracks(false);
      }
    }
  }, [currentUser, hasMoreTracks, serverUrl]);

  // Принудительное обновление каталога с первой страницы (например, pull-to-refresh)
  const refreshTracks = useCallback(async () => {
    if (!currentUser) return;

    userGenerationRef.current += 1;
    const currentGeneration = userGenerationRef.current;

    if (tracksAbortRef.current) {
      tracksAbortRef.current.abort();
    }
    if (loadMoreAbortRef.current) {
      loadMoreAbortRef.current.abort();
      loadMoreAbortRef.current = null;
    }
    const controller = new AbortController();
    tracksAbortRef.current = controller;

    tracksOffsetRef.current = 0;
    isLoadingMoreRef.current = false;
    setIsLoadingMoreTracks(false);
    setHasMoreTracks(true);

    try {
      await fetchTracksPage(0, TRACKS_PAGE_SIZE, {
        userId: currentUser.id,
        serverUrl,
        forceRefresh: true,
        signal: controller.signal,
        onData: (pageData) => {
          if (controller.signal.aborted || userGenerationRef.current !== currentGeneration) {
            return;
          }
          const items = pageData?.items || (Array.isArray(pageData) ? pageData : []);
          setTracks(items);
          tracksOffsetRef.current = items.length;
          const hasMore = pageData?.hasMore ?? (items.length === TRACKS_PAGE_SIZE);
          setHasMoreTracks(hasMore);
        },
      });
    } catch (err) {
      if (err?.name !== 'AbortError' && !err?.message?.includes('AbortError')) {
        console.warn('[useTracksPagination] Refresh tracks error:', err?.message || err);
      }
    }
  }, [currentUser, serverUrl]);

  return {
    tracks,
    setTracks,
    hasMoreTracks,
    isLoadingMoreTracks,
    loadMoreTracks,
    refreshTracks,
  };
}
