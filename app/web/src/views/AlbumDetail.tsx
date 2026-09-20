import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAlbumTracks, getCoverUrl } from '../api/tracks';
import { Album } from '../types/track';
import { CollectionDetail } from '../components/collection/CollectionDetail';

interface AlbumDetailProps {
  album: Album;
}

export const AlbumDetail: React.FC<AlbumDetailProps> = ({ album }) => {
  const { data: tracks = [], isFetching } = useQuery({
    queryKey: ['album-tracks', album.id],
    queryFn: () => fetchAlbumTracks(String(album.id)),
    staleTime: 60000,
  });

  const coverUrl = getCoverUrl(tracks[0] ?? album);

  return (
    <CollectionDetail
      name={album.title}
      subtitle={album.artist}
      coverUrl={coverUrl}
      tracks={tracks}
      isLoading={isFetching}
      emptyLabel="В этом альбоме пока нет треков"
    />
  );
};
