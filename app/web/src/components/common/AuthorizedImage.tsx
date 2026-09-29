import React, { useEffect, useState } from 'react';
import { fetchAuthorizedBlobUrl } from '../../api/media';

interface AuthorizedImageProps {
  src: string;
  alt?: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  draggable?: boolean;
  onError?: () => void;
}

export const AuthorizedImage: React.FC<AuthorizedImageProps> = ({
  src,
  alt = '',
  className,
  loading,
  draggable,
  onError,
}) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBlobUrl(null);
    if (!src) {
      return undefined;
    }
    fetchAuthorizedBlobUrl(src)
      .then((url) => {
        if (!cancelled) setBlobUrl(url);
      })
      .catch(() => {
        if (!cancelled) onError?.();
      });
    return () => {
      cancelled = true;
    };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!src || !blobUrl) {
    return null;
  }

  return (
    <img
      src={blobUrl}
      alt={alt}
      className={className}
      loading={loading}
      draggable={draggable}
      onError={onError}
    />
  );
};
