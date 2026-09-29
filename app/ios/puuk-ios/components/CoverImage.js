import React, { useState, useEffect } from 'react';
import { Image } from 'react-native';
import { getAuthHeaders, SERVER_URL } from '../utils/api';

const DEFAULT_COVER = require('../assets/default_cover.jpg');

// Закрытый режим: обложки отдаются только с Bearer JWT.
// Заголовок добавляем только для нашего сервера — внешние URL (iTunes/Deezer) не трогаем.
const isServerUri = (uri) =>
  typeof uri === 'string' && (uri.startsWith('/') || uri.startsWith(SERVER_URL));

export default function CoverImage({ source, style, defaultSource = DEFAULT_COVER, onError, ...props }) {
  const [hasError, setHasError] = useState(false);
  const [authHeaders, setAuthHeaders] = useState(null);

  useEffect(() => {
    let mounted = true;
    getAuthHeaders().then((headers) => {
      if (mounted && headers.Authorization) setAuthHeaders(headers);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Extract uri if provided as object { uri: ... } or string
  const uri = typeof source === 'string' ? source : source?.uri;

  // Reset error state when uri changes (e.g. switching tracks)
  useEffect(() => {
    setHasError(false);
  }, [uri]);

  let imageSource = DEFAULT_COVER;
  if (typeof source === 'number') {
    // Local asset require(...)
    imageSource = source;
  } else if (uri && !hasError) {
    imageSource = isServerUri(uri) && authHeaders ? { uri, headers: authHeaders } : { uri };
  }

  return (
    <Image
      source={imageSource}
      defaultSource={defaultSource}
      onError={(e) => {
        setHasError(true);
        if (onError) onError(e);
      }}
      style={style}
      {...props}
    />
  );
}

export { DEFAULT_COVER };
