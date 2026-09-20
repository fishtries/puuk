import { useEffect } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { getCoverUrl } from '../api/tracks';

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

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist,
      album: currentTrack.album || 'puuk',
      artwork: coverUrl
        ? [
            { src: coverUrl, sizes: '512x512', type: 'image/jpeg' },
          ]
        : [],
    });

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
