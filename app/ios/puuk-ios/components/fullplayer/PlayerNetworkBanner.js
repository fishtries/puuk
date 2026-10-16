import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { TRACK_STATUS } from '../../utils/preloadScheduler';

/**
 * Компактный ненавязчивый баннер сетевого статуса и ошибок подготовки треков.
 * Не прерывает текущий трек, заменяет спам модальных Alert'ов.
 */
export default function PlayerNetworkBanner({
  networkStatus = 'good',
  nextTrackStatus = TRACK_STATUS.IDLE,
  networkError = null,
  isBufferingSlow = false,
  onRetry,
  onSkip,
}) {
  // 1. Ошибка подготовки следующего трека
  if (networkStatus === 'error' || nextTrackStatus === TRACK_STATUS.FAILED) {
    return (
      <View style={[styles.bannerContainer, styles.errorBanner]}>
        <View style={styles.contentRow}>
          <Ionicons name="alert-circle-outline" size={16} color="#ff453a" style={styles.icon} />
          <Text style={styles.errorText} numberOfLines={1}>
            {networkError || 'Сбой загрузки следующего трека'}
          </Text>
        </View>
        <View style={styles.actionsRow}>
          {onRetry && (
            <TouchableOpacity style={styles.actionButton} onPress={onRetry} activeOpacity={0.7}>
              <Text style={styles.actionText}>Повторить</Text>
            </TouchableOpacity>
          )}
          {onSkip && (
            <TouchableOpacity style={[styles.actionButton, styles.skipButton]} onPress={onSkip} activeOpacity={0.7}>
              <Text style={[styles.actionText, styles.skipText]}>Пропустить</Text>
            </TouchableOpacity>
          )}
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
