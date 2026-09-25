import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchFavorites, fetchPlaylistTracks, getCoverUrl } from '../api/tracks';
import { CollectionDetail } from '../components/collection/CollectionDetail';
import { Playlist, Track } from '../types/track';
import { useAuthStore } from '../store/useAuthStore';

const FAVORITES_ID = '__favorites__';

export interface PlaylistDetailProps {
  playlistId: string;
  playlist?: Playlist;
  isFavorites?: boolean;
  name?: string;
  subtitle?: string;
  coverUrl?: string;
  tracks?: Track[];
}

export const PlaylistDetail: React.FC<PlaylistDetailProps> = ({
  playlistId,
  playlist,
  isFavorites,
  name,
  subtitle,
  coverUrl,
  tracks: propTracks,
}) => {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const isFav = isFavorites || playlistId === FAVORITES_ID;
  const hasPropTracks = Boolean(propTracks && propTracks.length > 0);

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
      : playlist?.name || playlist?.title || 'Плейлист');

  const resolvedSubtitle =
    subtitle ||
    (isFav
      ? 'Личная коллекция'
      : playlist?.is_public
      ? 'Публичный'
      : 'Личный');

  const resolvedCover = coverUrl || getCoverUrl(tracks[0] ?? playlist);

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
    />
  );
};
