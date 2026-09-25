import React from 'react';
import { MetadataSearchCard } from './MetadataSearchCard';
import type { TagEditorFormApi } from './useTagEditorForm';
import styles from './TagEditorModal.module.css';

type FieldKey = 'title' | 'artist' | 'album' | 'albumArtist' | 'year' | 'genre' | 'trackNumber' | 'discNumber' | 'comment';

interface TagsTabProps {
  form: TagEditorFormApi;
}

const FIELD_DEFS: Array<{ key: FieldKey; label: string; placeholder: string }> = [
  { key: 'title', label: 'Название трека', placeholder: 'Название' },
  { key: 'artist', label: 'Исполнитель', placeholder: 'Исполнитель трека' },
  { key: 'album', label: 'Альбом', placeholder: 'Название альбома' },
  { key: 'albumArtist', label: 'Исполнитель альбома', placeholder: 'Album Artist' },
  { key: 'year', label: 'Год', placeholder: '2024' },
  { key: 'genre', label: 'Жанр', placeholder: 'Electronic, Pop, Rock...' },
  { key: 'trackNumber', label: 'Номер трека', placeholder: '1 или 1/12' },
  { key: 'discNumber', label: 'Номер диска', placeholder: '1 или 1/2' },
];

const SETTER_MAP = {
  title: (form: TagEditorFormApi) => form.setTitle,
  artist: (form: TagEditorFormApi) => form.setArtist,
  album: (form: TagEditorFormApi) => form.setAlbum,
  albumArtist: (form: TagEditorFormApi) => form.setAlbumArtist,
  year: (form: TagEditorFormApi) => form.setYear,
  genre: (form: TagEditorFormApi) => form.setGenre,
  trackNumber: (form: TagEditorFormApi) => form.setTrackNumber,
  discNumber: (form: TagEditorFormApi) => form.setDiscNumber,
  comment: (form: TagEditorFormApi) => form.setComment,
} as const;

export const TagsTab: React.FC<TagsTabProps> = ({ form }) => (
  <>
    <MetadataSearchCard
      query={form.metadataQuery}
      onQueryChange={form.setMetadataQuery}
      isSearching={form.isSearchingMetadata}
      results={form.metadataResults}
      onSearch={form.handleSearchMetadata}
      onApply={form.applyMetadataResult}
    />

    <div className={styles.formGrid}>
      {FIELD_DEFS.map(({ key, label, placeholder }) => (
        <div key={key} className={styles.fieldGroup}>
          <label className={styles.label}>{label}</label>
          <input
            type="text"
            className={styles.input}
            value={form[key] as string}
            onChange={(e) => SETTER_MAP[key](form)(e.target.value)}
            placeholder={placeholder}
          />
          {key === 'genre' && !form.genre.trim() && form.currentTrackData.auto_genres && form.currentTrackData.auto_genres.length > 0 && (
            <div className={styles.autoGenreHint}>
              <span className={styles.autoGenreLabel}>Определено автоматически:</span>{' '}
              <span className={styles.autoGenreValues}>
                {form.currentTrackData.auto_genres.map((g) => g.name).join(', ')}
              </span>
            </div>
          )}
        </div>
      ))}

      <div className={`${styles.fieldGroup} ${styles.fullWidth}`}>
        <label className={styles.label}>Комментарий</label>
        <textarea
          className={styles.textarea}
          value={form.comment}
          onChange={(e) => form.setComment(e.target.value)}
          placeholder="Заметки или ID3 комментарий..."
          rows={2}
        />
      </div>
    </div>
  </>
);
