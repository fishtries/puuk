import React, { useState } from 'react';
import {
  Track,
  TrackEditPayloadDTO,
  MetadataSearchResultDTO,
  LyricsSearchResultDTO,
} from '../../types/track';
import { getCoverUrl, updateTrackMetadata, searchMetadata, searchOnlineLyrics, resyncTrack } from '../../api/tracks';
import { useQueryClient } from '@tanstack/react-query';
import { usePlayerStore } from '../../store/usePlayerStore';

export type EditorTab = 'tags' | 'cover' | 'lyrics' | 'specs';

/**
 * All editor state and handlers, extracted verbatim from the original TagEditorForm.
 * Tabs receive this object as a single `form` prop.
 */
export function useTagEditorForm(initialTrack: Track, onClose: () => void) {
  const queryClient = useQueryClient();
  const updateTrackInStore = usePlayerStore((state) => state.updateTrackInStore);

  const [currentTrackData, setCurrentTrackData] = useState<Track>(initialTrack);
  const [activeTab, setActiveTab] = useState<EditorTab>('tags');

  // Form Fields initialized from props
  const [title, setTitle] = useState(initialTrack.title || '');
  const [artist, setArtist] = useState(initialTrack.artist || '');
  const [album, setAlbum] = useState(initialTrack.album || '');
  const [albumArtist, setAlbumArtist] = useState(initialTrack.album_artist || '');
  const [year, setYear] = useState<string>(initialTrack.year ? String(initialTrack.year) : '');
  const [genre, setGenre] = useState(initialTrack.genre || '');
  const [trackNumber, setTrackNumber] = useState(initialTrack.track_number || '');
  const [discNumber, setDiscNumber] = useState(initialTrack.disc_number || '');
  const [comment, setComment] = useState(initialTrack.comment || '');
  const [lyrics, setLyrics] = useState(initialTrack.lyrics || '');

  // Cover State
  const [coverAction, setCoverAction] = useState<'keep' | 'replace' | 'remove'>('keep');
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string>(getCoverUrl(initialTrack));
  const [coverBase64, setCoverBase64] = useState<string | null>(null);
  const [coverMime, setCoverMime] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Online Search
  const [metadataQuery, setMetadataQuery] = useState(
    `${initialTrack.artist} ${initialTrack.title}`.trim()
  );
  const [isSearchingMetadata, setIsSearchingMetadata] = useState(false);
  const [metadataResults, setMetadataResults] = useState<MetadataSearchResultDTO[]>([]);

  const [lyricsQuery, setLyricsQuery] = useState(
    `${initialTrack.artist} ${initialTrack.title}`.trim()
  );
  const [isSearchingLyrics, setIsSearchingLyrics] = useState(false);
  const [lyricsResults, setLyricsResults] = useState<LyricsSearchResultDTO[]>([]);

  // Mutation & Processing State
  const [isSaving, setIsSaving] = useState(false);
  const [isResyncing, setIsResyncing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // File Upload Helper
  const processImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Файл должен быть изображением (JPEG, PNG, WebP)');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      if (dataUrl) {
        setCoverPreviewUrl(dataUrl);
        setCoverAction('replace');
        setCoverMime(file.type);
        const base64Index = dataUrl.indexOf('base64,');
        if (base64Index !== -1) {
          setCoverBase64(dataUrl.slice(base64Index + 7));
        } else {
          setCoverBase64(dataUrl);
        }
        setErrorMessage(null);
      }
    };
    reader.onerror = () => {
      setErrorMessage('Не удалось прочитать файл изображения');
    };
    reader.readAsDataURL(file);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processImageFile(file);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processImageFile(file);
    }
  };

  // Online Metadata Search
  const handleSearchMetadata = async () => {
    if (!metadataQuery.trim()) return;
    setIsSearchingMetadata(true);
    setErrorMessage(null);
    try {
      const results = await searchMetadata(metadataQuery.trim());
      setMetadataResults(results);
      if (results.length === 0) {
        setErrorMessage('По запросу ничего не найдено');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Ошибка онлайн поиска';
      setErrorMessage(msg);
    } finally {
      setIsSearchingMetadata(false);
    }
  };

  const applyMetadataResult = (item: MetadataSearchResultDTO) => {
    if (item.title) setTitle(item.title);
    if (item.artist) setArtist(item.artist);
    if (item.album) setAlbum(item.album);
    if (item.year) setYear(String(item.year));
    if (item.genre) setGenre(item.genre);
    if (item.track_number) setTrackNumber(item.track_number);

    if (item.cover_url) {
      setCoverPreviewUrl(item.cover_url);
      setCoverAction('replace');
      fetch(item.cover_url)
        .then((res) => res.blob())
        .then((blob) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            setCoverPreviewUrl(dataUrl);
            setCoverMime(blob.type || 'image/jpeg');
            const base64Index = dataUrl.indexOf('base64,');
            if (base64Index !== -1) {
              setCoverBase64(dataUrl.slice(base64Index + 7));
            }
          };
          reader.readAsDataURL(blob);
        })
        .catch(() => {});
    }

    setMetadataResults([]);
  };

  // Online Lyrics Search
  const handleSearchLyrics = async () => {
    if (!lyricsQuery.trim()) return;
    setIsSearchingLyrics(true);
    setErrorMessage(null);
    try {
      const results = await searchOnlineLyrics(lyricsQuery.trim());
      setLyricsResults(results);
      if (results.length === 0) {
        setErrorMessage('Тексты в LRCLIB не найдены');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Ошибка поиска текстов';
      setErrorMessage(msg);
    } finally {
      setIsSearchingLyrics(false);
    }
  };

  const applyLyricsResult = (item: LyricsSearchResultDTO) => {
    const chosen =
      item.synced_lyrics || item.syncedLyrics || item.plain_lyrics || item.plainLyrics || '';
    if (chosen) {
      setLyrics(chosen);
    }
    setLyricsResults([]);
  };

  // Resync from Disk
  const handleResync = async () => {
    setIsResyncing(true);
    setErrorMessage(null);
    try {
      const refreshed = await resyncTrack(currentTrackData.id);
      setCurrentTrackData(refreshed);
      setTitle(refreshed.title || '');
      setArtist(refreshed.artist || '');
      setAlbum(refreshed.album || '');
      setAlbumArtist(refreshed.album_artist || '');
      setYear(refreshed.year ? String(refreshed.year) : '');
      setGenre(refreshed.genre || '');
      setTrackNumber(refreshed.track_number || '');
      setDiscNumber(refreshed.disc_number || '');
      setComment(refreshed.comment || '');
      setLyrics(refreshed.lyrics || '');
      setCoverAction('keep');
      setCoverPreviewUrl(getCoverUrl(refreshed));
      setCoverBase64(null);
      setCoverMime(null);

      updateTrackInStore(currentTrackData.id, refreshed);
      queryClient.setQueryData(['track', currentTrackData.id], refreshed);
      queryClient.invalidateQueries({ queryKey: ['tracks'] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Ошибка пересканирования файла';
      setErrorMessage(msg);
    } finally {
      setIsResyncing(false);
    }
  };

  // Save Changes
  const handleSave = async () => {
    setIsSaving(true);
    setErrorMessage(null);

    const parsedYear = year.trim() ? parseInt(year.trim(), 10) : null;

    const payload: TrackEditPayloadDTO = {
      title: title.trim(),
      artist: artist.trim(),
      album: album.trim() || null,
      album_artist: albumArtist.trim() || null,
      year: isNaN(parsedYear as number) ? null : parsedYear,
      genre: genre.trim() || null,
      track_number: trackNumber.trim() || null,
      disc_number: discNumber.trim() || null,
      comment: comment.trim() || null,
      lyrics: lyrics,
      cover_action: coverAction,
      cover_base64: coverAction === 'replace' ? coverBase64 : null,
      cover_mime: coverAction === 'replace' ? coverMime : null,
    };

    try {
      const updated = await updateTrackMetadata(currentTrackData.id, payload);
      setCurrentTrackData(updated);
      updateTrackInStore(currentTrackData.id, updated);
      queryClient.setQueryData(['track', currentTrackData.id], updated);
      queryClient.invalidateQueries({ queryKey: ['tracks'] });
      queryClient.invalidateQueries({ queryKey: ['albums'] });
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
      queryClient.invalidateQueries({ queryKey: ['history'] });
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Не удалось сохранить теги';
      setErrorMessage(msg);
    } finally {
      setIsSaving(false);
    }
  };

  return {
    // data
    currentTrackData,
    activeTab,
    setActiveTab,
    // fields
    title, setTitle,
    artist, setArtist,
    album, setAlbum,
    albumArtist, setAlbumArtist,
    year, setYear,
    genre, setGenre,
    trackNumber, setTrackNumber,
    discNumber, setDiscNumber,
    comment, setComment,
    lyrics, setLyrics,
    // cover
    coverAction, setCoverAction,
    coverPreviewUrl, setCoverPreviewUrl,
    coverBase64, setCoverBase64,
    coverMime, setCoverMime,
    isDraggingOver, setIsDraggingOver,
    fileInputRef,
    processImageFile,
    handleFileInputChange,
    handleDrop,
    // search state + handlers
    metadataQuery, setMetadataQuery,
    isSearchingMetadata,
    metadataResults,
    handleSearchMetadata,
    applyMetadataResult,
    lyricsQuery, setLyricsQuery,
    isSearchingLyrics,
    lyricsResults,
    handleSearchLyrics,
    applyLyricsResult,
    // save / resync
    isSaving,
    isResyncing,
    errorMessage,
    handleResync,
    handleSave,
  };
}

export type TagEditorFormApi = ReturnType<typeof useTagEditorForm>;
