import { usePlayerStore } from '../store/usePlayerStore';
import { findActiveLyricIndex } from '../engine/lrcParser';

export function useLyrics() {
  const lyrics = usePlayerStore((state) => state.lyrics);
  const isLyricsLoading = usePlayerStore((state) => state.isLyricsLoading);
  const seek = usePlayerStore((state) => state.seek);

  // Subscribe directly to activeIndex so the component only re-renders
  // when the active line actually changes, instead of on every audio timeupdate.
  const activeIndex = usePlayerStore((state) =>
    findActiveLyricIndex(state.lyrics, state.currentTime)
  );

  return {
    lyrics,
    activeIndex,
    isLyricsLoading,
    seek,
  };
}
