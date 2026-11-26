import React, { useEffect, useState } from 'react';
import {
  ActionSheetIOS,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { getOfflineSession } from '../../offline';
import {
  readStorageBudget,
  readOfflineWaveStatus,
  subscribeOfflineAvailability,
  setOfflineStorageLimit,
  setWaveReserveTarget,
  setCellularDownloads,
} from '../../offline/availability';
import { formatBytes, reasonText } from '../downloads/DownloadedScreen';
import { useIsFocused } from '@react-navigation/native';
import { t } from '../../shared/storage/settings';
import { SettingsPage, usePageSettings } from './SettingsPage';
import styles from './settingsStyles';

export function OfflineSettingsScreen({ navigation }) {
  const settings = usePageSettings();
  const lang = settings.language;
  const visible = useIsFocused();
  return (
    <SettingsPage
      navigation={navigation}
      lang={lang}
      title={t('offlineTitle', lang)}
    >
      <OfflineSettings
        settings={settings}
        lang={lang}
        accent={settings.accentColor}
        visible={visible}
      />
    </SettingsPage>
  );
}

function StorageUsage({ budget, ru, accent }) {
  const parts = [
    [ru ? 'Треки' : 'Tracks', budget.mediaBytes, accent],
    [ru ? 'Кэш' : 'Cache', budget.cacheBytes, '#86ACDB'],
    [
      ru ? 'Прочее' : 'Other',
      (budget.coverBytes || 0) +
        (budget.lyricsBytes || 0) +
        (budget.transferBytes || 0),
      '#A299BE',
    ],
  ];
  const scale = Math.max(1, budget.limitBytes, budget.usedBytes);
  return (
    <View style={[styles.groupCard, styles.storageSummary]}>
      <Text style={styles.profileUsername}>
        {formatBytes(budget.usedBytes)} / {formatBytes(budget.limitBytes)}
      </Text>
      <View style={styles.storageBar}>
        {parts.map(([label, bytes, color]) =>
          bytes > 0 ? (
            <View
              key={label}
              style={{
                width: `${(100 * bytes) / scale}%`,
                backgroundColor: color,
              }}
            />
          ) : null,
        )}
      </View>
      {parts.map(([label, bytes, color]) => (
        <View key={label} style={styles.legendRow}>
          <View style={[styles.legendDot, { backgroundColor: color }]} />
          <Text style={styles.rowLabel}>{label}</Text>
          <Text style={styles.rowValue}>{formatBytes(bytes)}</Text>
        </View>
      ))}
    </View>
  );
}

export default function OfflineSettings({ settings, lang, accent, visible }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const ru = lang === 'ru',
    tr = (en, russian) => (ru ? russian : en);
  useEffect(() => {
    let alive = true,
      revision = 0;
    const refresh = async () => {
      const token = ++revision,
        session = getOfflineSession();
      if (!session || !visible) {
        if (alive) setStatus(null);
        return;
      }
      try {
        const budget = await readStorageBudget(session);
        const wave = await readOfflineWaveStatus(session, budget);
        if (alive && token === revision)
          setStatus(budget && wave ? { budget, wave } : null);
      } catch (_) {
        if (alive && token === revision) setStatus(null);
      }
    };
    refresh();
    const unsubscribe = subscribeOfflineAvailability(refresh);
    return () => {
      alive = false;
      revision++;
      unsubscribe();
    };
  }, [visible]);
  const run = async (action, value) => {
    try {
      setError('');
      await action(value);
    } catch (_) {
      setError(tr('Could not save setting', 'Не удалось сохранить настройку'));
    }
  };
  const choose = (title, choices, current, action, unit, multiplier = 1) => {
    const values = [...new Set([...choices, current])].sort((a, b) => a - b);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [tr('Cancel', 'Отмена'), ...values.map((v) => `${v} ${unit}`)],
        cancelButtonIndex: 0,
      },
      (index) => {
        if (index > 0) run(action, Math.round(values[index - 1] * multiplier));
      },
    );
  };
  return (
    <>
      {status && (
        <StorageUsage budget={status.budget} ru={ru} accent={accent} />
      )}
      <View style={styles.groupCard}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={tr('Storage limit', 'Лимит памяти')}
          accessibilityValue={{
            text: formatBytes(settings.offlineBudgetBytes),
          }}
          style={styles.rowItem}
          onPress={() =>
            choose(
              tr('Storage limit', 'Лимит памяти'),
              [1, 2, 5, 10, 20],
              settings.offlineBudgetBytes / 1024 ** 3,
              setOfflineStorageLimit,
              'GiB',
              1024 ** 3,
            )
          }
        >
          <Text style={styles.rowLabel}>
            {tr('Storage limit', 'Лимит памяти')}
          </Text>
          <Text style={styles.rowValue}>
            {formatBytes(settings.offlineBudgetBytes)}
          </Text>
        </TouchableOpacity>
        <View style={styles.rowDivider} />
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={tr('Wave reserve target', 'Запас Моей Волны')}
          accessibilityValue={{
            text: `${settings.waveReserveMinutes} ${tr('minutes', 'минут')}`,
          }}
          style={styles.rowItem}
          onPress={() =>
            choose(
              tr('Wave reserve target', 'Запас Моей Волны'),
              [15, 30, 60, 120, 240],
              settings.waveReserveMinutes,
              setWaveReserveTarget,
              tr('min', 'мин'),
            )
          }
        >
          <Text style={styles.rowLabel}>
            {tr('Wave reserve', 'Запас Моей Волны')}
          </Text>
          <Text style={styles.rowValue}>
            {settings.waveReserveMinutes} {tr('min', 'мин')}
          </Text>
        </TouchableOpacity>
        <View style={styles.rowDivider} />
        <View style={styles.rowItem}>
          <Text style={styles.rowLabel}>
            {tr('Cellular downloads', 'Загрузка по сотовой сети')}
          </Text>
          <Switch
            accessibilityLabel={tr(
              'Cellular downloads',
              'Загрузка по сотовой сети',
            )}
            value={Boolean(settings.allowCellularDownloads)}
            onValueChange={(value) => run(setCellularDownloads, value)}
            trackColor={{ false: '#39393d', true: accent }}
          />
        </View>
        {status && (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <Text style={styles.rowValue}>
              {tr('Wave ready', 'Запас Волны')}:{' '}
              {Math.floor(status.wave.readyMinutes)} /{' '}
              {status.wave.targetMinutes} {tr('min', 'мин')}
            </Text>
            {!!reasonText(
              status.budget.pauseReason || status.wave.pauseReason,
              ru,
            ) && (
              <Text style={styles.rowValue}>
                {reasonText(
                  status.budget.pauseReason || status.wave.pauseReason,
                  ru,
                )}
              </Text>
            )}
            {status.budget.overLimitBytes > 0 && (
              <Text style={styles.rowValue}>
                {tr(
                  'Over limit. Change the limit here or remove selected downloads in Library → Downloaded.',
                  'Лимит превышен. Измените его здесь или удалите выбранные загрузки в Библиотека → Скачанное.',
                )}
              </Text>
            )}
          </View>
        )}
        {!status && (
          <Text style={[styles.rowValue, { padding: 16 }]}>
            {tr('Offline status unavailable', 'Статус офлайн недоступен')}
          </Text>
        )}
        {!!error && (
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.rowValue, { padding: 16 }]}
          >
            {error}
          </Text>
        )}
      </View>
    </>
  );
}
