import React, { useState, useEffect } from 'react';
import { Image, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  getCachedAuthHeaders,
  getCachedAuthToken,
  addAuthListener,
  SERVER_URL,
} from '../api/api';

const DEFAULT_COVER = require('../../assets/default_cover.jpg');

const styles = StyleSheet.create({
  neutralPlaceholder: {
    backgroundColor: '#2c2c2e',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
});

/**
 * Проверяет, является ли URI путем к artwork артиста (/api/artists/{id}/artwork).
 */
export const isArtistArtworkUri = (uri) => {
  if (typeof uri !== 'string') return false;
  const trimmed = uri.trim();
  return /\/api\/artists\/[^/?#]+\/artwork(?=[/?#]|$)/.test(trimmed);
};

/**
 * Проверяет наличие media-тикета (?mt=...) в URI.
 */
export const hasMediaTicket = (uri) => {
  if (typeof uri !== 'string') return false;
  return /[?&]mt=[^&#]+/.test(uri);
};

/**
 * Проверяет, является ли URI обложкой или artwork нашего сервера:
 * - Содержит путь эндпоинта /api/cover/
 * - Содержит путь эндпоинта /api/artists/{id}/artwork
 * - Начинается с относительного пути /
 * - Начинается с текущего SERVER_URL
 */
export const isServerCoverUri = (uri) => {
  if (typeof uri !== 'string') return false;
  const trimmed = uri.trim();
  return (
    trimmed.includes('/api/cover/') ||
    isArtistArtworkUri(trimmed) ||
    trimmed.startsWith('/') ||
    (Boolean(SERVER_URL) && trimmed.startsWith(SERVER_URL))
  );
};

export const isServerMediaUri = isServerCoverUri;

/**
 * Нейтральный плейсхолдер для артистов без artwork (контракт 4.5).
 * Сохраняет переданные размеры и геометрию style.
 */
export function NeutralPlaceholder({
  style,
  testID = 'artist-placeholder',
  accessibilityRole = 'image',
  accessibilityLabel = 'Нет изображения',
  ...rest
}) {
  const flatStyle = StyleSheet.flatten(style) || {};
  const width = flatStyle.width;
  const height = flatStyle.height;
  const dimension =
    typeof width === 'number'
      ? width
      : typeof height === 'number'
      ? height
      : null;
  const iconSize = dimension
    ? Math.max(16, Math.min(64, Math.round(dimension * 0.4)))
    : 32;

  return (
    <View
      style={[styles.neutralPlaceholder, style]}
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      {...rest}
    >
      <Ionicons name="person" size={iconSize} color="#8e8e93" />
    </View>
  );
}

/**
 * Нормализует URL обложки / artwork артиста:
 * - Перенаправляет путь /api/cover/ и /api/artists/ на актуальный SERVER_URL
 * - Для artwork артиста: НИКОГДА не генерирует query ?token= (auth только через Bearer / media-тикет)
 * - Для обычных обложек (/api/cover/): добавляет query-параметр ?token= для нативной загрузки
 * - Поддерживает инвалидацию кэша через query-параметр ?v=<version>
 */
export const resolveCoverUri = (rawUri, token = null, versionOrOptions = null) => {
  if (!rawUri || typeof rawUri !== 'string') return '';
  const trimmed = rawUri.trim();
  if (!trimmed) return '';

  const isArtwork = isArtistArtworkUri(trimmed);
  const apiCoverIndex = trimmed.indexOf('/api/cover/');
  const apiArtistIndex = trimmed.indexOf('/api/artists/');

  let targetUri = trimmed;
  if (apiCoverIndex !== -1) {
    const path = trimmed.slice(apiCoverIndex);
    targetUri = `${SERVER_URL}${path}`;
  } else if (apiArtistIndex !== -1) {
    const path = trimmed.slice(apiArtistIndex);
    targetUri = `${SERVER_URL}${path}`;
  } else if (trimmed.startsWith('/')) {
    targetUri = `${SERVER_URL}${trimmed}`;
  }

  // Handle version cache busting if provided
  let version = null;
  if (typeof versionOrOptions === 'number' || typeof versionOrOptions === 'string') {
    version = versionOrOptions;
  } else if (typeof versionOrOptions === 'object' && versionOrOptions !== null) {
    version = versionOrOptions.version ?? versionOrOptions.artwork_version ?? null;
  }

  if (version !== null && version !== undefined && version !== '') {
    const vParam = `v=${encodeURIComponent(String(version))}`;
    if (/[?&]v=[^&#]*/.test(targetUri)) {
      targetUri = targetUri.replace(/([?&])v=[^&#]*/, `$1${vParam}`);
    } else {
      const separator = targetUri.includes('?') ? '&' : '?';
      targetUri = `${targetUri}${separator}${vParam}`;
    }
  }

  // Для artwork артиста: auth только через Authorization: Bearer заголовок
  // или предзаданный media-тикет (?mt=). НИКОГДА не генерируем и не оставляем ?token=.
  if (isArtwork) {
    targetUri = targetUri
      .replace(/([?&])token=[^&#]*(&|$)/g, (match, prefix, suffix) =>
        suffix === '&' ? prefix : ''
      )
      .replace(/[?&]$/, '');
    return targetUri;
  }

  // Для трековых/альбомных обложек: добавляем token при его наличии
  if (isServerCoverUri(targetUri) && token && !targetUri.includes('token=')) {
    const separator = targetUri.includes('?') ? '&' : '?';
    return `${targetUri}${separator}token=${encodeURIComponent(token)}`;
  }

  return targetUri;
};

/**
 * Выполняет фоновую предзагрузку обложки / artwork в нативный кэш изображений.
 */
export const prefetchCover = (rawUri, token = null, versionOrOptions = null) => {
  if (!rawUri || typeof rawUri !== 'string') return;
  try {
    const isArtwork = isArtistArtworkUri(rawUri);
    const resolved = resolveCoverUri(
      rawUri,
      isArtwork ? null : token || getCachedAuthToken(),
      versionOrOptions
    );
    if (resolved && typeof Image?.prefetch === 'function') {
      Image.prefetch(resolved).catch(() => {});
    }
  } catch {}
};

function CoverImage({
  source,
  style,
  defaultSource = DEFAULT_COVER,
  onError,
  artwork_url,
  artworkUrl,
  artwork_version,
  version,
  type,
  isArtist,
  placeholder,
  placeholderType,
  testID,
  accessibilityRole,
  accessibilityLabel,
  ...props
}) {
  const [hasError, setHasError] = useState(false);
  const [authHeaders, setAuthHeaders] = useState(() => getCachedAuthHeaders());
  const [authToken, setAuthToken] = useState(() => getCachedAuthToken());

  useEffect(() => {
    // Заголовки читаются только из памяти; обновляем их при изменении сессии.
    const unsubscribe =
      typeof addAuthListener === 'function'
        ? addAuthListener(() => {
            setAuthHeaders(getCachedAuthHeaders());
            setAuthToken(getCachedAuthToken());
          })
        : () => {};

    return unsubscribe;
  }, []);

  const hasArtworkProp = artwork_url !== undefined || artworkUrl !== undefined;
  const explicitArtworkUrl = artwork_url !== undefined ? artwork_url : artworkUrl;

  const isArtistContext =
    hasArtworkProp ||
    type === 'artist' ||
    isArtist === true ||
    placeholderType === 'artist' ||
    placeholderType === 'neutral' ||
    placeholder === 'neutral' ||
    Boolean(
      source &&
        typeof source === 'object' &&
        ('artwork_url' in source || 'artworkUrl' in source)
    );

  const rawUri = hasArtworkProp
    ? explicitArtworkUrl
    : typeof source === 'string'
    ? source
    : source?.uri || source?.artwork_url || source?.artworkUrl;

  const effectiveVersion =
    artwork_version !== undefined
      ? artwork_version
      : version !== undefined
      ? version
      : typeof source === 'object' && source !== null
      ? source.artwork_version ?? source.version
      : null;

  const isArtworkPath = Boolean(rawUri && isArtistArtworkUri(rawUri));
  const isArtwork = isArtistContext || isArtworkPath;

  const prevUriRef = React.useRef(rawUri);
  const prevVersionRef = React.useRef(effectiveVersion);

  // Сбрасываем флаг ошибки только при реальном изменении URI или версии
  useEffect(() => {
    if (
      prevUriRef.current !== rawUri ||
      prevVersionRef.current !== effectiveVersion
    ) {
      prevUriRef.current = rawUri;
      prevVersionRef.current = effectiveVersion;
      setHasError(false);
    }
  }, [rawUri, effectiveVersion]);

  const renderPlaceholder = (customStyle) => (
    <NeutralPlaceholder
      style={customStyle || style}
      testID={testID || 'artist-placeholder'}
      accessibilityRole={accessibilityRole || 'image'}
      accessibilityLabel={accessibilityLabel || 'Нет изображения'}
      {...props}
    />
  );

  // Если это контекст артиста и artwork_url равен null или пуст — показываем нейтральный плейсхолдер
  if (isArtwork && (!rawUri || typeof rawUri !== 'string' || !rawUri.trim())) {
    if (defaultSource && defaultSource !== DEFAULT_COVER) {
      return (
        <Image
          source={defaultSource}
          defaultSource={defaultSource}
          style={style}
          testID={testID}
          accessibilityRole={accessibilityRole}
          accessibilityLabel={accessibilityLabel}
          {...props}
        />
      );
    }
    return renderPlaceholder();
  }

  // При ошибке загрузки artwork артиста — нейтральный плейсхолдер (контракт 4.5: никогда не подставлять обложку трека)
  if (isArtwork && hasError) {
    return renderPlaceholder();
  }

  let imageSource = defaultSource;
  if (typeof source === 'number') {
    // Локальный ресурс require(...)
    imageSource = source;
  } else if (rawUri && !hasError) {
    const isServer = isServerCoverUri(rawUri);
    if (isServer) {
      const hasInlineAuth =
        hasMediaTicket(rawUri) ||
        (!isArtwork && /[?&]token=[^&#]+/.test(rawUri));

      if (authHeaders || hasInlineAuth) {
        const resolvedUri = resolveCoverUri(
          rawUri,
          isArtwork ? null : authToken,
          effectiveVersion
        );
        imageSource = {
          uri: resolvedUri,
          ...(authHeaders ? { headers: authHeaders } : {}),
        };
      } else {
        // Серверный ресурс требует JWT или тикет. Пока заголовки загружаются,
        // для артиста отображаем NeutralPlaceholder, для обычных обложек — defaultSource.
        if (isArtwork) {
          return renderPlaceholder();
        }
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
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      {...props}
    />
  );
}

export default React.memo(CoverImage);

export { DEFAULT_COVER };
