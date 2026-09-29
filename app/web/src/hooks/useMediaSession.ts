import { useEffect } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { getCoverUrl } from '../api/tracks';
import { fetchAuthorizedBlobUrl } from '../api/media';

export function useMediaSession() {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const togglePlay = usePlayerStore((state) => state.togglePlay);
  const nextTrack = usePlayerStore((state) => state.nextTrack);
  const previousTrack = usePlayerStore((state) => state.previousTrack);
  const seek = usePlayerStore((state) => state.seek);

  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentTrack) return;

    const coverUrl = getCoverUrl(currentTrack.cover_id);
    let artworkCancelled = false;

    const setArtwork = (artwork: MediaImage[]) => {
      if (artworkCancelled) return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album || 'puuk',
        artwork,
      });
    };

    if (coverUrl) {
      fetchAuthorizedBlobUrl(coverUrl)
        .then((blobUrl) => setArtwork([{ src: blobUrl, sizes: '512x512', type: 'image/jpeg' }]))
        .catch(() => setArtwork([]));
    } else {
      setArtwork([]);
    }

    navigator.mediaSession.playbackState = status === 'playing' ? 'playing' : 'paused';

    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => togglePlay());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
    navigator.mediaSession.setActionHandler('previoustrack', () => previousTrack());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) {
        seek(details.seekTime);
      }
    });

    return () => {
      artworkCancelled = true;
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('seekto', null);
      }
    };
  }, [currentTrack, status, togglePlay, nextTrack, previousTrack, seek]);
}
