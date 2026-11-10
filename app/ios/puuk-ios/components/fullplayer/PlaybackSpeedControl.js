import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Slider from '@react-native-community/slider';
import {
  MIN_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE,
  PLAYBACK_RATE_STEP,
  normalizePlaybackRate,
} from '../../utils/playbackSpeed';

const formatRate = (rate) => `${Number(rate.toFixed(3))}×`;

export default function PlaybackSpeedControl({ rate, onChange, onOpen }) {
  const [visible, setVisible] = useState(false);
  const [displayRate, setDisplayRate] = useState(rate);
  const latestRate = useRef(rate);
  useEffect(() => {
    latestRate.current = rate;
    setDisplayRate(rate);
  }, [rate]);

  const changeRate = (value, commit = true) => {
    const next = normalizePlaybackRate(value);
    if (next === null) return;
    latestRate.current = next;
    setDisplayRate(next);
    if (commit) onChange(next);
    else onChange(next, { commit: false });
  };
  const close = () => {
    onChange(latestRate.current);
    setVisible(false);
  };
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Скорость воспроизведения ${formatRate(displayRate)}`}
        onPress={() => {
          onOpen?.();
          setVisible(true);
        }}
        style={({ pressed }) => [
          styles.button,
          displayRate !== 1 && styles.active,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.buttonText}>{formatRate(displayRate)}</Text>
      </Pressable>
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={close}
      >
        <View style={styles.overlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={close}
            accessibilityLabel="Закрыть настройку скорости"
            accessibilityRole="button"
          />
          <View style={styles.panel} accessibilityViewIsModal>
            <View style={styles.heading}>
              <Text style={styles.title}>Скорость</Text>
              <Pressable
                onPress={close}
                style={styles.button}
                accessibilityRole="button"
                accessibilityLabel="Готово"
              >
                <Text style={styles.buttonText}>Готово</Text>
              </Pressable>
            </View>
            <Text style={styles.value}>{formatRate(displayRate)}</Text>
            <Text style={styles.description}>
              Медленнее — звук ниже, быстрее — выше
            </Text>
            <Slider
              accessibilityLabel="Скорость воспроизведения"
              accessibilityValue={{
                min: MIN_PLAYBACK_RATE,
                max: MAX_PLAYBACK_RATE,
                now: displayRate,
                text: formatRate(displayRate),
              }}
              minimumValue={MIN_PLAYBACK_RATE}
              maximumValue={MAX_PLAYBACK_RATE}
              step={PLAYBACK_RATE_STEP}
              value={displayRate}
              onValueChange={(value) => changeRate(value, false)}
              onSlidingComplete={(value) => changeRate(value)}
              minimumTrackTintColor="#ffffff"
              maximumTrackTintColor="#68686d"
              thumbTintColor="#ffffff"
              style={styles.slider}
            />
            <View style={styles.actions}>
              <Pressable
                style={styles.button}
                onPress={() =>
                  changeRate(latestRate.current - PLAYBACK_RATE_STEP)
                }
                disabled={displayRate <= MIN_PLAYBACK_RATE}
                accessibilityRole="button"
                accessibilityLabel="Замедлить на 0,005"
                accessibilityState={{
                  disabled: displayRate <= MIN_PLAYBACK_RATE,
                }}
              >
                <Text
                  style={[
                    styles.buttonText,
                    displayRate <= MIN_PLAYBACK_RATE && styles.disabled,
                  ]}
                >
                  −0.005
                </Text>
              </Pressable>
              <Pressable
                style={styles.button}
                onPress={() => changeRate(1)}
                accessibilityRole="button"
                accessibilityLabel="Обычная скорость 1×"
              >
                <Text style={styles.buttonText}>Сбросить · 1×</Text>
              </Pressable>
              <Pressable
                style={styles.button}
                onPress={() =>
                  changeRate(latestRate.current + PLAYBACK_RATE_STEP)
                }
                disabled={displayRate >= MAX_PLAYBACK_RATE}
                accessibilityRole="button"
                accessibilityLabel="Ускорить на 0,005"
                accessibilityState={{
                  disabled: displayRate >= MAX_PLAYBACK_RATE,
                }}
              >
                <Text
                  style={[
                    styles.buttonText,
                    displayRate >= MAX_PLAYBACK_RATE && styles.disabled,
                  ]}
                >
                  +0.005
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  active: { backgroundColor: 'rgba(255,255,255,0.15)' },
  pressed: { opacity: 0.6 },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  panel: { borderRadius: 24, backgroundColor: '#242426', padding: 20 },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { color: '#ffffff', fontSize: 22, fontWeight: '600' },
  value: {
    color: '#ffffff',
    textAlign: 'center',
    fontSize: 40,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    marginTop: 12,
  },
  description: {
    color: '#c7c7cc',
    textAlign: 'center',
    fontSize: 14,
    marginTop: 8,
  },
  slider: { width: '100%', height: 48, marginTop: 16 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
  },
  disabled: { opacity: 0.35 },
});
