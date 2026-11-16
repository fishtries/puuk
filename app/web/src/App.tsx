import React, { useEffect, useState, useRef } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { HomeScreen } from './components/home/HomeScreen';
import { FloatingPlayerDock } from './components/player/FloatingPlayerDock';
import { CompactTrackInfoIsland } from './components/player/TrackInfoIslands';
import { AmbientBackground } from './components/player/AmbientBackground';
import { ApplePlayerDeck } from './components/player/ApplePlayerDeck';
import { AppleLyricsStream } from './components/lyrics/AppleLyricsStream';
import { LibraryDrawer } from './components/catalog/LibraryDrawer';
import { LoginModal } from './components/auth/LoginModal';
import { DebugOverlay } from './components/debug/DebugOverlay';
import { TagEditorModal } from './components/tags/TagEditorModal';
import { AlbumEditorModal } from './components/albums/AlbumEditorModal';
import { AddToPlaylistModal } from './components/playlists/AddToPlaylistModal';
import { RightPanel } from './components/layout/RightPanel';

import { useAuthStore } from './store/useAuthStore';
import { usePlayerStore } from './store/usePlayerStore';
import { hasLyricsContent } from './store/playerStoreHelpers';
import { useHotkeys } from './hooks/useHotkeys';
import { useMediaSession } from './hooks/useMediaSession';
import { Track } from './types/track';

import styles from './App.module.css';
import { queryClient } from './api/queryClient';
import { useShareNavigationStore, readPendingDestination } from './store/useShareNavigationStore';
import { useTagEditorStore } from './store/useTagEditorStore';
import { useAlbumEditorStore } from './store/useAlbumEditorStore';
import { useAlbumNavigationStore } from './store/useAlbumNavigationStore';
import { SHARE_LINKS_ENABLED, parseShareTarget } from './utils/shareLinks';
import { TrackDetail } from './views/TrackDetail';
import { ArtistDetail } from './views/ArtistDetail';
import { AlbumDetail } from './views/AlbumDetail';
import type { Album } from './types/track';
import type { ArtistSummaryDTO } from './api/share';
import shareStyles from './views/ShareDetail.module.css';
import { setUnauthorizedHandler, onApiSessionChange } from './api/client';

