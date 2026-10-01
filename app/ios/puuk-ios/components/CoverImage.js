import React, { useState, useEffect } from 'react';
import { Image } from 'react-native';
import {
  getAuthHeaders,
  getCachedAuthHeaders,
  getCachedAuthToken,
  SERVER_URL,
} from '../utils/api';

const DEFAULT_COVER = require('../assets/default_cover.jpg');

/**
 * Проверяет, является ли URI обложкой нашего сервера:
 * - Содержит путь эндпоинта /api/cover/
 * - Начинается с относительного пути /
 * - Начинается с текущего SERVER_URL
 */
export const isServerCoverUri = (uri) => {
  if (typeof uri !== 'string') return false;
  return (
    uri.includes('/api/cover/') ||
    uri.startsWith('/') ||
    (Boolean(SERVER_URL) && uri.startsWith(SERVER_URL))
  );
};

/**
 * Нормализует URL обложки:
 * - Перенаправляет путь /api/cover/ на актуальный SERVER_URL (независимо от того,
 *   какой абсолютный BASE_URL вернул бэкенд в coverArt)
 * - Добавляет query-параметр ?token= для нативной загрузки
 */
export const resolveCoverUri = (rawUri, token = null) => {
  if (!rawUri || typeof rawUri !== 'string') return '';
  const trimmed = rawUri.trim();
  if (!trimmed) return '';

  const apiIndex = trimmed.indexOf('/api/cover/');
  let targetUri = trimmed;
  if (apiIndex !== -1) {
    const path = trimmed.slice(apiIndex);
    targetUri = `${SERVER_URL}${path}`;
  } else if (trimmed.startsWith('/')) {
    targetUri = `${SERVER_URL}${trimmed}`;
  }

  if (isServerCoverUri(targetUri) && token && !targetUri.includes('token=')) {
    const separator = targetUri.includes('?') ? '&' : '?';
    return `${targetUri}${separator}token=${encodeURIComponent(token)}`;
  }

  return targetUri;
};

export default function CoverImage({
  source,
  style,
  defaultSource = DEFAULT_COVER,
  onError,
  ...props
}) {
  const [hasError, setHasError] = useState(false);
  const [authHeaders, setAuthHeaders] = useState(() => getCachedAuthHeaders());
  const [authToken, setAuthToken] = useState(() => getCachedAuthToken());

  useEffect(() => {
    let mounted = true;
    getAuthHeaders().then((headers) => {
      if (mounted && headers?.Authorization) {
        setAuthHeaders(headers);
        setAuthToken(getCachedAuthToken());
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Извлекаем uri, если передан объектом { uri: ... } или строкой
  const rawUri = typeof source === 'string' ? source : source?.uri;

  // Сбрасываем флаг ошибки при смене URI или получении свежих заголовков авторизации
  useEffect(() => {
    setHasError(false);
  }, [rawUri, authHeaders]);

  let imageSource = defaultSource;
  if (typeof source === 'number') {
    // Локальный ресурс require(...)
    imageSource = source;
  } else if (rawUri && !hasError) {
    const isServer = isServerCoverUri(rawUri);
    if (isServer) {
      if (authHeaders) {
        const resolvedUri = resolveCoverUri(rawUri, authToken);
        imageSource = { uri: resolvedUri, headers: authHeaders };
      } else {
        // Серверный ресурс требует JWT. Пока заголовки загружаются,
        // отображаем дефолтную обложку без отправки неавторизованного запроса (чтобы не ловить 401).
        imageSource = defaultSource;
      }
    } else {
      // Внешний URL (iTunes, Deezer и т.д.) — не шлём наш Bearer наружу
      imageSource = { uri: rawUri };
    }
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
