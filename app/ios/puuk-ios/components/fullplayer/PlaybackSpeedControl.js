import React, { useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import Animated, {
  ReduceMotion,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {
  MIN_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE,
  PLAYBACK_RATE_STEP,
  normalizePlaybackRate,
} from '../../utils/playbackSpeed';

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 104;

const formatRate = (rate) => `${Number(rate.toFixed(3))}×`;

const PlaybackSpeedControl = React.memo(function PlaybackSpeedControl({
  rate,
  onChange,
  onOpen,
  onVisibilityChange,
}) {
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const mountedRef = useRef(true);
  const [displayRate, setDisplayRate] = useState(rate);
  const latestRate = useRef(rate);
  const buttonRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  const popoverProgress = useSharedValue(0);
  const popoverOpacity = useSharedValue(0);
  const popoverStyle = useAnimatedStyle(() => ({
    opacity: popoverOpacity.value,
    transform: [
      {
        translateY:
          (1 - popoverProgress.value) *
          (anchor?.y >= PANEL_HEIGHT + 20 ? 6 : -6),
      },
      { scale: 0.94 + 0.06 * popoverProgress.value },
    ],
  }));
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    onVisibilityChange?.(visible);
    if (visible) return () => onVisibilityChange?.(false);
  }, [visible, onVisibilityChange]);
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
  const finishClose = () => {
    if (!mountedRef.current) return;
    setVisible(false);
    setClosing(false);
    closingRef.current = false;
  };
  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    onChange(latestRate.current);
    runOnUI(() => {
      'worklet';
      popoverProgress.value = withTiming(0, {
        duration: 150,
        reduceMotion: ReduceMotion.System,
      });
      popoverOpacity.value = withTiming(
        0,
        { duration: 150, reduceMotion: ReduceMotion.System },
        (finished) => {
          if (finished) runOnJS(finishClose)();
        },
      );
    })();
  };
  const panelWidth = Math.min(PANEL_WIDTH, Dimensions.get('window').width - 24);
  return (
    <>
      <View ref={buttonRef} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Скорость воспроизведения ${formatRate(displayRate)}`}
          onPress={() => {
            onOpen?.();
            buttonRef.current?.measureInWindow((x, y, width, height) => {
              setAnchor({ x, y, width, height });
              setVisible(true);
            });
          }}
          style={({ pressed }) => [
            styles.button,
            displayRate !== 1 && styles.active,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.buttonText}>{formatRate(displayRate)}</Text>
        </Pressable>
      </View>
      {visible && (
        <Modal
          visible={visible}
          transparent
          animationType="none"
          onShow={() => {
            if (closingRef.current) return;
            runOnUI(() => {
              'worklet';
              popoverProgress.value = 0;
              popoverOpacity.value = 0;
              popoverProgress.value = withSpring(1, {
                stiffness: 350,
                damping: 21,
                mass: 0.7,
                reduceMotion: ReduceMotion.System,
              });
              popoverOpacity.value = withTiming(1, {
                duration: 120,
                reduceMotion: ReduceMotion.System,
              });
            })();
          }}
          onRequestClose={close}
        >
          <View style={styles.overlay}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={close}
              disabled={closing}
              accessibilityLabel="Закрыть настройку скорости"
              accessibilityRole="button"
            />
            <Animated.View
              style={[
                styles.panel,
                {
                  width: panelWidth,
                  left: Math.max(
                    12,
                    Math.min(
                      anchor.x + anchor.width / 2 - panelWidth / 2,
                      Dimensions.get('window').width - panelWidth - 12,
                    ),
                  ),
                  top:
                    anchor.y >= PANEL_HEIGHT + 20
                      ? anchor.y - PANEL_HEIGHT - 8
                      : anchor.y + anchor.height + 8,
                },
                popoverStyle,
              ]}
              accessibilityViewIsModal
              pointerEvents={closing ? 'none' : 'auto'}
            >
              <View style={styles.heading}>
                <Pressable
                  onPress={() =>
                    changeRate(latestRate.current - PLAYBACK_RATE_STEP)
                  }
                  disabled={displayRate <= MIN_PLAYBACK_RATE}
                  accessibilityRole="button"
                  accessibilityLabel="Замедлить на 0,005"
                  accessibilityState={{
                    disabled: displayRate <= MIN_PLAYBACK_RATE,
                  }}
                  style={({ pressed }) => [
                    styles.stepButton,
                    (pressed || displayRate <= MIN_PLAYBACK_RATE) &&
                      styles.stepDimmed,
                  ]}
                >
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Pressable
                  onPress={() => changeRate(1)}
                  accessibilityRole="button"
                  accessibilityLabel={`Скорость ${formatRate(displayRate)}. Сбросить до 1×`}
                  style={styles.valueButton}
                >
                  <Text style={styles.value}>{formatRate(displayRate)}</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    changeRate(latestRate.current + PLAYBACK_RATE_STEP)
                  }
                  disabled={displayRate >= MAX_PLAYBACK_RATE}
                  accessibilityRole="button"
                  accessibilityLabel="Ускорить на 0,005"
                  accessibilityState={{
                    disabled: displayRate >= MAX_PLAYBACK_RATE,
                  }}
                  style={({ pressed }) => [
                    styles.stepButton,
                    (pressed || displayRate >= MAX_PLAYBACK_RATE) &&
                      styles.stepDimmed,
                  ]}
                >
                  <Text style={styles.stepText}>+</Text>
                </Pressable>
              </View>
              <View style={styles.sliderRow}>
                <View pointerEvents="none" style={styles.track}>
                  <View
                    style={[
                      styles.thumb,
                      {
                        left: `${((displayRate - MIN_PLAYBACK_RATE) / (MAX_PLAYBACK_RATE - MIN_PLAYBACK_RATE)) * 100}%`,
                      },
                    ]}
                  />
                </View>
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
                  minimumTrackTintColor="transparent"
                  maximumTrackTintColor="transparent"
                  thumbTintColor="transparent"
                  style={styles.slider}
                />
              </View>
            </Animated.View>
          </View>
        </Modal>
      )}
    </>
  );
});

export default PlaybackSpeedControl;

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
  overlay: { flex: 1 },
  panel: {
    position: 'absolute',
    height: PANEL_HEIGHT,
    borderRadius: 14,
    backgroundColor: '#29292b',
    paddingHorizontal: 8,
    paddingTop: 4,
    shadowColor: '#000000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  valueButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  value: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  sliderRow: { height: 48, justifyContent: 'center' },
  track: {
    position: 'absolute',
    left: 16,
    right: 16,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#555557',
  },
  thumb: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#ffffff',
    top: -5,
    marginLeft: -14,
  },
  stepButton: {
    width: 44,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDimmed: { opacity: 0.35 },
  stepText: { color: '#ffffff', fontSize: 24, fontWeight: '400' },
  slider: { width: '100%', height: 48 },
});