function AppContent() {
  const [viewMode, setViewMode] = useState<'home' | 'lyrics'>('home');
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [trackForPlaylist, setTrackForPlaylist] = useState<Track | null>(null);

  const share = useShareNavigationStore();
  const token = useAuthStore(state => state.token);
  const sessionError = useAuthStore(state => state.error);
  const focusBeforeShare = useRef<HTMLElement | null>(null);
  const wasShare = useRef(false);
  const shareStage = useRef<HTMLElement>(null);

  const checkAuth = useAuthStore((state) => state.checkAuth);
  const setIsLoginOpen = usePlayerStore((state) => state.setIsLoginOpen);
  const user = useAuthStore((state) => state.user);
  const isAuthChecked = useAuthStore((state) => state.isAuthChecked);

  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const lyrics = usePlayerStore((state) => state.lyrics);
  const rawLyricsText = usePlayerStore((state) => state.rawLyricsText);
  const isLyricsLoading = usePlayerStore((state) => state.isLyricsLoading);

  useEffect(() => {
    if (viewMode === 'lyrics') {
      const hasLyrics = hasLyricsContent(currentTrack, lyrics, rawLyricsText) || Boolean(currentTrack?.has_lyrics || isLyricsLoading);
      if (!hasLyrics) {
        setViewMode('home');
      }
    }
  }, [viewMode, currentTrack, lyrics, rawLyricsText, isLyricsLoading]);

  useHotkeys(undefined, () => setIsLibraryOpen(true));
  useMediaSession();

  useEffect(() => {
    if (!SHARE_LINKS_ENABLED) return;
    useShareNavigationStore.getState().initFromLocation();
    const pop = () => useShareNavigationStore.getState().handlePopState();
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  useEffect(() => {
    if (!SHARE_LINKS_ENABLED || !isAuthChecked || !user || !token) return;
    const state = useShareNavigationStore.getState();
    if (!state.currentTarget && state.pendingDestination) {
      const pending = readPendingDestination();
      if (!pending) { state.clearPendingDestination(); return; }
      state.navigateToTarget({ type: pending.type, id: pending.id }, { replace: true });
    } else if (state.currentTarget && !state.resolvedEntity && !state.error) {
      void state.resolveCurrentTarget();
    }
  }, [user, token, isAuthChecked, share.generation]);

  useEffect(() => useShareNavigationStore.subscribe((state, previous) => {
    if (state.currentTarget !== previous.currentTarget && state.currentTarget) {
      if (!previous.currentTarget) focusBeforeShare.current = document.activeElement as HTMLElement;
      setViewMode('home');
    }
  }), []);

  useEffect(() => {
    if (share.currentTarget && !wasShare.current) {
      focusBeforeShare.current ??= document.activeElement as HTMLElement;
    } else if (!share.currentTarget && wasShare.current) {
      if (focusBeforeShare.current?.isConnected) focusBeforeShare.current.focus();
      focusBeforeShare.current = null;
    }
    wasShare.current = Boolean(share.currentTarget);
  }, [share.currentTarget]);

  useEffect(() => {
    if (share.resolvedEntity?.type === 'album' || share.error) {
      const heading = shareStage.current?.querySelector<HTMLElement>('h1, h2');
      if (heading) { heading.tabIndex = -1; heading.focus(); }
    }
  }, [share.resolvedEntity, share.error]);

  useEffect(() => onApiSessionChange(() => {
    setTrackForPlaylist(null);
    setIsLibraryOpen(false);
    useTagEditorStore.getState().closeTagEditor();
    useAlbumEditorStore.getState().closeAlbumEditor();
    useAlbumNavigationStore.setState({ pendingAlbum: null });
  }), []);
  useEffect(() => { void checkAuth(); }, [checkAuth]);

  useEffect(() => {
    setUnauthorizedHandler(() => useAuthStore.getState().logout());
    return () => setUnauthorizedHandler(null);
  }, []);

  if (!isAuthChecked) {
    return (
      <div className={styles.authGate}>
        <div className={styles.authGateSpinner} aria-label="Проверка сессии" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className={styles.authGate}>
        {token && sessionError ? <div role="alert"><p>Не удалось проверить сессию</p><button type="button" onClick={() => void checkAuth()}>Повторить</button></div> :
          <LoginModal mandatory onCancelDestination={SHARE_LINKS_ENABLED && share.currentTarget ? () => { useAuthStore.getState().logout(); share.cancelNavigation(); } : undefined} />}

      </div>
    );
  }

  return (
    <div className={styles.appShell}>
      {viewMode === 'home' ? (
        /* Sketch-based Home View with Glassmorphism Islands */
        <div className={styles.homeContainer}>
          <div hidden={Boolean(share.currentTarget) || Boolean(window.location.pathname !== '/' && !share.currentTarget)}>
          <HomeScreen
            onOpenAuth={() => setIsLoginOpen(true)}
            onAddToPlaylist={setTrackForPlaylist}
          />
          </div>
          {(share.currentTarget || window.location.pathname !== '/') && <main ref={shareStage} className={shareStyles.stage} aria-label="По ссылке">
            <button type="button" className={`${shareStyles.button} ${shareStyles.back}`} onClick={share.cancelNavigation}><ArrowLeft size={16} />Главная</button>
            {!share.currentTarget ? <p role="status">{!SHARE_LINKS_ENABLED && parseShareTarget(`${window.location.pathname}${window.location.search}${window.location.hash}`) ? 'Ссылки пока недоступны' : 'Некорректная ссылка'}</p> : share.isResolving ? <p role="status">Загрузка…</p> : share.error ? <div role="alert">
              <h1 className={shareStyles.title}>{share.error.message}</h1>
              {share.error.kind === 'retryable' && <button type="button" className={shareStyles.button} onClick={() => void share.resolveCurrentTarget()}>Повторить</button>}
            </div> : share.resolvedEntity ? <>
              {share.resolvedEntity.type === 'track' && <TrackDetail track={share.resolvedEntity.entity as Track} />}
              {share.resolvedEntity.type === 'album' && <AlbumDetail album={share.resolvedEntity.entity as Album} resolved={{ album: share.resolvedEntity.entity as Album, tracks: share.resolvedEntity.tracks }} />}
              {share.resolvedEntity.type === 'artist' && <ArtistDetail artist={share.resolvedEntity.entity as ArtistSummaryDTO} tracks={share.resolvedEntity.tracks} albums={share.resolvedEntity.albums} />}
            </> : null}
          </main>}

          <FloatingPlayerDock
            onOpenLyrics={() => setViewMode('lyrics')}
            isLyricsActive={false}
            onAddToPlaylist={setTrackForPlaylist}
          />
          <CompactTrackInfoIsland />
          <RightPanel />
        </div>
      ) : (
        /* Apple Music Fullscreen Lyrics Stage */
        <>
          <AmbientBackground />

          <button
            type="button"
            className={styles.backToHomeBtn}
            onClick={() => setViewMode('home')}
            title="Вернуться на главный экран"
          >
            <ArrowLeft size={16} />
            <span>Главная</span>
          </button>

          <main className={styles.mainStage} aria-label="Apple Music Player Stage">
            <ApplePlayerDeck onAddToPlaylist={setTrackForPlaylist} />
            <AppleLyricsStream />
          </main>
        </>
      )}

      {/* Slide-out Library / Catalog Drawer */}
      <LibraryDrawer
        isOpen={isLibraryOpen}
        onClose={() => setIsLibraryOpen(false)}
      />

      {/* Auth, Diagnostics & Tag Editor Modals */}
      <LoginModal />
      <DebugOverlay />
      <TagEditorModal />
      <AlbumEditorModal />

      {/* Single instance: add-to-playlist dialog (opened from any track row) */}
      <AddToPlaylistModal track={trackForPlaylist} onClose={() => setTrackForPlaylist(null)} />

      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}

export default App;
