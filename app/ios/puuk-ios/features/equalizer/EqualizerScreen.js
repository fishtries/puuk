import React, { useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import { SettingsPage, usePageSettings } from '../auth/SettingsPage';
import styles from '../auth/settingsStyles';
import { t, updateSetting } from '../../shared/storage/settings';
import {
  applyEqualizer,
  curveFor,
  frequencies,
  nativeEQ,
  normalizeEQ,
} from './equalizer';

const presetNames = {
  flat: ['Flat', 'Ровно'],
  bass: ['Bass boost', 'Больше баса'],
  vocal: ['Vocals', 'Вокал'],
  custom: ['Custom', 'Свой'],
};
const presetIds = Object.keys(presetNames);

export default function EqualizerScreen({ navigation }) {
  const settings = usePageSettings();
  const lang = settings.language;
  const ru = lang === 'ru';
  const accent = settings.accentColor;
  const [eq, setEQ] = useState(() => normalizeEQ(settings.equalizer));
  const latest = useRef(eq);
  const pending = useRef(false);
  const timer = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const gains = curveFor(eq);
  const flush = () => {
    clearTimeout(timer.current);
    if (pending.current) {
      pending.current = false;
      void updateSetting('equalizer', latest.current);
    }
  };
  useEffect(() => flush, []);
  useEffect(() => {
    if (!nativeEQ) return;
    let current = true;
    const sub = nativeEQ.addListener('availability', (event) => {
      current = false;
      setUnavailable(event.unavailable);
    });
    nativeEQ.isUnavailable().then((value) => {
      if (current) setUnavailable(value);
    });
    return () => {
      current = false;
      sub.remove();
    };
  }, []);

  const change = (next, commit = true) => {
    latest.current = next;
    setEQ(next);
    applyEqualizer(next);
    pending.current = true;
    clearTimeout(timer.current);
    if (commit) flush();
    else timer.current = setTimeout(flush, 350);
  };
  const setBand = (band, value) => {
    const current = latest.current;
    const custom = [...curveFor(current)];
    const db = Math.round(value);
    if (db === custom[band]) return;
    custom[band] = db;
    change({ ...current, preset: 'custom', custom }, false);
  };
  const selectPreset = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: ru ? 'Пресет' : 'Preset',
        options: [
          t('cancel', lang),
          ...presetIds.map((id) => presetNames[id][ru ? 1 : 0]),
        ],
        cancelButtonIndex: 0,
      },
      (index) => {
        if (index > 0)
          change({ ...latest.current, preset: presetIds[index - 1] });
      },
    );
  };
  const enabled = !!nativeEQ && eq.enabled;

  return (
    <SettingsPage
      scrollEnabled={!dragging}
      title={t('equalizer', lang)}
      navigation={navigation}
      lang={lang}
    >
      <View style={styles.groupCard}>
        <View style={styles.rowItem}>
          <Text style={styles.rowLabel}>
            {ru ? 'Включить эквалайзер' : 'Enable equalizer'}
          </Text>
          <Switch
            accessibilityLabel={t('equalizer', lang)}
            value={enabled}
            disabled={!nativeEQ}
            onValueChange={(value) =>
              change({ ...latest.current, enabled: value })
            }
            trackColor={{ true: accent, false: '#39393D' }}
          />
        </View>
        <View style={styles.rowDivider} />
        <TouchableOpacity
          style={styles.rowItem}
          accessibilityRole="button"
          onPress={selectPreset}
          disabled={!enabled}
        >
          <Text style={styles.rowLabel}>{ru ? 'Пресет' : 'Preset'}</Text>
          <Text style={styles.rowValue}>
            {presetNames[eq.preset][ru ? 1 : 0]}
          </Text>
          <Ionicons name="chevron-expand" size={16} color="#999" />
        </TouchableOpacity>
      </View>
      <View style={[styles.groupCard, local.bank, !enabled && local.disabled]}>
        {frequencies.map((hz, index) => (
          <View key={hz} style={local.band}>
            <Text style={local.gain}>
              {gains[index] > 0 ? '+' : ''}
              {gains[index]}
            </Text>
            <View style={local.slot}>
              <Slider
                style={local.slider}
                tapToSeek
                minimumValue={-12}
                maximumValue={12}
                step={1}
                value={gains[index]}
                disabled={!enabled}
                minimumTrackTintColor={accent}
                maximumTrackTintColor="#4B4B50"
                accessibilityLabel={`${hz} ${ru ? 'Гц' : 'Hz'}`}
                accessibilityValue={{
                  text: `${gains[index]} ${ru ? 'дБ' : 'dB'}`,
                }}
                onValueChange={(value) => setBand(index, value)}
                onSlidingStart={() => setDragging(true)}
                onSlidingComplete={(value) => {
                  setDragging(false);
                  setBand(index, value);
                  flush();
                }}
              />
            </View>
            <Text style={local.frequency}>
              {hz >= 1000 ? `${hz / 1000}k` : hz}
            </Text>
          </View>
        ))}
      </View>
      {!nativeEQ && (
        <Text style={styles.rowValue}>
          {ru
            ? 'Для эквалайзера нужна обновлённая сборка Puuk.'
            : 'Update to a Puuk build with equalizer support.'}
        </Text>
      )}
      {enabled && unavailable && (
        <Text style={styles.rowValue}>
          {ru
            ? 'Эквалайзер недоступен для этого трека.'
            : 'Equalizer unavailable for this track.'}
        </Text>
      )}
    </SettingsPage>
  );
}

const local = StyleSheet.create({
  bank: { flexDirection: 'row', paddingHorizontal: 4, paddingVertical: 18 },
  band: { flex: 1, alignItems: 'center' },
  slot: {
    width: '100%',
    height: 188,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slider: { width: 170, height: 36, transform: [{ rotate: '-90deg' }] },
  gain: { color: '#FFF', fontSize: 15, fontVariant: ['tabular-nums'] },
  frequency: { color: '#B7B7BC', fontSize: 13 },
  disabled: { opacity: 0.55 },
});
