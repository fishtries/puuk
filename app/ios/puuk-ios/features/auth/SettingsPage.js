import React, { useEffect, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  getSettings,
  updateSetting,
  addSettingsListener,
  t,
} from '../../shared/storage/settings';
import { setServerUrl } from '../../shared/api/api';
import styles from './settingsStyles';

export function usePageSettings() {
  const [settings, setSettings] = useState(getSettings);
  useEffect(() => addSettingsListener(setSettings), []);
  return settings;
}

export function SettingsPage({
  navigation,
  title,
  lang,
  children,
  scrollEnabled = true,
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      {navigation && (
        <TouchableOpacity
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel={lang === 'ru' ? 'Назад' : 'Back'}
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="chevron-back" size={25} color="#fff" />
        </TouchableOpacity>
      )}
      <ScrollView
        scrollEnabled={scrollEnabled}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom, 20) },
        ]}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <Text accessibilityRole="header" style={styles.pageTitle}>
          {title}
        </Text>
        {children}
      </ScrollView>
    </View>
  );
}

export function ServerRow({ lang }) {
  const { serverUrl } = usePageSettings();
  const handleChangeServerUrl = () => {
    if (Platform.OS === 'ios') {
      Alert.prompt(
        t('serverUrl', lang),
        t('serverUrlPrompt', lang),
        [
          { text: t('cancel', lang), style: 'cancel' },
          {
            text: 'OK',
            onPress: async (url) => {
              if (!url || !url.trim()) return;
              let formatted = url.trim();
              if (
                !formatted.startsWith('http://') &&
                !formatted.startsWith('https://')
              ) {
                formatted = `http://${formatted}`;
              }
              await updateSetting('serverUrl', formatted);
              setServerUrl(formatted);
            },
          },
        ],
        'plain-text',
        serverUrl,
        'url',
      );
    }
  };

  return (
    <TouchableOpacity
      style={styles.rowItem}
      onPress={handleChangeServerUrl}
      activeOpacity={0.7}
    >
      <View style={[styles.rowIconBox, { backgroundColor: '#5AC8FA' }]}>
        <Ionicons name="cloud-outline" size={18} color="#fff" />
      </View>
      <Text style={styles.rowLabel}>{t('serverUrl', lang)}</Text>
      <Text style={[styles.rowValue, { maxWidth: 140 }]} numberOfLines={1}>
        {(serverUrl || '').replace(/^https?:\/\//, '')}
      </Text>
      <Ionicons name="chevron-forward" size={16} color="#636366" />
    </TouchableOpacity>
  );
}

export function LanguageRow({ lang }) {
  const handleChangeLanguage = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [t('cancel', lang), 'English 🇬🇧', 'Русский 🇷🇺'],
        cancelButtonIndex: 0,
        title: t('language', lang),
      },
      async (buttonIndex) => {
        if (buttonIndex === 1) await updateSetting('language', 'en');
        if (buttonIndex === 2) await updateSetting('language', 'ru');
      },
    );
  };

  return (
    <TouchableOpacity
      style={styles.rowItem}
      onPress={handleChangeLanguage}
      activeOpacity={0.7}
    >
      <View style={[styles.rowIconBox, { backgroundColor: '#007AFF' }]}>
        <Ionicons name="globe-outline" size={18} color="#fff" />
      </View>
      <Text style={styles.rowLabel}>{t('language', lang)}</Text>
      <Text style={styles.rowValue}>
        {lang === 'ru' ? 'Русский' : 'English'}
      </Text>
      <Ionicons name="chevron-forward" size={16} color="#636366" />
    </TouchableOpacity>
  );
}
