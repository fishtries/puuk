import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchFavorites,
  fetchPlaylistTracks,
  removeTrackFromPlaylist,
} from '../api/tracks';
import { CollectionDetail } from '../components/collection/CollectionDetail';
import { PlaylistActionsMenu } from '../components/playlists/PlaylistActionsMenu';
import { Playlist, Track } from '../types/track';
import { useAuthStore } from '../store/useAuthStore';
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
  });

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
        tracks: previous.tracks.filter((t) => t.id !== track.id),
      });
    }

    try {
      await removeTrackFromPlaylist(playlistId, track.id);
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
