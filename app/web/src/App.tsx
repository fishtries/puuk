import React, { useEffect, useState } from 'react';
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
import { useHotkeys } from './hooks/useHotkeys';
import { useMediaSession } from './hooks/useMediaSession';
import { Track } from './types/track';

import styles from './App.module.css';
import { queryClient } from './api/queryClient';

function AppContent() {
  const [viewMode, setViewMode] = useState<'home' | 'lyrics'>('home');
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [trackForPlaylist, setTrackForPlaylist] = useState<Track | null>(null);

  const checkAuth = useAuthStore((state) => state.checkAuth);
  const setIsLoginOpen = usePlayerStore((state) => state.setIsLoginOpen);

  useHotkeys(undefined, () => setIsLibraryOpen(true));
  useMediaSession();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <div className={styles.appShell}>
      {viewMode === 'home' ? (
        /* Sketch-based Home View with Glassmorphism Islands */
        <div className={styles.homeContainer}>
          <HomeScreen
            onOpenAuth={() => setIsLoginOpen(true)}
            onAddToPlaylist={setTrackForPlaylist}
          />

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
