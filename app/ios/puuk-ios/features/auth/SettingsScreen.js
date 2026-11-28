import React, { useState } from 'react';
import AccentPalette from './AccentPalette';
import { View, Text, TouchableOpacity, Switch, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { updateSetting, t } from '../../shared/storage/settings';
import { clearOrdinaryAudioCache } from '../../offline/availability';
import {
  SettingsPage,
  LanguageRow,
  ServerRow,
  usePageSettings,
} from './SettingsPage';
import styles from './settingsStyles';
const ACCENT_COLORS = [
  { id: 'peach', hex: '#FFDAB9', name: 'Peach', ru: 'Персиковый' },
  { id: 'red', hex: '#FA243C', name: 'Red', ru: 'Красный' },
  { id: 'purple', hex: '#7C5CFC', name: 'Purple', ru: 'Фиолетовый' },
  { id: 'blue', hex: '#007AFF', name: 'Blue', ru: 'Синий' },
];

export default function SettingsScreen({ navigation, currentUser }) {
  const settings = usePageSettings();
  const { language: lang, accentColor: accent } = settings;
  const presetSelected = ACCENT_COLORS.some((color) => color.hex === accent);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [draggingColor, setDraggingColor] = useState(false);
  const closePalette = () => {
    setPaletteOpen(false);
    setDraggingColor(false);
  };
  const saveAccent = (value) => {
    closePalette();
    return updateSetting('accentColor', value);
  };
  const handleClearCache = () => {
    Alert.alert(t('clearCache', lang), t('clearCacheConfirm', lang), [
      { text: t('cancel', lang), style: 'cancel' },
      {
        text: t('clear', lang),
        style: 'destructive',
        onPress: async () => {
          const failureMessage =
            lang === 'ru' ? 'Не удалось очистить кэш' : 'Could not clear cache';
          try {
            const { freedBytes, failedFiles } = await clearOrdinaryAudioCache();
            let message = t('cacheCleared', lang);
            if (failedFiles && freedBytes) {
              message =
                lang === 'ru'
                  ? 'Кэш очищен частично'
                  : 'Cache partially cleared';
            } else if (failedFiles) {
              message = failureMessage;
            }
            Alert.alert(t('clearCache', lang), message);
          } catch {
            Alert.alert(t('clearCache', lang), failureMessage);
          }
        },
      },
    ]);
  };

  return (
    <SettingsPage
      scrollEnabled={!draggingColor}
      navigation={navigation}
      title={t('settingsTitle', lang)}
      lang={lang}
    >
      <TouchableOpacity
        style={styles.profileCard}
        accessibilityRole="button"
        onPress={() => navigation.navigate('Account')}
      >
        <View style={[styles.avatarCircle, { borderColor: accent }]}>
          <Ionicons name="person-outline" size={26} color={accent} />
        </View>
        <Text
          numberOfLines={2}
          style={[styles.profileUsername, styles.profileInfo]}
        >
          {currentUser?.username || t('sectionAccount', lang)}
        </Text>
        <Ionicons name="chevron-forward" size={18} color="#8E8E93" />
      </TouchableOpacity>
      {/* ── 2. Interface & Language Section ── */}
      <Text style={styles.sectionHeader}>
        {t('sectionInterface', lang).toUpperCase()}
      </Text>
      <View style={styles.groupCard}>
        {/* Language Item */}
        <LanguageRow lang={lang} />

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
                accessibilityRole="button"
                accessibilityLabel={lang === 'ru' ? c.ru : c.name}
                accessibilityState={{ selected: accent === c.hex }}
                style={[
                  styles.colorDot,
                  { backgroundColor: c.hex },
                  accent === c.hex && styles.colorDotActive,
                ]}
                onPress={() => saveAccent(c.hex)}
              />
            ))}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('customColor', lang)}
              style={[
                styles.customColor,
                !presetSelected && { backgroundColor: accent },
              ]}
              accessibilityState={{
                expanded: paletteOpen,
                selected: !presetSelected,
              }}
              hitSlop={{ top: 8, bottom: 8, right: 8, left: 3 }}
              onPress={() =>
                paletteOpen ? closePalette() : setPaletteOpen(true)
              }
            >
              <Ionicons
                name="color-palette-outline"
                size={15}
                color={presetSelected ? '#fff' : '#000'}
              />
            </TouchableOpacity>
          </View>
        </View>
        {paletteOpen && (
          <AccentPalette
            accent={accent}
            lang={lang}
            onDrag={setDraggingColor}
            onCancel={closePalette}
            onSave={saveAccent}
          />
        )}
      </View>

      {/* ── 3. Audio & Playback Section ── */}
      <Text style={styles.sectionHeader}>
        {t('sectionAudio', lang).toUpperCase()}
      </Text>
      <View style={styles.groupCard}>
        {/* Sound Check / Normalization */}
        <View style={styles.rowItem}>
          <View style={[styles.rowIconBox, { backgroundColor: '#34C759' }]}>
            <Ionicons name="volume-medium" size={18} color="#fff" />
          </View>
          <Text style={styles.rowLabel}>{t('soundCheck', lang)}</Text>
          <Switch
            accessibilityLabel={t('soundCheck', lang)}
            value={Boolean(settings.soundCheck)}
            onValueChange={(val) => updateSetting('soundCheck', val)}
            trackColor={{ false: '#39393d', true: accent }}
            thumbColor="#fff"
            ios_backgroundColor="#39393d"
          />
        </View>
        <View style={styles.rowDivider} />
        <TouchableOpacity
          accessibilityRole="button"
          style={styles.rowItem}
          onPress={() => navigation.navigate('Equalizer')}
        >
          <View style={[styles.rowIconBox, { backgroundColor: '#536D89' }]}>
            <Ionicons name="options-outline" size={18} color="#fff" />
          </View>
          <Text style={styles.rowLabel}>{t('equalizer', lang)}</Text>
          <Ionicons name="chevron-forward" size={16} color="#8E8E93" />
        </TouchableOpacity>
      </View>

      {/* ── 4. Network & Storage Section ── */}
      <Text style={styles.sectionHeader}>
        {t('sectionNetwork', lang).toUpperCase()}
      </Text>
      <View style={styles.groupCard}>
        <TouchableOpacity
          style={styles.rowItem}
          accessibilityRole="button"
          onPress={() => navigation.navigate('OfflineSettings')}
        >
          <View style={[styles.rowIconBox, { backgroundColor: '#535766' }]}>
            <Ionicons name="download-outline" size={18} color="#fff" />
          </View>
          <Text style={styles.rowLabel}>{t('offlineTitle', lang)}</Text>
          <Ionicons name="chevron-forward" size={16} color="#8E8E93" />
        </TouchableOpacity>
        <View style={styles.rowDivider} />
        <ServerRow lang={lang} />
        <View style={styles.rowDivider} />
        {/* Clear Cache */}
        <TouchableOpacity
          style={styles.rowItem}
          onPress={handleClearCache}
          activeOpacity={0.7}
        >
          <View style={[styles.rowIconBox, { backgroundColor: '#FF3B30' }]}>
            <Ionicons name="trash-outline" size={18} color="#fff" />
          </View>
          <Text style={styles.rowLabel}>{t('clearCache', lang)}</Text>
          <Ionicons name="chevron-forward" size={16} color="#636366" />
        </TouchableOpacity>
      </View>

      <Text style={styles.versionText}>{t('version', lang)}</Text>
    </SettingsPage>
  );
}
