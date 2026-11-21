import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchFavorites,
  fetchPlaylistTracks,
  removeTrackFromPlaylist,
} from '../api/tracks';
import { CollectionDetail } from '../components/collection/CollectionDetail';
import { PlaylistActionsMenu } from '../components/playlists/PlaylistActionsMenu';
import type { Playlist, Track } from '../types/track';
import { trackRowKey } from '../utils/trackRowKey';
import { useAuthStore } from '../store/useAuthStore';
import { usePlayerStore } from '../store/usePlayerStore';
import { toast } from 'sonner';

const FAVORITES_ID = '__favorites__';

export interface PlaylistDetailProps {
  playlistId: string;
  playlist?: Playlist;
  isFavorites?: boolean;
  name?: string;
  subtitle?: string;
  coverUrl?: string;
  tracks?: Track[];
  onAddToPlaylist?: (track: Track) => void;
  /** Called after the playlist was deleted via the detail actions menu */
  onDeletedDetail?: (playlistId: string) => void;
}

function isSameUserId(a: number | string | undefined, b: string | undefined): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a) === String(b);
}

export const PlaylistDetail: React.FC<PlaylistDetailProps> = ({
  playlistId,
  playlist,
  isFavorites,
  name,
  subtitle,
  coverUrl,
  tracks: propTracks,
  onAddToPlaylist,
  onDeletedDetail,
}) => {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const queryClient = useQueryClient();
  const isFav = isFavorites || playlistId === FAVORITES_ID;
  const hasPropTracks = Boolean(propTracks && propTracks.length > 0);
  const isPersonalized = hasPropTracks;

  const { data: favData = [], isFetching: isFavLoading } = useQuery({
    queryKey: ['favorites', userId],
    queryFn: () => fetchFavorites(),
    enabled: isFav && Boolean(token && user),
    staleTime: 15000,
  });

  const { data: detail, isFetching: isDetailLoading } = useQuery({
    queryKey: ['playlist', playlistId, userId],
    queryFn: () => fetchPlaylistTracks(playlistId),
    enabled: !isFav && !hasPropTracks && Boolean(token && user),
    staleTime: 60000,
    refetchInterval: (query) => query.state.data?.playlist.is_imported ? 5000 : false,
  });

  const previousImport = React.useRef<{ id: string; tracks: Track[] } | null>(null);
  React.useEffect(() => {
    if (!detail?.playlist.is_imported) return;
    const previous = previousImport.current;
    previousImport.current = { id: playlistId, tracks: detail.tracks };
    if (previous?.id !== playlistId) return;
    const state = usePlayerStore.getState();
    if (state.isShuffled || state.isWaveActive || state.currentTrack?.playlist_entry_id == null) return;
    const currentKey = trackRowKey(state.currentTrack);
    const current = detail.tracks.findIndex((item) => trackRowKey(item) === currentKey);
    if (current < 0 || !previous.tracks.some((item) => trackRowKey(item) === currentKey)) return;
    const known = new Set(previous.tracks.map(trackRowKey));
    const queue = [...state.queue];
    for (let index = detail.tracks.length - 1; index > current; index--) {
      const item = detail.tracks[index];
      if (known.has(trackRowKey(item))) continue;
      const next = detail.tracks[index + 1];
      const place = next
        ? queue.findIndex((entry, position) => position > state.currentTrackIndex &&
            trackRowKey(entry) === trackRowKey(next))
        : -1;
      if (place >= 0) queue.splice(place, 0, item);
      else if (!next) queue.push(item);
    }
    if (queue.length !== state.queue.length) usePlayerStore.setState({ queue });
  }, [detail, playlistId]);

  const tracks = isFav
    ? favData
    : hasPropTracks
    ? propTracks!
    : detail?.tracks ?? [];

  const isLoading = hasPropTracks
    ? false
    : isFav
    ? isFavLoading
    : isDetailLoading;

  const resolvedName =
    name ||
    (isFav
      ? 'Избранное'
      : playlist?.name || playlist?.title || detail?.playlist?.name || detail?.playlist?.title || 'Плейлист');

  const resolvedSubtitle =
    subtitle ||
    (isFav
      ? 'Личная коллекция'
      : playlist?.is_public || detail?.playlist?.is_public
      ? 'Публичный'
      : 'Личный');

  // Regular playlists use the Music2 fallback cover, not the first track's art
  const resolvedCover = isFav || isPersonalized ? coverUrl : undefined;

  // Mutation affordances only for real saved playlists owned by the current user
  const metaPlaylist = detail?.playlist ?? playlist;
  const isOwner =
    !isFav &&
    !isPersonalized &&
    Boolean(token && user) &&
    Boolean(metaPlaylist) &&
    (isSameUserId(metaPlaylist!.user_id, user?.id) || user?.role === 'admin');

  const handleRemoveTrack = async (track: Track) => {
    const detailKey = ['playlist', playlistId, userId];
    const previous = queryClient.getQueryData<{ playlist: Playlist; tracks: Track[] }>(detailKey);

    // Optimistic: drop the row immediately
    if (previous) {
      queryClient.setQueryData(detailKey, {
        ...previous,
        tracks: previous.tracks.filter((t) => trackRowKey(t) !== trackRowKey(track)),
      });
    }

    try {
      await removeTrackFromPlaylist(playlistId, track.id, track.playlist_entry_id);
      toast.success('Трек удалён из плейлиста');
      void queryClient.invalidateQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({ queryKey: ['playlists', userId ?? null] });
    } catch (err) {
      if (previous) queryClient.setQueryData(detailKey, previous);
      toast.error((err as Error).message || 'Не удалось удалить трек из плейлиста');
    }
  };

  return (
    <CollectionDetail
      name={resolvedName}
      subtitle={resolvedSubtitle}
      coverUrl={resolvedCover}
      tracks={tracks}
      isLoading={isLoading}
      emptyLabel={
        isFav
          ? 'Вы ещё ничего не добавили в избранное'
          : 'В этом плейлисте пока нет треков'
      }
      headerActions={
        isOwner ? (
          <PlaylistActionsMenu
            playlist={metaPlaylist as Playlist}
            onChanged={(updated) => {
              void queryClient.invalidateQueries({ queryKey: ['playlists', userId ?? null] });
              void queryClient.invalidateQueries({ queryKey: ['playlist', String(updated.id)] });
            }}
            onDeleted={(deletedId) => {
              void queryClient.invalidateQueries({ queryKey: ['playlists', userId ?? null] });
              void queryClient.removeQueries({ queryKey: ['playlist', String(deletedId)] });
              onDeletedDetail?.(deletedId);
            }}
          />
        ) : undefined
      }
      canRemoveTracks={isOwner}
      onRemoveTrack={isOwner ? handleRemoveTrack : undefined}
      canReorder={isOwner}
      playlistId={playlistId}
      onAddToPlaylist={onAddToPlaylist}
    />
  );
};
