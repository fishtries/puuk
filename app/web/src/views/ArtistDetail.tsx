import React, { useEffect, useRef } from 'react';
import type { Album, Track } from '../types/track';
import type { ArtistSummaryDTO } from '../api/share';
import { AuthorizedImage } from '../components/common/AuthorizedImage';
import { useShareNavigationStore } from '../store/useShareNavigationStore';
import { usePlayerStore } from '../store/usePlayerStore';
import { entityShareId } from '../utils/shareLinks';
import { ShareButton } from './TrackDetail';
import styles from './ShareDetail.module.css';

export function ArtistDetail({ artist, tracks, albums }: { artist: ArtistSummaryDTO; tracks: Track[]; albums: Album[] }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const navigate = useShareNavigationStore(state => state.navigateToTarget);
  useEffect(() => { heading.current?.focus(); }, [artist.id]);
  const artwork = artist.artwork_url || artist.artwork || artist.coverArt;
  return <article>
    <div className={styles.card}>
      {artwork && <AuthorizedImage src={artwork} alt="" className={styles.cover} />}
      <div className={styles.meta}>
        <h1 ref={heading} tabIndex={-1} className={styles.title}>{artist.name}</h1>
        <div className={styles.actions}><ShareButton type="artist" entity={artist} />
          {tracks.length > 0 && <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => void usePlayerStore.getState().playTrack(tracks[0], tracks, 'collection')}>Слушать</button>}
        </div>
      </div>
    </div>
    <h2>Популярные треки</h2>
    {!tracks.length && <p className={styles.subtitle}>Пока нет треков</p>}
    <ul className={styles.list}>{tracks.map(track => <li key={track.id} className={styles.row}>
      <button type="button" className={styles.link} onClick={() => navigate({ type: 'track', id: track.share_id ?? track.id })}>{track.title}</button>
      <button type="button" className={styles.button} aria-label={`Слушать ${track.title}`} onClick={() => void usePlayerStore.getState().playTrack(track, tracks, 'collection')}>Слушать</button>
    </li>)}</ul>
    <h2>Альбомы</h2>
    <ul className={styles.list}>{albums.map(album => {
      const id = entityShareId('album', album);
      return <li key={id ?? album.id}><button type="button" className={styles.link} disabled={!id} onClick={() => id && navigate({ type: 'album', id })}>{album.title}</button></li>;
    })}</ul>
  </article>;
}
