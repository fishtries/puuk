import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
  Keyboard,
  Alert,
  ActionSheetIOS,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { loginWithCode, loginWithPassword, logout, setServerUrl } from '../utils/api';
import {
  getSettings,
  updateSetting,
  addSettingsListener,
  t,
} from '../utils/settings';

const ACCENT_COLORS = [
  { id: 'peach', hex: '#FFDAB9', name: 'Peach' },
  { id: 'red', hex: '#FA243C', name: 'Red' },
  { id: 'purple', hex: '#7C5CFC', name: 'Purple' },
  { id: 'blue', hex: '#007AFF', name: 'Blue' },
];

export default function LoginModal({ visible, onClose, currentUser, onLoginSuccess }) {
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState(getSettings());
  const [showLoginForm, setShowLoginForm] = useState(false);
  const [tab, setTab] = useState('otp'); // 'otp' | 'password'
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const unsub = addSettingsListener((newSettings) => {
      setSettings({ ...newSettings });
    });
    return unsub;
  }, []);

  const lang = settings.language || 'en';
  const accent = settings.accentColor || '#FFDAB9';

  const resetForm = () => {
    setCode('');
    setUsername('');
    setPassword('');
    setErrorMessage('');
    setIsLoading(false);
    setShowLoginForm(false);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleLoginOtp = async () => {
    if (!code.trim()) {
      setErrorMessage(lang === 'ru' ? 'Введите 6-значный код' : 'Please enter the 6-digit code');
      return;
    }
    setErrorMessage('');
    setIsLoading(true);
    try {
      const user = await loginWithCode(code);
      resetForm();
      if (onLoginSuccess) onLoginSuccess(user);
      onClose();
    } catch (e) {
      setErrorMessage(e.message || (lang === 'ru' ? 'Ошибка входа по коду' : 'Failed to sign in with code'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoginPassword = async () => {
    if (!username.trim() || !password) {
      setErrorMessage(lang === 'ru' ? 'Введите логин и пароль' : 'Enter username and password');
      return;
    }
    setErrorMessage('');
    setIsLoading(true);
    try {
      const user = await loginWithPassword(username.trim(), password);
      resetForm();
      if (onLoginSuccess) onLoginSuccess(user);
      onClose();
    } catch (e) {
      setErrorMessage(e.message || (lang === 'ru' ? 'Неверный логин или пароль' : 'Invalid username or password'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    Alert.alert(t('logOutConfirmTitle', lang), t('logOutConfirmMsg', lang), [
      { text: t('cancel', lang), style: 'cancel' },
      {
        text: t('logOut', lang),
        style: 'destructive',
        onPress: async () => {
          await logout();
          if (onLoginSuccess) onLoginSuccess(null);
          onClose();
        },
      },
    ]);
  };

  // --- Setting Actions ---
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
      }
    );
  };

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
              if (!formatted.startsWith('http://') && !formatted.startsWith('https://')) {
                formatted = `http://${formatted}`;
              }
              await updateSetting('serverUrl', formatted);
              setServerUrl(formatted);
            },
          },
        ],
        'plain-text',
        settings.serverUrl,
        'url'
      );
    }
  };

  const handleClearCache = () => {
    Alert.alert(t('clearCache', lang), t('clearCacheConfirm', lang), [
      { text: t('cancel', lang), style: 'cancel' },
      {
        text: t('clear', lang),
        style: 'destructive',
        onPress: () => {
          Alert.alert(t('clearCache', lang), t('cacheCleared', lang));
        },
      },
    ]);
  };

  const isAuthenticated = currentUser?.is_authenticated;

  return (
    <Modal visible={visible} animationType="slide" transparent={true} onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <BlurView intensity={35} tint="dark" style={StyleSheet.absoluteFill} />

        {/* Dismiss modal when tapping outside the sheet */}
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={handleClose}
        />

        <View style={styles.card}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>{t('profileTitle', lang)}</Text>
            <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
              <Ionicons name="close" size={20} color="#8E8E93" />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={[
              styles.scrollContent,
              { paddingBottom: Math.max(insets.bottom, 24) + 16 },
            ]}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets={true}
          >
                {/* ── 1. Profile / Sign In Section ── */}
                {isAuthenticated ? (
                  <View style={styles.profileCard}>
                    <View style={[styles.avatarCircle, { borderColor: accent }]}>
                      <Ionicons name="person" size={34} color={accent} />
                    </View>
                    <View style={styles.profileInfo}>
                      <Text style={styles.profileUsername}>{currentUser.username}</Text>
                      <View style={styles.badgeRow}>
                        <View style={styles.roleBadge}>
                          <Text style={styles.roleText}>
                            {currentUser.role === 'admin' ? t('roleAdmin', lang) : t('roleUser', lang)}
                          </Text>
                        </View>
                        <View style={styles.syncBadge}>
                          <Ionicons name="checkmark-circle" size={14} color="#34C759" style={{ marginRight: 4 }} />
                          <Text style={styles.syncText}>{t('syncedTelegram', lang)}</Text>
                        </View>
                      </View>
                    </View>
                  </View>
                ) : (
                  <View style={styles.unauthCard}>
                    <View style={styles.unauthHeader}>
                      <View style={styles.unauthIcon}>
                        <Ionicons name="person-circle-outline" size={36} color={accent} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.unauthTitle}>{t('profileSignIn', lang)}</Text>
                        <Text style={styles.unauthHint}>{t('signInPrompt', lang)}</Text>
                      </View>
                    </View>

                    <TouchableOpacity
                      style={[styles.signInTriggerBtn, { backgroundColor: accent }]}
                      onPress={() => setShowLoginForm(!showLoginForm)}
                      activeOpacity={0.8}
                    >
                      <Ionicons
                        name={showLoginForm ? 'chevron-up' : 'log-in-outline'}
                        size={18}
                        color="#000"
                        style={{ marginRight: 6 }}
                      />
                      <Text style={styles.signInTriggerText}>
                        {showLoginForm ? (lang === 'ru' ? 'Скрыть вход' : 'Hide Login') : (lang === 'ru' ? 'Войти' : 'Sign In')}
                      </Text>
                    </TouchableOpacity>

                    {/* Collapsible Login Form */}
                    {showLoginForm && (
                      <View style={styles.formContainer}>
                        <View style={styles.segmentedControl}>
                          <TouchableOpacity
                            style={[styles.segmentBtn, tab === 'otp' && styles.segmentBtnActive]}
                            onPress={() => {
                              setTab('otp');
                              setErrorMessage('');
                            }}
                          >
                            <Text style={[styles.segmentText, tab === 'otp' && styles.segmentTextActive]}>
                              Telegram OTP
                            </Text>
                          </TouchableOpacity>

                          <TouchableOpacity
                            style={[styles.segmentBtn, tab === 'password' && styles.segmentBtnActive]}
                            onPress={() => {
                              setTab('password');
                              setErrorMessage('');
                            }}
                          >
                            <Text style={[styles.segmentText, tab === 'password' && styles.segmentTextActive]}>
                              Password
                            </Text>
                          </TouchableOpacity>
                        </View>

                        {Boolean(errorMessage) && (
                          <View style={styles.errorBox}>
                            <Ionicons name="alert-circle" size={16} color="#FF453A" style={{ marginRight: 6 }} />
                            <Text style={styles.errorText}>{errorMessage}</Text>
                          </View>
                        )}

                        {tab === 'otp' ? (
                          <View style={styles.tabBody}>
                            <Text style={styles.hintText}>
                              {lang === 'ru'
                                ? 'Нажмите "🔑 Login Code" в Telegram-боте Puuk, чтобы получить 6-значный код.'
                                : 'Press "🔑 Login Code" in Puuk Telegram bot to receive a 6-digit code.'}
                            </Text>
                            <TextInput
                              style={styles.input}
                              placeholder="000000"
                              placeholderTextColor="#666"
                              keyboardType="number-pad"
                              maxLength={6}
                              value={code}
                              onChangeText={setCode}
                            />
                            <TouchableOpacity
                              style={[styles.actionBtn, { backgroundColor: accent }, isLoading && styles.actionBtnDisabled]}
                              onPress={handleLoginOtp}
                              disabled={isLoading}
                            >
                              {isLoading ? (
                                <ActivityIndicator color="#000" />
                              ) : (
                                <Text style={styles.actionBtnText}>{lang === 'ru' ? 'Войти по коду' : 'Sign In with Code'}</Text>
                              )}
                            </TouchableOpacity>
                          </View>
                        ) : (
                          <View style={styles.tabBody}>
                            <TextInput
                              style={styles.input}
                              placeholder="Username"
                              placeholderTextColor="#666"
                              autoCapitalize="none"
                              value={username}
                              onChangeText={setUsername}
                            />
                            <TextInput
                              style={[styles.input, { marginTop: 10 }]}
                              placeholder="Password"
                              placeholderTextColor="#666"
                              secureTextEntry={true}
                              value={password}
                              onChangeText={setPassword}
                            />
                            <TouchableOpacity
                              style={[styles.actionBtn, { backgroundColor: accent }, isLoading && styles.actionBtnDisabled]}
                              onPress={handleLoginPassword}
                              disabled={isLoading}
                            >
                              {isLoading ? (
                                <ActivityIndicator color="#000" />
                              ) : (
                                <Text style={styles.actionBtnText}>{lang === 'ru' ? 'Войти с паролем' : 'Sign In with Password'}</Text>
                              )}
                            </TouchableOpacity>
                          </View>
                        )}
                      </View>
                    )}
                  </View>
                )}

                {/* ── 2. Interface & Language Section ── */}
                <Text style={styles.sectionHeader}>{t('sectionInterface', lang).toUpperCase()}</Text>
                <View style={styles.groupCard}>
                  {/* Language Item */}
                  <TouchableOpacity style={styles.rowItem} onPress={handleChangeLanguage} activeOpacity={0.7}>
                    <View style={[styles.rowIconBox, { backgroundColor: '#007AFF' }]}>
                      <Ionicons name="globe-outline" size={18} color="#fff" />
                    </View>
                    <Text style={styles.rowLabel}>{t('language', lang)}</Text>
                    <Text style={styles.rowValue}>{lang === 'ru' ? 'Русский' : 'English'}</Text>
                    <Ionicons name="chevron-forward" size={16} color="#636366" />
                  </TouchableOpacity>

                  <View style={styles.rowDivider} />

                  {/* Accent Color Item */}
                  <View style={styles.rowItem}>
                    <View style={[styles.rowIconBox, { backgroundColor: '#FF9500' }]}>
                      <Ionicons name="color-palette-outline" size={18} color="#fff" />
                    </View>
                    <Text style={styles.rowLabel}>{t('accentColor', lang)}</Text>
                    <View style={styles.colorPalette}>
                      {ACCENT_COLORS.map((c) => (
                        <TouchableOpacity
                          key={c.id}
                          style={[
                            styles.colorDot,
                            { backgroundColor: c.hex },
                            accent === c.hex && styles.colorDotActive,
                          ]}
                          onPress={() => updateSetting('accentColor', c.hex)}
                        />
                      ))}
                    </View>
                  </View>
                </View>

                {/* ── 3. Network & Storage Section ── */}
                <Text style={styles.sectionHeader}>{t('sectionNetwork', lang).toUpperCase()}</Text>
                <View style={styles.groupCard}>
                  {/* Server URL */}
                  <TouchableOpacity style={styles.rowItem} onPress={handleChangeServerUrl} activeOpacity={0.7}>
                    <View style={[styles.rowIconBox, { backgroundColor: '#5AC8FA' }]}>
                      <Ionicons name="cloud-outline" size={18} color="#fff" />
                    </View>
                    <Text style={styles.rowLabel}>{t('serverUrl', lang)}</Text>
                    <Text style={[styles.rowValue, { maxWidth: 140 }]} numberOfLines={1}>
                      {settings.serverUrl.replace(/^https?:\/\//, '')}
                    </Text>
                    <Ionicons name="chevron-forward" size={16} color="#636366" />
                  </TouchableOpacity>

                  <View style={styles.rowDivider} />

                  {/* Clear Cache */}
                  <TouchableOpacity style={styles.rowItem} onPress={handleClearCache} activeOpacity={0.7}>
                    <View style={[styles.rowIconBox, { backgroundColor: '#FF3B30' }]}>
                      <Ionicons name="trash-outline" size={18} color="#fff" />
                    </View>
                    <Text style={styles.rowLabel}>{t('clearCache', lang)}</Text>
                    <Ionicons name="chevron-forward" size={16} color="#636366" />
                  </TouchableOpacity>
                </View>

                {/* ── 4. Account Action (if authenticated) ── */}
                {isAuthenticated && (
                  <View style={[styles.groupCard, { marginTop: 12 }]}>
                    <TouchableOpacity style={styles.rowItem} onPress={handleLogout} activeOpacity={0.7}>
                      <View style={[styles.rowIconBox, { backgroundColor: '#FF453A' }]}>
                        <Ionicons name="log-out-outline" size={18} color="#fff" />
                      </View>
                      <Text style={[styles.rowLabel, { color: '#FF453A' }]}>{t('logOut', lang)}</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* ── Footer ── */}
                <Text style={styles.versionText}>{t('version', lang)}</Text>
              </ScrollView>
            </View>
          </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: '#000000',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    paddingTop: 18,
    paddingHorizontal: 20,
    maxHeight: '88%',
    width: '100%',
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 0,
    borderColor: '#242426',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
    paddingHorizontal: 4,
  },
  title: {
    color: '#FFF',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  closeButton: {
    padding: 6,
    borderRadius: 16,
    backgroundColor: '#1C1C1E',
  },
  scrollView: {
    width: '100%',
  },
  scrollContent: {
    paddingBottom: Platform.OS === 'ios' ? 44 : 24,
  },

  // ── Profile Card ──
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#2C2C2E',
  },
  avatarCircle: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#2C2C2E',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
    borderWidth: 2,
  },
  profileInfo: {
    flex: 1,
  },
  profileUsername: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  roleBadge: {
    backgroundColor: '#2C2C2E',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  roleText: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '600',
  },
  syncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  syncText: {
    color: '#34C759',
    fontSize: 11,
    fontWeight: '500',
  },

  // ── Unauthenticated Card ──
  unauthCard: {
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#2C2C2E',
  },
  unauthHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  unauthIcon: {
    marginRight: 12,
  },
  unauthTitle: {
    color: '#FFF',
    fontSize: 17,
    fontWeight: '700',
  },
  unauthHint: {
    color: '#8E8E93',
    fontSize: 13,
    marginTop: 2,
  },
  signInTriggerBtn: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 12,
  },
  signInTriggerText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '700',
  },

  // ── Login Form ──
  formContainer: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2C2C2E',
  },
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: '#121214',
    borderRadius: 12,
    padding: 3,
    marginBottom: 14,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 9,
  },
  segmentBtnActive: {
    backgroundColor: '#2C2C2E',
  },
  segmentText: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: '#FFF',
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 69, 58, 0.15)',
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  errorText: {
    color: '#FF453A',
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  tabBody: {
    gap: 10,
  },
  hintText: {
    color: '#8E8E93',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 4,
  },
  input: {
    backgroundColor: '#1C1C1E',
    color: '#FFF',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#2C2C2E',
  },
  actionBtn: {
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 6,
  },
  actionBtnDisabled: {
    opacity: 0.6,
  },
  actionBtnText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '700',
  },

  // ── Settings Sections (iOS Inset Grouped) ──
  sectionHeader: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginLeft: 6,
    marginTop: 4,
  },
  groupCard: {
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    paddingHorizontal: 14,
    marginBottom: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#2C2C2E',
  },
  rowItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    marginLeft: 40,
  },
  rowIconBox: {
    width: 28,
    height: 28,
    borderRadius: 7,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  rowLabel: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '500',
    flex: 1,
  },
  rowValue: {
    color: '#8E8E93',
    fontSize: 14,
    marginRight: 6,
  },

  // ── Color Palette ──
  colorPalette: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  colorDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  colorDotActive: {
    borderWidth: 2.5,
    borderColor: '#FFF',
    transform: [{ scale: 1.15 }],
  },

  // ── Version Footer ──
  versionText: {
    color: '#636366',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 8,
  },
});
