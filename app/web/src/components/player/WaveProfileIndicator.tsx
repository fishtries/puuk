import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, Radio } from 'lucide-react';
import { fetchWaveProfileStats, WaveProfileStats } from '../../api/wave';
import styles from './WaveProfileIndicator.module.css';
import { useAuthStore } from '../../store/useAuthStore';

interface WaveProfileIndicatorProps {
  compact?: boolean;
  className?: string;
}

export const WaveProfileIndicator: React.FC<WaveProfileIndicatorProps> = ({
  compact = false,
  className = '',
}) => {
  const token = useAuthStore((state) => state.token);
  const user = useAuthStore((state) => state.user);
  const userId = user?.id ?? null;
  const { data: profile, isLoading } = useQuery<WaveProfileStats>({
    queryKey: ['wave-profile-stats', userId],
    queryFn: fetchWaveProfileStats,
    enabled: Boolean(token && user),
    staleTime: 20000,
    refetchInterval: 30000,
    retry: 1,
  });

  if (isLoading && !profile) {
    return (
      <div className={`${styles.badge} ${styles.learning} ${compact ? styles.compact : ''} ${className}`}>
        <span className={styles.dot} />
        <span>Инициализация...</span>
      </div>
    );
  }

  const isPersonalized = profile?.is_personalized || (profile?.track_count ?? 0) >= 5;
  const trackCount = profile?.track_count ?? 0;

  const tooltipText = isPersonalized
    ? `Моя Волна персонализирована на основе ${trackCount} треков и ваших лайков.`
    : `Моя Волна собирает информацию о ваших вкусах (${trackCount}/5 треков).`;

  return (
    <div
      className={`${styles.badge} ${isPersonalized ? styles.personalized : styles.learning} ${
        compact ? styles.compact : ''
      } ${className}`}
      title={tooltipText}
    >
      <span className={styles.dot} />
      {isPersonalized ? (
        <>
          <Sparkles size={compact ? 11 : 13} className={styles.icon} />
          {compact ? (
            <span>Персонально • <span className={styles.count}>{trackCount}</span></span>
          ) : (
            <span>Персонализировано • <span className={styles.count}>{trackCount}</span> треков</span>
          )}
        </>
      ) : (
        <>
          <Radio size={compact ? 11 : 13} className={styles.icon} />
          {compact ? (
            <span>Изучаем вкус • {trackCount}/5</span>
          ) : (
            <span>Изучаем ваш вкус... ({trackCount}/5)</span>
          )}
        </>
      )}
    </div>
  );
};
