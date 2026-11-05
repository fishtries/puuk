import React, { useState } from 'react';
import {
  View,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSyncStatus, syncStateManager } from '../sync/syncState';
import SyncStatusModal from './SyncStatusModal';

export default function SyncHeaderIndicator({
  accentColor = '#FFDAB9',
  syncStatus: propSyncStatus,
  onRetry: propOnRetry,
}) {
  const hookStatus = useSyncStatus();
  const status = propSyncStatus || hookStatus;
  const { isLoading, hasError, isServerUnavailable, isNetworkError, errors } =
    status;

  const [isModalVisible, setIsModalVisible] = useState(false);

  if (!isLoading && !hasError) {
    return null;
  }

  const handlePress = () => {
    if (hasError) {
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      } catch {}
      setIsModalVisible(true);
    }
  };

  const handleRetry = () => {
    if (propOnRetry) {
      propOnRetry();
    } else {
      syncStateManager.retryFailed();
    }
  };

  const accessibleLabel = isLoading
    ? 'Синхронизация данных'
    : isServerUnavailable
      ? 'Сервер недоступен, нажмите для повтора'
      : 'Ошибка синхронизации, нажмите для повтора';

  return (
    <>
      <TouchableOpacity
        style={[styles.container, hasError && styles.containerError]}
        onPress={handlePress}
        disabled={isLoading}
        activeOpacity={hasError ? 0.7 : 1}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityRole={hasError ? 'button' : 'progressbar'}
        accessibilityLabel={accessibleLabel}
        testID="sync-header-indicator"
      >
        {isLoading ? (
          <ActivityIndicator
            size="small"
            color={accentColor || '#FFDAB9'}
            testID="sync-indicator-spinner"
          />
        ) : (
          <Ionicons
            name="cloud-offline-outline"
            size={18}
            color="#E5A93C"
            testID="sync-indicator-error-icon"
          />
        )}
      </TouchableOpacity>

      <SyncStatusModal
        visible={isModalVisible}
        onClose={() => setIsModalVisible(false)}
        onRetry={handleRetry}
        isServerUnavailable={isServerUnavailable}
        isNetworkError={isNetworkError}
        errors={errors}
        accentColor={accentColor}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#161722',
    borderWidth: 1,
    borderColor: '#242636',
    justifyContent: 'center',
    alignItems: 'center',
  },
  containerError: {
    borderColor: 'rgba(229, 169, 60, 0.45)',
    backgroundColor: '#1A1820',
  },
});
