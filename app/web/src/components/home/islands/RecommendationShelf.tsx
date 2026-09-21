import React from 'react';
import { motion } from 'framer-motion';
import { Play, Pause, Music2 } from 'lucide-react';
import { Track } from '../../../types/track';
import { getCoverUrl } from '../../../api/tracks';
import styles from '../HomeScreen.module.css';

interface RecommendationShelfProps {
  tracks: Track[];
  isCurrentPlaying: (trackId: string) => boolean;
  onTrackClick: (track: Track) => void;
}

export const RecommendationShelf: React.FC<RecommendationShelfProps> = ({
  tracks,
  isCurrentPlaying,
  onTrackClick,
}) => (
  <section className={styles.recommendationShelf}>
    <h3 className={styles.shelfTitle}>hey, check this out. you'll like this.</h3>

    <div className={styles.shelfCardsContainer}>
      {tracks.map((track) => {
        const isPlaying = isCurrentPlaying(track.id);
        const cover = getCoverUrl(track);

        return (
          <motion.div
            key={track.id}
            className={styles.shelfTrackCard}
            whileHover={{ y: -4, scale: 1.02 }}
            transition={{ duration: 0.2 }}
            onClick={() => onTrackClick(track)}
          >
            <div className={styles.shelfCoverWrapper}>
              {cover ? (
                <img src={cover} alt={track.title} className={styles.shelfCoverImg} />
              ) : (
                <div className={styles.shelfFallbackCover}>
                  <Music2 size={24} />
                </div>
              )}

              <button
                type="button"
                className={`${styles.shelfPlayOverlayBtn} ${isPlaying ? styles.visiblePlayBtn : ''}`}
                aria-label="Play track"
                onClick={(e) => {
                  e.stopPropagation();
                  onTrackClick(track);
                }}
              >
                {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              </button>
            </div>

            <div className={styles.shelfCardMeta}>
              <span className={styles.shelfCardTitle} title={track.title}>
                {track.title}
              </span>
              <span className={styles.shelfCardArtist} title={track.artist}>
                {track.artist}
              </span>
            </div>
          </motion.div>
        );
      })}
    </div>
  </section>
);
