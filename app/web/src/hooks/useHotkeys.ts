import { useEffect } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';

export function useHotkeys(
  searchInputRef?: React.RefObject<HTMLInputElement | null>,
  onOpenSearch?: () => void,
) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const {
        togglePlay, currentTime, duration, seek, nextTrack, previousTrack,
        volume, setVolume, toggleMute, toggleRightPanel, isFullscreen,
        setIsFullscreen, isDebugOpen, setIsDebugOpen, isLoginOpen, setIsLoginOpen,
      } = usePlayerStore.getState();
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (e.key === 'Escape') {
        if (isDebugOpen) setIsDebugOpen(false);
        if (isLoginOpen) setIsLoginOpen(false);
        if (isFullscreen) setIsFullscreen(false);
        if (isInput) target.blur();
        return;
      }

      if (isInput) return;

      switch (e.key) {
        case ' ':
          if (target.closest?.('button, [role="button"]')) return;
          e.preventDefault();
          togglePlay();
          break;

        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) {
            previousTrack();
          } else {
            seek(Math.max(0, currentTime - 5));
          }
          break;

        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) {
            nextTrack();
          } else {
            seek(Math.min(duration, currentTime + 5));
          }
          break;

        case 'ArrowUp':
          e.preventDefault();
          setVolume(Math.min(1, volume + 0.05));
          break;

        case 'ArrowDown':
          e.preventDefault();
          setVolume(Math.max(0, volume - 0.05));
          break;

        case 'm':
        case 'M':
          e.preventDefault();
          toggleMute();
          break;

        case 'l':
        case 'L':
          e.preventDefault();
          toggleRightPanel('lyrics');
          break;

        case 'f':
        case 'F':
          e.preventDefault();
          setIsFullscreen(!isFullscreen);
          break;

        case '/':
          e.preventDefault();
          if (onOpenSearch) {
            onOpenSearch();
          } else if (searchInputRef?.current) {
            searchInputRef.current.focus();
            searchInputRef.current.select();
          }
          break;

        case '`':
        case '~':
          e.preventDefault();
          setIsDebugOpen(!isDebugOpen);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onOpenSearch, searchInputRef]);
}
