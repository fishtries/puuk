import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Play, Share2, Music2 } from 'lucide-react';
import type { Track } from '../types/track';
import { getCoverUrl } from '../api/tracks';
import { AuthorizedImage } from '../components/common/AuthorizedImage';
import { usePlayerStore } from '../store/usePlayerStore';
import { useShareNavigationStore } from '../store/useShareNavigationStore';
import { SHARE_LINKS_ENABLED, entityShareId, shareEntityUrl, type ShareEntityType } from '../utils/shareLinks';
import styles from './ShareDetail.module.css';

export function ShareButton({ type, entity, className, iconOnly = false }: { type: ShareEntityType; entity: { id?: unknown; share_id?: unknown }; className?: string; iconOnly?: boolean }) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  if (!SHARE_LINKS_ENABLED) return null;
  const id = entityShareId(type, entity);
  return <>
    <button type="button" className={className ?? styles.button} aria-label="Поделиться" disabled={busy} onClick={async e => {
      e.stopPropagation();
      if (!id) { setFeedback('Ссылка недоступна'); if (iconOnly) toast.error('Ссылка недоступна'); return; }
      setBusy(true);
      const result = await shareEntityUrl({ type, id });
      setBusy(false);
      const message = result === 'copied' ? 'Ссылка скопирована' : result === 'shared' ? 'Ссылка отправлена' : result === 'failed' ? 'Не удалось поделиться' : '';
      setFeedback(message);
      if (iconOnly && message) { if (result === 'failed') toast.error(message); else toast.success(message); }
    }}><Share2 size={16} />{!iconOnly && <span>Поделиться</span>}</button>
    <span role="status" aria-live="polite" className={iconOnly ? styles.visuallyHidden : styles.status}>{feedback}</span>
  </>;
}
export function TrackDetail({ track }: { track: Track }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [track.id]);
  const navigate = useShareNavigationStore(state => state.navigateToTarget);
  const cover = getCoverUrl(track);
  const [failedCover, setFailedCover] = useState('');
  return <article className={styles.card}>
    {cover && failedCover !== cover ? <AuthorizedImage src={cover} alt="" className={styles.cover} onError={() => setFailedCover(cover)} /> : <div className={styles.cover}><Music2 size={48} /></div>}
    <div className={styles.meta}>
      <h1 ref={heading} tabIndex={-1} className={styles.title}>{track.title}</h1>
      <p className={styles.subtitle}>{track.artist}</p>
      <div className={styles.actions}>
        {track.artists?.map(artist => <button type="button" className={styles.link} key={artist.id} onClick={() => navigate({ type: 'artist', id: artist.share_id ?? artist.id })}>{artist.name}</button>)}
        {track.album_share_id && <button type="button" className={styles.link} onClick={() => navigate({ type: 'album', id: track.album_share_id! })}>{track.album || 'Альбом'}</button>}
      </div>
      <p className={styles.actions}>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => void usePlayerStore.getState().playTrack(track, [track], 'collection')}><Play size={17} />Слушать</button>
        <ShareButton type="track" entity={track} />
      </p>
    </div>
  </article>;
}
