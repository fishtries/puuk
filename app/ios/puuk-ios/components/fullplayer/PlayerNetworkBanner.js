import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { TRACK_STATUS } from '../../utils/preloadScheduler';

/**
 * Компактный ненавязчивый баннер сетевого статуса и ошибок подготовки треков.
 * Не прерывает текущий трек, заменяет спам модальных Alert'ов.
 */
export default function PlayerNetworkBanner({
  current,
  next,
  networkStatus = 'good',
  nextTrackStatus = TRACK_STATUS.IDLE,
  isBufferingSlow = false,
  onRetry,
  onRetryCurrent,
  onRetryNext,
  onSkip,
}) {
  // 1. Текущий трек находится в процессе автоматического восстановления
  if (current?.status === 'recovering') {
    return (
      <View
        style={[styles.bannerContainer, styles.recoveringBanner]}
        accessible={true}
        accessibilityRole="alert"
        accessibilityLabel="Восстановление воспроизведения"
      >
        <View style={styles.contentRow}>
          <Ionicons
            name="sync-outline"
            size={16}
            color="#ffd60a"
            style={styles.icon}
          />
          <Text style={styles.recoveringText} numberOfLines={1}>
            Восстановление воспроизведения...
          </Text>
        </View>
      </View>
    );
  }

  // During startup the header spinner takes precedence over next-track errors.
  if (current?.status === 'starting') return null;

  // 2. Текущий поток завис (stall)
  if (current?.status === 'stalled') {
    const retryHandler = onRetryCurrent || onRetry;
    return (
      <View
        style={[styles.bannerContainer, styles.warningBanner]}
        accessible={true}
        accessibilityRole="alert"
        accessibilityLabel="Воспроизведение приостановлено"
      >
        <View style={styles.contentRow}>
          <Ionicons
            name="alert-circle-outline"
            size={16}
            color="#ff9f0a"
            style={styles.icon}
          />
          <Text style={styles.warningText} numberOfLines={1}>
            Буферизация потока...
          </Text>
        </View>
        {retryHandler && (
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={retryHandler}
              activeOpacity={0.7}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Повторить"
            >
              <Text style={styles.actionText}>Повторить</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  // 3. Ошибка воспроизведения текущего трека (высший приоритет)
  const isCurrentError = current?.status === 'error' || Boolean(current?.error);
  if (isCurrentError) {
    const kind = current?.error?.kind;
    const isRetryable = current?.error?.retryable !== false;
    let message = 'Ошибка воспроизведения';
    if (kind === 'auth') {
      message = 'Ошибка авторизации';
    } else if (kind === 'not_found') {
      message = 'Трек недоступен';
    } else if (kind === 'timeout') {
      message = 'Таймаут воспроизведения';
    } else if (kind === 'transient') {
      message = 'Ошибка сети при воспроизведении';
    }

    const retryHandler = onRetryCurrent || onRetry;

    return (
      <View
        style={[styles.bannerContainer, styles.errorBanner]}
        accessible={true}
        accessibilityRole="alert"
        accessibilityLabel={message}
      >
        <View style={styles.contentRow}>
          <Ionicons
            name="alert-circle-outline"
            size={16}
            color="#ff453a"
            style={styles.icon}
          />
          <Text style={styles.errorText} numberOfLines={1}>
            {message}
          </Text>
        </View>
        <View style={styles.actionsRow}>
          {isRetryable && retryHandler && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={retryHandler}
              activeOpacity={0.7}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Повторить"
            >
              <Text style={styles.actionText}>Повторить</Text>
            </TouchableOpacity>
          )}
          {onSkip && (
            <TouchableOpacity
              style={[styles.actionButton, styles.skipButton]}
              onPress={onSkip}
              activeOpacity={0.7}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Пропустить"
            >
              <Text style={[styles.actionText, styles.skipText]}>
                Пропустить
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  // 4. Ошибка подготовки следующего трека (только если текущий трек исправен)
  const isNextError =
    next?.status === TRACK_STATUS.FAILED ||
    Boolean(next?.error) ||
    nextTrackStatus === TRACK_STATUS.FAILED ||
    (!current && networkStatus === 'error');

  if (isNextError) {
    const nextRetryHandler = onRetryNext || onRetry;
    const message = 'Сбой загрузки следующего трека';

    return (
      <View
        style={[styles.bannerContainer, styles.errorBanner]}
        accessible={true}
        accessibilityRole="alert"
        accessibilityLabel={message}
      >
        <View style={styles.contentRow}>
          <Ionicons
            name="alert-circle-outline"
            size={16}
            color="#ff453a"
            style={styles.icon}
          />
          <Text style={styles.errorText} numberOfLines={1}>
            {message}
          </Text>
        </View>
        <View style={styles.actionsRow}>
          {nextRetryHandler && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={nextRetryHandler}
              activeOpacity={0.7}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Повторить"
            >
              <Text style={styles.actionText}>Повторить</Text>
            </TouchableOpacity>
          )}
          {onSkip && (
            <TouchableOpacity
              style={[styles.actionButton, styles.skipButton]}
              onPress={onSkip}
              activeOpacity={0.7}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Пропустить"
            >
              <Text style={[styles.actionText, styles.skipText]}>
                Пропустить
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  // 5. Медленное сетевое соединение / буферизация
  if (isBufferingSlow) {
    return (
      <View
        style={[styles.bannerContainer, styles.warningBanner]}
        accessible={true}
        accessibilityRole="alert"
        accessibilityLabel="Медленное соединение"
      >
        <View style={styles.contentRow}>
          <Ionicons
            name="cellular-outline"
            size={16}
            color="#ffd60a"
            style={styles.icon}
          />
          <Text style={styles.warningText} numberOfLines={1}>
            Медленное соединение...
          </Text>
        </View>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  bannerContainer: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    marginVertical: 6,
    maxWidth: '92%',
    backdropFilter: 'blur(20px)',
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  icon: {
    marginRight: 7,
  },
  errorBanner: {
    backgroundColor: 'rgba(255, 69, 58, 0.18)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 69, 58, 0.4)',
  },
  errorText: {
    color: '#ff857d',
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 1,
  },
  recoveringBanner: {
    backgroundColor: 'rgba(255, 159, 10, 0.18)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 159, 10, 0.4)',
  },
  recoveringText: {
    color: '#ffd60a',
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 1,
  },
  warningBanner: {
    backgroundColor: 'rgba(255, 159, 10, 0.18)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 159, 10, 0.4)',
  },
  warningText: {
    color: '#ffd60a',
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 1,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 10,
  },
  actionButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 10,
    marginLeft: 6,
  },
  actionText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
  skipButton: {
    backgroundColor: 'rgba(255, 69, 58, 0.25)',
  },
  skipText: {
    color: '#ff9f97',
  },
});
