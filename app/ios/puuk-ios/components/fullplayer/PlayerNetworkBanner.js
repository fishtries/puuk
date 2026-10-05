import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { TRACK_STATUS } from '../../utils/preloadScheduler';

/**
 * Компактный ненавязчивый баннер сетевого статуса и подготовки треков.
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

  // 2. Медленный интернет при буферизации
  if (isBufferingSlow || networkStatus === 'slow') {
    return (
      <View style={[styles.bannerContainer, styles.warningBanner]}>
        <View style={styles.contentRow}>
          <Ionicons name="wifi-outline" size={15} color="#ffd60a" style={styles.icon} />
          <Text style={styles.warningText}>Медленное соединение...</Text>
        </View>
      </View>
    );
  }

  // 3. Подготовка следующего трека (фоновая загрузка)
  if (nextTrackStatus === TRACK_STATUS.DOWNLOADING) {
    return (
      <View style={[styles.bannerContainer, styles.infoBanner]}>
        <View style={styles.contentRow}>
          <ActivityIndicator size="small" color="rgba(255, 255, 255, 0.6)" style={styles.spinner} />
          <Text style={styles.infoText}>Подготовка следующего трека...</Text>
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
  spinner: {
    marginRight: 8,
    transform: [{ scale: 0.8 }],
  },
  errorBanner: {
    backgroundColor: 'rgba(255, 69, 58, 0.18)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 69, 58, 0.4)',
  },
  warningBanner: {
    backgroundColor: 'rgba(255, 214, 10, 0.15)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 214, 10, 0.35)',
  },
  infoBanner: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  errorText: {
    color: '#ff857d',
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 1,
  },
  warningText: {
    color: '#ffe66d',
    fontSize: 12,
    fontWeight: '500',
  },
  infoText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 12,
    fontWeight: '400',
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
