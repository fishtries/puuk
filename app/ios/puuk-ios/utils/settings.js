import * as SecureStore from 'expo-secure-store';
import { DeviceEventEmitter } from 'react-native';

const SETTINGS_KEY = 'puuk_app_settings';

export const DEFAULT_SETTINGS = {
  language: 'en', // 'en' | 'ru'
  accentColor: '#FFDAB9',
  audioQuality: 'high', // 'high' (320k) | 'medium' (256k) | 'low' (128k)
  hapticsEnabled: true,
  soundCheck: false,
  crossfade: false,
  serverUrl: 'http://192.168.1.117:8000',
};

let cachedSettings = { ...DEFAULT_SETTINGS };

export const TRANSLATIONS = {
  en: {
    // Header & Profile
    profileTitle: 'Profile & Settings',
    profileSignIn: 'Sign In to Puuk',
    signInPrompt: 'Sign in to sync your favorites and playlists',
    roleAdmin: 'Administrator',
    roleUser: 'User',
    syncedTelegram: 'Synced via Telegram',
    logOut: 'Log Out',
    logOutConfirmTitle: 'Log Out',
    logOutConfirmMsg: 'Are you sure you want to log out of your account?',
    cancel: 'Cancel',

    // Sections
    sectionInterface: 'Interface & Language',
    sectionAudio: 'Audio & Playback',
    sectionNetwork: 'Network & Storage',
    sectionAccount: 'Account',

    // Interface
    language: 'Language',
    languageName: 'English',
    accentColor: 'Accent Color',
    
    // Audio
    audioQuality: 'Audio Quality',
    qualityHigh: 'High (320 kbps)',
    qualityMedium: 'Standard (256 kbps)',
    qualityLow: 'Data Saver (128 kbps)',
    haptics: 'Haptic Feedback',
    soundCheck: 'Sound Check',
    crossfade: 'Crossfade',

    // Network & Storage
    serverUrl: 'Server URL',
    serverUrlPrompt: 'Enter Puuk server URL (e.g. http://192.168.1.117:8000)',
    clearCache: 'Clear Cache',
    cacheCleared: 'Cache has been cleared.',
    clearCacheConfirm: 'Are you sure you want to clear cached covers and temp data?',
    clear: 'Clear',

    // Version
    version: 'Puuk for iOS • v1.0.0',
  },
  ru: {
    // Header & Profile
    profileTitle: 'Профиль и настройки',
    profileSignIn: 'Войти в Puuk',
    signInPrompt: 'Войдите для синхронизации избранного и плейлистов',
    roleAdmin: 'Администратор',
    roleUser: 'Пользователь',
    syncedTelegram: 'Синхронизировано с Telegram',
    logOut: 'Выйти из аккаунта',
    logOutConfirmTitle: 'Выход',
    logOutConfirmMsg: 'Вы уверены, что хотите выйти из аккаунта?',
    cancel: 'Отмена',

    // Sections
    sectionInterface: 'Интерфейс и Язык',
    sectionAudio: 'Воспроизведение и звук',
    sectionNetwork: 'Сеть и Память',
    sectionAccount: 'Аккаунт',

    // Interface
    language: 'Язык приложения',
    languageName: 'Русский',
    accentColor: 'Акцентный цвет',

    // Audio
    audioQuality: 'Качество звука',
    qualityHigh: 'Высокое (320 кбит/с)',
    qualityMedium: 'Стандарт (256 кбит/с)',
    qualityLow: 'Экономия (128 кбит/с)',
    haptics: 'Тактильная отдача',
    soundCheck: 'Выравнивание громкости',
    crossfade: 'Плавный переход',

    // Network & Storage
    serverUrl: 'Адрес сервера',
    serverUrlPrompt: 'Введите адрес сервера Puuk (например, http://192.168.1.117:8000)',
    clearCache: 'Очистить кэш',
    cacheCleared: 'Кэш успешно очищен.',
    clearCacheConfirm: 'Удалить сохраненные обложки и временные файлы?',
    clear: 'Очистить',

    // Version
    version: 'Puuk для iOS • Версия 1.0.0',
  },
};

export const t = (key, lang = cachedSettings.language) => {
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;
  return dict[key] || TRANSLATIONS.en[key] || key;
};

export const getSettings = () => ({ ...cachedSettings });

export const loadSettings = async () => {
  try {
    const raw = await SecureStore.getItemAsync(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      cachedSettings = { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (e) {
    console.warn('[Settings load error]', e);
  }
  return { ...cachedSettings };
};

export const updateSetting = async (key, value) => {
  cachedSettings[key] = value;
  try {
    await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(cachedSettings));
  } catch (e) {
    console.warn('[Settings save error]', e);
  }
  DeviceEventEmitter.emit('PUUK_SETTINGS_CHANGED', { ...cachedSettings, key, value });
  return { ...cachedSettings };
};

export const addSettingsListener = (callback) => {
  const sub = DeviceEventEmitter.addListener('PUUK_SETTINGS_CHANGED', callback);
  return () => sub.remove();
};
