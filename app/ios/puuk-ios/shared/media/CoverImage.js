import React, { useState, useEffect } from 'react';
import { Image, View, StyleSheet, PixelRatio } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getOfflineCoverUri } from '../../offline/artwork';
import {
  getCachedAuthHeaders,
  authFetch,
  getAuthSessionGeneration,
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

// Historical cover URLs may contain a previous API host. Only recognized media
// paths are rebased, and credentials are attached after checking the final origin.
function parseCoverUri(rawUri) {
  if (typeof rawUri !== 'string' || !rawUri.trim()) return null;
  const value = rawUri.trim();
  if (value.startsWith('//') || /[\\\s]/.test(value)) return null;
  try {
    const url = new URL(value, SERVER_URL);
    if (!['https:', 'http:', 'file:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.protocol !== 'file:' && /^\/api\/(?:cover\/[^/]+|artists\/[^/]+\/artwork)$/.test(url.pathname)) {
      const rebased = new URL(SERVER_URL);
      rebased.pathname = url.pathname;
      rebased.search = url.search;
      return rebased;
    }
    return url;
  } catch { return null; }
}

export const isServerCoverUri = (uri) => parseCoverUri(uri)?.origin === new URL(SERVER_URL).origin;

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

export const resolveCoverUri = (rawUri, optionsOrLegacyToken = null, legacyOptions = null) => {
  // Older callers supplied an account token in the second argument.
  const options = legacyOptions ?? (typeof optionsOrLegacyToken === 'string' ? null : optionsOrLegacyToken);
  const url = parseCoverUri(rawUri);
  if (!url) return '';
  url.searchParams.delete('token');
  const version = typeof options === 'object' ? options?.version ?? options?.artwork_version : options;
  if (version != null && version !== '') url.searchParams.set('v', String(version));
  if (url.pathname.startsWith('/api/cover/') && [128, 256, 512, 1024].includes(options?.size)) {
    url.searchParams.set('size', String(options.size));
  }
  return url.toString();
};

export async function resolveLockScreenCover(rawUri) {
  const uri = resolveCoverUri(rawUri);
  if (!uri || !isServerCoverUri(uri)) return uri || undefined;
  const url = new URL(uri);
  if (!/^\/api\/cover\/[a-f0-9-]+$/i.test(url.pathname)) return undefined;
  const generation = getAuthSessionGeneration();
  const response = await authFetch(url.pathname + '/ticket', {
    method: 'POST', timeout: 2000, retry: 0, redirect: 'error', cache: 'no-store',
  });
  if (!response.ok || response.redirected) return undefined;
  const { ticket } = await response.json();
  if (generation !== getAuthSessionGeneration() || !ticket || typeof ticket !== 'string') return undefined;
  url.searchParams.set('ct', ticket);
  return url.toString();
}

export const prefetchCover = (rawUri, optionsOrLegacyToken = null, legacyOptions = null) => {
  const uri = resolveCoverUri(rawUri, optionsOrLegacyToken, legacyOptions);
  if (!uri) return;
  if (isServerCoverUri(uri)) {
    const headers = getCachedAuthHeaders();
    if (headers) Image.getSizeWithHeaders(uri, headers)?.catch(() => {});
  } else {
    Image.prefetch(uri)?.catch(() => {});
  }
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

  useEffect(() => {
    // Заголовки читаются только из памяти; обновляем их при изменении сессии.
    const unsubscribe =
      typeof addAuthListener === 'function'
        ? addAuthListener(() => {
            setAuthHeaders(getCachedAuthHeaders());
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

  const localCover = rawUri && !isArtwork && (hasError || !authHeaders) ? getOfflineCoverUri(rawUri) : null;
  let imageSource = defaultSource;
  if (typeof source === 'number') {
    // Локальный ресурс require(...)
    imageSource = source;
  } else if (localCover) {
    imageSource = { uri: localCover };
  } else if (rawUri && !hasError) {
    const isServer = isServerCoverUri(rawUri);
    if (isServer) {
      if (authHeaders) {
        const resolvedUri = resolveCoverUri(rawUri, {
          version: effectiveVersion, size: coverPreviewSize(style, PixelRatio.get()),
        });
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
      const uri = resolveCoverUri(rawUri);
      if (uri) imageSource = { uri };
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

export function coverPreviewSize(style, density = 3) {
  const flat = StyleSheet.flatten(style) || {};
  const width = typeof flat.width === 'number' ? flat.width : 1024;
  const height = typeof flat.height === 'number' ? flat.height : width;
  const pixels = Math.max(width, height) * density;
  return [128, 256, 512, 1024].find(size => size >= pixels) || 1024;
}

export { DEFAULT_COVER };
