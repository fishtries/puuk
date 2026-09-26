import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Music2, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { usePlayerStore } from '../../store/usePlayerStore';
import { reorderPlaylistTracks } from '../../api/tracks';
import { Track } from '../../types/track';
import { toast } from 'sonner';
import cdStyles from '../collection/CollectionDetail.module.css';
import styles from './SortableTracklist.module.css';

interface SortableTracklistProps {
  tracks: Track[];
  playlistId: string;
  renderTrackActions: (track: Track) => React.ReactNode;
}

function idsSignature(tracks: Track[]): string {
  return tracks.map((t) => t.id).join('|');
}

function moveItem(list: Track[], from: number, to: number): Track[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export const SortableTracklist: React.FC<SortableTracklistProps> = ({
  tracks,
  playlistId,
  renderTrackActions,
}) => {
  const queryClient = useQueryClient();
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const status = usePlayerStore((state) => state.status);
  const playTrack = usePlayerStore((state) => state.playTrack);
  const togglePlay = usePlayerStore((state) => state.togglePlay);

  const [ordered, setOrdered] = useState<Track[]>(tracks);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const orderedSignature = useRef<string>(idsSignature(tracks));

  // Re-sync local order whenever the source list changes (refetch, optimistic remove)
  useEffect(() => {
    setOrdered(tracks);
    orderedSignature.current = idsSignature(tracks);
  }, [tracks]);

  const handleRowClick = (track: Track) => {
    if (currentTrack?.id === track.id) {
      togglePlay();
    } else {
      playTrack(track, ordered);
    }
  };

  const commitOrder = async (next: Track[]) => {
    const signature = idsSignature(next);
    if (signature === orderedSignature.current) return;

    const previous = ordered;
    const trackIds = next.map((t) => t.id);

    // Optimistic: apply the new order right away
    setOrdered(next);
    orderedSignature.current = signature;
    setIsSaving(true);

    try {
      await reorderPlaylistTracks(playlistId, trackIds);
      toast.success('Порядок треков сохранён');
      void queryClient.invalidateQueries({ queryKey: ['playlist', playlistId] });
    } catch {
      setOrdered(previous);
      orderedSignature.current = idsSignature(previous);
      toast.error('Не удалось сохранить порядок');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDrop = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex || isSaving) {
      setDragIndex(null);
      setOverIndex(null);
      return;
    }
    const next = moveItem(ordered, dragIndex, targetIndex);
    setDragIndex(null);
    setOverIndex(null);
    void commitOrder(next);
  };

  const handleMoveRelative = (index: number, delta: -1 | 1) => {
    if (isSaving) return;
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= ordered.length) return;
    void commitOrder(moveItem(ordered, index, targetIndex));
  };

  const canReorderNow = !isSaving && ordered.length > 1;

  return (
    <div className={styles.wrapper}>
      {ordered.length === 0 ? (
        <div className={cdStyles.tracklistState}>
          <Music2 size={18} />
          <span>В этом плейлисте пока нет треков</span>
        </div>
      ) : (
        <ol className={`${cdStyles.tracklist} ${isSaving ? styles.tracklistSaving : ''}`}>
          {ordered.map((track, index) => {
            const isCurrent = currentTrack?.id === track.id;
            const isRowPlaying = isCurrent && status === 'playing';
            const isDropTarget =
              canReorderNow && dragIndex !== null && overIndex === index && dragIndex !== index;
            const isDragging = dragIndex === index;

            return (
              <li
                key={track.id}
                className={[
                  cdStyles.trackRow,
                  isCurrent ? cdStyles.trackRowActive : '',
                  isDropTarget ? styles.dropTarget : '',
                  isDragging ? styles.dragging : '',
                ].join(' ')}
                onClick={() => handleRowClick(track)}
                onKeyDown={(e) => e.key === 'Enter' && handleRowClick(track)}
                role="button"
                tabIndex={0}
                draggable={canReorderNow}
                onDragStart={(e) => {
                  if (!canReorderNow) {
                    e.preventDefault();
                    return;
                  }
                  setDragIndex(index);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(index));
                }}
                onDragOver={(e) => {
                  if (!canReorderNow || dragIndex === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (overIndex !== index) setOverIndex(index);
                }}
                onDragLeave={() => {
                  if (overIndex === index) setOverIndex(null);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(index);
                }}
              >
                <span className={cdStyles.trackIndex}>
                  {isRowPlaying ? (
                    <span className={cdStyles.playingDots}>
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    String(index + 1).padStart(2, '0')
                  )}
                </span>

                <div className={cdStyles.trackMeta}>
                  <span className={cdStyles.trackTitle} title={track.title}>
                    {track.title}
                  </span>
                  <span className={cdStyles.trackArtist} title={track.artist}>
                    {track.artist}
                    {track.album ? `, ${track.album}` : ''}
                  </span>
                </div>

                <div className={cdStyles.trackActions}>
                  {renderTrackActions(track)}

                  <div className={styles.reorderButtons}>
                    <button
                      type="button"
                      className={styles.reorderBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMoveRelative(index, -1);
                      }}
                      disabled={!canReorderNow || index === 0}
                      aria-label="Переместить выше"
                      title="Выше"
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      type="button"
                      className={styles.reorderBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMoveRelative(index, 1);
                      }}
                      disabled={!canReorderNow || index === ordered.length - 1}
                      aria-label="Переместить ниже"
                      title="Ниже"
                    >
                      <ChevronDown size={13} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {isSaving && (
        <div className={styles.savingBadge} role="status">
          <Loader2 size={12} className={styles.savingSpinner} />
          <span>Сохраняем порядок…</span>
        </div>
      )}
    </div>
  );
};
