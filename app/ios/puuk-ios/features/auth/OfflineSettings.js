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
import styles from './loginModalStyles';

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
        const [budget, wave] = await Promise.all([
          readStorageBudget(session),
          readOfflineWaveStatus(session),
        ]);
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
      <Text style={styles.sectionHeader}>{tr('OFFLINE', 'ОФЛАЙН')}</Text>
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
              {tr('On this device', 'На устройстве')}:{' '}
              {formatBytes(status.budget.usedBytes)} /{' '}
              {formatBytes(status.budget.limitBytes)}
            </Text>
            <Text style={styles.rowValue}>
              {tr('Wave ready', 'Волна готово')}:{' '}
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
