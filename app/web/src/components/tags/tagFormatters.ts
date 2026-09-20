export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatSampleRate(rate?: number): string {
  if (!rate || rate <= 0) return '—';
  if (rate >= 1000) return `${(rate / 1000).toFixed(1)} kHz`;
  return `${rate} Hz`;
}

export function formatChannels(channels?: number): string {
  if (!channels) return '—';
  if (channels === 1) return '1 (Моно)';
  if (channels === 2) return '2 (Стерео)';
  return `${channels} канала`;
}
