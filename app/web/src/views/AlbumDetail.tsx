import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Disc3 } from 'lucide-react';
import { fetchAlbumDetail, getCoverUrl } from '../api/tracks';
import { ShareButton } from './TrackDetail';
import type { AlbumDetail as AlbumDetailDTO } from '../types/track';
import { Album } from '../types/track';
import { CollectionDetail } from '../components/collection/CollectionDetail';
import { useAlbumEditorStore } from '../store/useAlbumEditorStore';

interface AlbumDetailProps {
  album: Album;
  resolved?: AlbumDetailDTO;
}

export const AlbumDetail: React.FC<AlbumDetailProps> = ({ album, resolved }) => {
  const openAlbumEditor = useAlbumEditorStore((state) => state.openAlbumEditor);

  const { data, isFetching, isError } = useQuery({
    queryKey: ['album-tracks', album.share_id ?? album.id],
    enabled: !resolved,
    queryFn: () => fetchAlbumDetail(album.share_id ?? String(album.id)),
    staleTime: 60000,
  });

  const detailAlbum = resolved?.album ?? data?.album ?? album;
  const tracks = resolved?.tracks ?? data?.tracks ?? [];
  const coverUrl = getCoverUrl(tracks[0] ?? detailAlbum);

  const subtitleParts: string[] = [];
  if (detailAlbum.album_artist || detailAlbum.artist) {
    subtitleParts.push(detailAlbum.album_artist || detailAlbum.artist);
  }
  if (detailAlbum.year) subtitleParts.push(String(detailAlbum.year));

  const headerActions = (
    <>
    <ShareButton type="album" entity={detailAlbum} />
    <button
      type="button"
      className="album-edit-trigger"
      onClick={() => openAlbumEditor(detailAlbum)}
      title="Редактировать альбом: название, исполнитель, год, обложку"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 32,
        padding: '0 12px',
        borderRadius: 8,
        background: 'rgba(255, 255, 255, 0.06)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        color: 'var(--text-secondary, #d4d4d8)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      <Disc3 size={13} />
      <span>Редактировать</span>
    </button>
    </>
  );

  if (isError && !resolved) {
    return (
      <div style={{ padding: 24, color: 'var(--text-secondary, #d4d4d8)', fontSize: 13 }}>
        Не удалось загрузить альбом. Возможно, он был объединён или удалён.
      </div>
    );
  }

  return (
    <CollectionDetail
      name={detailAlbum.title}
      subtitle={subtitleParts.join(' · ') || undefined}
      coverUrl={coverUrl}
      tracks={tracks}
      isLoading={!resolved && isFetching && !data}
      emptyLabel="В этом альбоме пока нет треков"
      headerActions={headerActions}
    />
  );
};
