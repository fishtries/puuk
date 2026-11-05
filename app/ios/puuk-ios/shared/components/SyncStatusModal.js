import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TouchableWithoutFeedback,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

export default function SyncStatusModal({
  visible,
  onClose,
  onRetry,
  isServerUnavailable,
  isNetworkError,
  errors = [],
  accentColor = '#FFDAB9',
}) {
  if (!visible) return null;

  const handleRetry = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    } catch {}
    if (onRetry) onRetry();
    if (onClose) onClose();
  };

  const title = isServerUnavailable
    ? 'Сервер недоступен'
    : isNetworkError
      ? 'Ошибка подключения'
      : 'Синхронизация данных';

  const message = isServerUnavailable
    ? 'Сервер Puuk временно недоступен (ошибка 5xx). Ваши локальные данные сохранены.'
    : isNetworkError
      ? 'Не удалось установить соединение с сервером. Проверьте подключение к сети.'
      : 'Некоторые данные не удалось обновить из-за ошибки сети.';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
            <View style={styles.card} testID="sync-status-modal-card">
              <View style={styles.iconContainer}>
                <Ionicons
                  name={
                    isServerUnavailable
                      ? 'cloud-offline-outline'
                      : 'wifi-outline'
                  }
                  size={36}
                  color="#E5A93C"
                />
              </View>

              <Text style={styles.title}>{title}</Text>
              <Text style={styles.message}>{message}</Text>

              {errors.length > 1 && (
                <View style={styles.errorsList}>
                  {errors.map(({ id, error }) => (
                    <Text key={id} style={styles.errorItem}>
                      • {error?.message || id}
                    </Text>
                  ))}
                </View>
              )}

              <TouchableOpacity
                style={[styles.retryButton, { backgroundColor: accentColor }]}
                onPress={handleRetry}
                activeOpacity={0.8}
                testID="sync-modal-retry-button"
              >
                <Text style={styles.retryButtonText}>Повторить</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.closeButton}
                onPress={onClose}
                activeOpacity={0.7}
                testID="sync-modal-close-button"
              >
                <Text style={styles.closeButtonText}>Закрыть</Text>
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#161722',
    borderRadius: 22,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#242636',
  },
  iconContainer: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#1F202E',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
    textAlign: 'center',
    marginBottom: 8,
  },
  message: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  errorsList: {
    width: '100%',
    marginBottom: 16,
    paddingHorizontal: 8,
  },
  errorItem: {
    fontSize: 12,
    color: '#E5A93C',
    lineHeight: 18,
  },
  retryButton: {
    width: '100%',
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  retryButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
  },
  closeButton: {
    width: '100%',
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#8E8E93',
  },
});
