import { useCallback, useEffect, useRef, useState } from 'react';
import { triggerWordLyricsGeneration, fetchLyricsGenerationStatus } from '../../api/tracks';
import { Track } from '../../types/track';
import { usePlayerStore } from '../../store/usePlayerStore';

export type GenerationStatus = 'idle' | 'processing' | 'completed' | 'failed';

export interface KaraokeGeneration {
  generationStatus: GenerationStatus;
  generationNotice: string | null;
  generationError: string | null;
  handleGenerateWordLyrics: (force?: boolean, refetch?: boolean) => Promise<void>;
}

/**
 * Polling bridge to the backend word-level (karaoke) alignment job.
 * Logic extracted verbatim from AppleLyricsStream; polling interval is
 * cancelled on unmount and on track switch to avoid leaked timers.
 */
export function useKaraokeGeneration(currentTrack: Track | null): KaraokeGeneration {
  const fetchLyrics = usePlayerStore((state) => state.fetchLyrics);
  const [generationStatus, setGenerationStatus] = useState<GenerationStatus>('idle');
  const [generationNotice, setGenerationNotice] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const pollIntervalRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current !== null) {
      window.clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // Cancel any active polling when the track changes or the component unmounts
  useEffect(() => {
    return () => stopPolling();
  }, [currentTrack?.id, stopPolling]);

  const handleGenerateWordLyrics = useCallback(
    async (force = false, refetch = false) => {
      if (!currentTrack || generationStatus === 'processing') return;

      setGenerationStatus('processing');
      setGenerationError(null);
      setGenerationNotice(
        force
          ? 'Пересоздание караоке на GPU (RTX 4070)...'
          : 'Запуск Whisper на GPU RTX 4070...'
      );

      const trackId = currentTrack.id;
      stopPolling();

      try {
        await triggerWordLyricsGeneration(trackId, undefined, force, refetch);

        pollIntervalRef.current = window.setInterval(async () => {
          try {
            const res = await fetchLyricsGenerationStatus(trackId);
            if (res.status === 'completed') {
              stopPolling();
              setGenerationStatus('completed');
              setGenerationNotice('Синхронизация караоке завершена!');
              fetchLyrics(trackId, true);
              setTimeout(() => {
                setGenerationStatus('idle');
                setGenerationNotice(null);
              }, 3500);
            } else if (res.status === 'failed') {
              stopPolling();
              setGenerationStatus('failed');
              setGenerationError(res.error || 'Не удалось распознать слова');
              setGenerationNotice(null);
              setTimeout(() => {
                setGenerationStatus('idle');
              }, 6000);
            } else if (res.stage) {
              setGenerationNotice(res.stage);
            } else if (res.message) {
              setGenerationNotice(res.message);
            }
          } catch {
            // ignore transient errors
          }
        }, 1500);
      } catch (e: unknown) {
        setGenerationStatus('failed');
        setGenerationError(e instanceof Error ? e.message : 'Ошибка запроса генерации');
        setGenerationNotice(null);
      }
    },
    [currentTrack, generationStatus, fetchLyrics, stopPolling]
  );

  return { generationStatus, generationNotice, generationError, handleGenerateWordLyrics };
}
