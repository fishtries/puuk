import React from 'react';
import {
  ActivityIndicator,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';

import LoginModal from './LoginModal';

export default function AppAuthGate({
  isChecking,
  currentUser,
  onLoginSuccess,
  restoreError,
  onRetryRestore,
  onLogout,
  accentColor = '#FA243C',
}) {
  if (restoreError && !currentUser) {
    const isServer = restoreError.isServer;
    const title = isServer
      ? 'Сервер временно недоступен'
      : 'Не удалось загрузить профиль';
    const subtitle = isServer
      ? 'Не удалось связаться с сервером Puuk (5xx). Повторите попытку позже.'
      : 'Проверьте подключение к интернету и повторите попытку.';

    return (
      <View style={styles.errorContainer}>
        <StatusBar style="light" />
        <View style={styles.card}>
          <View style={styles.iconWrapper}>
            <Ionicons
              name={isServer ? 'cloud-offline-outline' : 'wifi-outline'}
              size={36}
              color="#E5A93C"
            />
          </View>
          <Text style={styles.errorTitle}>{title}</Text>
          <Text style={styles.errorSubtitle}>{subtitle}</Text>

          {onRetryRestore && (
            <TouchableOpacity
              style={[styles.retryButton, { backgroundColor: accentColor }]}
              onPress={onRetryRestore}
              activeOpacity={0.8}
            >
              <Text style={styles.retryButtonText}>Повторить</Text>
            </TouchableOpacity>
          )}

          {onLogout && (
            <TouchableOpacity
              style={styles.logoutButton}
              onPress={onLogout}
              activeOpacity={0.7}
            >
              <Text style={styles.logoutButtonText}>Войти заново</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  if (isChecking) {
    return (
      <View style={styles.checkingContainer}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color={accentColor || '#FA243C'} />
      </View>
    );
  }

  if (!currentUser) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <StatusBar style="light" />
        <LoginModal
          visible
          mandatory
          onClose={() => {}}
          currentUser={currentUser}
          onLoginSuccess={onLoginSuccess}
        />
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  checkingContainer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorContainer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#161722',
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#242636',
  },
  iconWrapper: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#1F202E',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
    textAlign: 'center',
    marginBottom: 8,
  },
  errorSubtitle: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  retryButton: {
    width: '100%',
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  retryButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
  },
  logoutButton: {
    width: '100%',
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1F202E',
  },
  logoutButtonText: {
    fontSize: 14,
    color: '#8E8E93',
    fontWeight: '500',
  },
});
