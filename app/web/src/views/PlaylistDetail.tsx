import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchFavorites, fetchPlaylistTracks, getCoverUrl } from '../api/tracks';
import { fetchMoodPlaylist } from '../api/recommendations';
import { CollectionDetail } from '../components/collection/CollectionDetail';
import { Playlist, Track } from '../types/track';

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
  const isFav = isFavorites || playlistId === FAVORITES_ID;
  const isMood = playlistId.startsWith('mood-');
  const moodId = isMood ? playlistId.replace('mood-', '') : null;
  const hasPropTracks = Boolean(propTracks && propTracks.length > 0);

  const { data: favData = [], isFetching: isFavLoading } = useQuery({
    queryKey: ['favorites'],
    queryFn: () => fetchFavorites(),
    enabled: isFav,
    staleTime: 15000,
  });

  const { data: detail, isFetching: isDetailLoading } = useQuery({
    queryKey: ['playlist', playlistId],
    queryFn: () => fetchPlaylistTracks(playlistId),
    enabled: !isFav && !isMood && !hasPropTracks,
    staleTime: 60000,
  });

  const { data: moodData, isFetching: isMoodLoading } = useQuery({
    queryKey: ['recommendations', 'mood', moodId],
    queryFn: () => fetchMoodPlaylist(moodId!),
    enabled: Boolean(isMood && moodId && !hasPropTracks),
    staleTime: 60000,
  });

  const tracks = isFav
    ? favData
    : hasPropTracks
    ? propTracks!
    : isMood
    ? moodData?.tracks ?? []
    : detail?.tracks ?? [];

  const isLoading = hasPropTracks
    ? false
    : isFav
    ? isFavLoading
    : isMood
    ? isMoodLoading
    : isDetailLoading;

  const resolvedName =
    name ||
    (isFav
      ? 'Избранное'
      : isMood
      ? moodData?.mood?.title || 'Mood mix'
      : playlist?.name || playlist?.title || 'Плейлист');

  const resolvedSubtitle =
    subtitle ||
    (isFav
      ? 'Личная коллекция'
      : isMood
      ? 'AI Mood Playlist'
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
          : isMood
          ? 'В этом настроении пока нет треков'
          : 'В этом плейлисте пока нет треков'
      }
    />
  );
};
