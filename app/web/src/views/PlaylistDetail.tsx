import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchFavorites, fetchPlaylistTracks, getCoverUrl } from '../api/tracks';
import { CollectionDetail } from '../components/collection/CollectionDetail';
import { Playlist } from '../types/track';

const FAVORITES_ID = '__favorites__';

interface PlaylistDetailProps {
  playlistId: string;
  playlist?: Playlist;
  isFavorites?: boolean;
}

export const PlaylistDetail: React.FC<PlaylistDetailProps> = ({
  playlistId,
  playlist,
  isFavorites,
}) => {
  const isFav = isFavorites || playlistId === FAVORITES_ID;

  const { data: favData = [], isFetching: isFavLoading } = useQuery({
    queryKey: ['favorites'],
    queryFn: () => fetchFavorites(),
    enabled: isFav,
    staleTime: 15000,
  });

  const { data: detail, isFetching: isDetailLoading } = useQuery({
    queryKey: ['playlist', playlistId],
    queryFn: () => fetchPlaylistTracks(playlistId),
    enabled: !isFav,
    staleTime: 60000,
  });

  const tracks = isFav ? favData : detail?.tracks ?? [];
  const isLoading = isFav ? isFavLoading : isDetailLoading;

  return (
    <CollectionDetail
      name={isFav ? 'Избранное' : playlist?.name || playlist?.title || 'Плейлист'}
      subtitle={isFav ? 'Личная коллекция' : playlist?.is_public ? 'Публичный' : 'Личный'}
      coverUrl={getCoverUrl(tracks[0] ?? playlist)}
      tracks={tracks}
      isLoading={isLoading}
      emptyLabel={isFav ? 'Вы ещё ничего не добавили в избранное' : 'В этом плейлисте пока нет треков'}
    />
  );
};
