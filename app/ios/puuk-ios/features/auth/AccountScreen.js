import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { loginWithCode, loginWithPassword, logout } from '../../shared/api/api';
import { t } from '../../shared/storage/settings';
import {
  SettingsPage,
  LanguageRow,
  ServerRow,
  usePageSettings,
} from './SettingsPage';
import styles from './settingsStyles';

export default function AccountScreen({
  navigation,
  currentUser,
  onLoginSuccess,
}) {
  const { language: lang, accentColor: accent } = usePageSettings();
  const [tab, setTab] = useState('otp'); // 'otp' | 'password'
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const resetForm = () => {
    setCode('');
    setUsername('');
    setPassword('');
    setErrorMessage('');
    setIsLoading(false);
  };

  const handleLoginOtp = async () => {
    if (!code.trim()) {
      setErrorMessage(
        lang === 'ru'
          ? 'Введите 6-значный код'
          : 'Please enter the 6-digit code',
      );
      return;
    }
    setErrorMessage('');
    setIsLoading(true);
    try {
      const user = await loginWithCode(code);
      resetForm();
      if (onLoginSuccess) onLoginSuccess(user);
      navigation?.goBack();
    } catch (e) {
      setErrorMessage(
        e.message ||
          (lang === 'ru'
            ? 'Ошибка входа по коду'
            : 'Failed to sign in with code'),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoginPassword = async () => {
    if (!username.trim() || !password) {
      setErrorMessage(
        lang === 'ru'
          ? 'Введите логин и пароль'
          : 'Enter username and password',
      );
      return;
    }
    setErrorMessage('');
    setIsLoading(true);
    try {
      const user = await loginWithPassword(username.trim(), password);
      resetForm();
      if (onLoginSuccess) onLoginSuccess(user);
      navigation?.goBack();
    } catch (e) {
      setErrorMessage(
        e.message ||
          (lang === 'ru'
            ? 'Неверный логин или пароль'
            : 'Invalid username or password'),
      );
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
        },
      },
    ]);
  };

  const isAuthenticated = currentUser?.is_authenticated;
  return (
    <SettingsPage
      title={t(isAuthenticated ? 'sectionAccount' : 'profileSignIn', lang)}
      navigation={navigation}
      lang={lang}
    >
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
                  {currentUser.role === 'admin'
                    ? t('roleAdmin', lang)
                    : t('roleUser', lang)}
                </Text>
              </View>
              <View style={styles.syncBadge}>
                <Ionicons
                  name="checkmark-circle"
                  size={14}
                  color="#34C759"
                  style={{ marginRight: 4 }}
                />
                <Text style={styles.syncText}>{t('syncedTelegram', lang)}</Text>
              </View>
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.unauthCard}>
          <View style={styles.segmentedControl}>
            <TouchableOpacity
              style={[
                styles.segmentBtn,
                tab === 'otp' && styles.segmentBtnActive,
              ]}
              onPress={() => {
                setTab('otp');
                setErrorMessage('');
              }}
            >
              <Text
                style={[
                  styles.segmentText,
                  tab === 'otp' && styles.segmentTextActive,
                ]}
              >
                Telegram OTP
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.segmentBtn,
                tab === 'password' && styles.segmentBtnActive,
              ]}
              onPress={() => {
                setTab('password');
                setErrorMessage('');
              }}
            >
              <Text
                style={[
                  styles.segmentText,
                  tab === 'password' && styles.segmentTextActive,
                ]}
              >
                {lang === 'ru' ? 'Пароль' : 'Password'}
              </Text>
            </TouchableOpacity>
          </View>

          {Boolean(errorMessage) && (
            <View style={styles.errorBox}>
              <Ionicons
                name="alert-circle"
                size={16}
                color="#FF453A"
                style={{ marginRight: 6 }}
              />
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
                style={[
                  styles.actionBtn,
                  { backgroundColor: accent },
                  isLoading && styles.actionBtnDisabled,
                ]}
                onPress={handleLoginOtp}
                disabled={isLoading}
              >
                {isLoading ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={styles.actionBtnText}>
                    {lang === 'ru' ? 'Войти по коду' : 'Sign In with Code'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.tabBody}>
              <TextInput
                style={styles.input}
                placeholder={lang === 'ru' ? 'Имя пользователя' : 'Username'}
                placeholderTextColor="#666"
                autoCapitalize="none"
                value={username}
                onChangeText={setUsername}
              />
              <TextInput
                style={[styles.input, { marginTop: 10 }]}
                placeholder={lang === 'ru' ? 'Пароль' : 'Password'}
                placeholderTextColor="#666"
                secureTextEntry={true}
                value={password}
                onChangeText={setPassword}
              />
              <TouchableOpacity
                style={[
                  styles.actionBtn,
                  { backgroundColor: accent },
                  isLoading && styles.actionBtnDisabled,
                ]}
                onPress={handleLoginPassword}
                disabled={isLoading}
              >
                {isLoading ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={styles.actionBtnText}>
                    {lang === 'ru'
                      ? 'Войти с паролем'
                      : 'Sign In with Password'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {isAuthenticated && (
        <View style={[styles.groupCard, { marginTop: 12 }]}>
          <TouchableOpacity
            style={styles.rowItem}
            onPress={handleLogout}
            activeOpacity={0.7}
          >
            <View style={[styles.rowIconBox, { backgroundColor: '#FF453A' }]}>
              <Ionicons name="log-out-outline" size={18} color="#fff" />
            </View>
            <Text style={[styles.rowLabel, { color: '#FF453A' }]}>
              {t('logOut', lang)}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {!navigation && (
        <View style={styles.groupCard}>
          <LanguageRow lang={lang} />
          <View style={styles.rowDivider} />
          <ServerRow lang={lang} />
        </View>
      )}
    </SettingsPage>
  );
}
