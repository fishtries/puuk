import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { LinearGradient } from 'expo-linear-gradient';
import convert from 'color-convert';
import { t } from '../../shared/storage/settings';

const spectrum = ['#F00', '#FF0', '#0F0', '#0FF', '#00F', '#F0F', '#F00'];
const clamp = (value, max) => Math.max(0, Math.min(max, value));

export default function AccentPalette({
  accent,
  lang,
  onSave,
  onCancel,
  onDrag,
}) {
  const [[hue, saturation, brightness], setColor] = useState(() =>
    convert.hex.hsv.raw(accent),
  );
  const [size, setSize] = useState({ width: 0, height: 0 });
  const ru = lang === 'ru';
  const hex = '#' + convert.hsv.hex(hue % 360, saturation, brightness);
  const touchColor = ({ nativeEvent: { locationX, locationY } }) => {
    if (!size.width || !size.height) return;
    setColor([
      clamp(locationX / size.width, 1) * 360,
      (1 - clamp(locationY / size.height, 1)) * 100,
      brightness,
    ]);
  };

  return (
    <View style={styles.palette}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={
          ru ? 'Оттенок и насыщенность' : 'Hue and saturation'
        }
        accessibilityValue={{
          text: `${Math.round(hue)}°, ${Math.round(saturation)}%`,
        }}
        accessibilityActions={[
          { name: 'increment', label: ru ? 'Следующий оттенок' : 'Next hue' },
          {
            name: 'decrement',
            label: ru ? 'Предыдущий оттенок' : 'Previous hue',
          },
          {
            name: 'saturate',
            label: ru ? 'Увеличить насыщенность' : 'Increase saturation',
          },
          {
            name: 'desaturate',
            label: ru ? 'Уменьшить насыщенность' : 'Decrease saturation',
          },
        ]}
        onAccessibilityAction={({ nativeEvent: { actionName } }) => {
          if (actionName === 'increment')
            setColor([(hue + 5) % 360, saturation, brightness]);
          if (actionName === 'decrement')
            setColor([(hue + 355) % 360, saturation, brightness]);
          if (actionName === 'saturate')
            setColor([hue, clamp(saturation + 5, 100), brightness]);
          if (actionName === 'desaturate')
            setColor([hue, clamp(saturation - 5, 100), brightness]);
        }}
        style={styles.field}
        onLayout={({ nativeEvent: { layout } }) => setSize(layout)}
        onStartShouldSetResponder={() => true}
        onResponderGrant={(event) => {
          onDrag(true);
          touchColor(event);
        }}
        onResponderMove={touchColor}
        onResponderTerminationRequest={() => false}
        onResponderRelease={() => onDrag(false)}
        onResponderTerminate={() => onDrag(false)}
      >
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <LinearGradient
            colors={spectrum}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={['rgba(255,255,255,0)', '#FFF']}
            style={StyleSheet.absoluteFill}
          />
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: '#000', opacity: 1 - brightness / 100 },
            ]}
          />
          <View
            style={[
              styles.cursor,
              {
                left: clamp(
                  (size.width * hue) / 360 - 10,
                  Math.max(0, size.width - 20),
                ),
                top: clamp(
                  size.height * (1 - saturation / 100) - 10,
                  Math.max(0, size.height - 20),
                ),
                backgroundColor: hex,
              },
            ]}
          />
        </View>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>{ru ? 'Яркость' : 'Brightness'}</Text>
        <Slider
          style={styles.slider}
          minimumValue={0}
          maximumValue={100}
          value={brightness}
          accessibilityLabel={ru ? 'Яркость' : 'Brightness'}
          accessibilityValue={{ text: `${Math.round(brightness)}%` }}
          minimumTrackTintColor={
            '#' + convert.hsv.hex(hue % 360, saturation, 100)
          }
          tapToSeek
          onValueChange={(value) => setColor([hue, saturation, value])}
        />
      </View>
      <View style={styles.row}>
        <View style={[styles.preview, { backgroundColor: hex }]} />
        <View style={styles.actions}>
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.action}
            onPress={onCancel}
          >
            <Text style={styles.label}>{t('cancel', lang)}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.action}
            onPress={() => onSave(hex)}
          >
            <Text style={styles.save}>{ru ? 'Готово' : 'Done'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  palette: { paddingBottom: 8, gap: 4 },
  field: { height: 144, overflow: 'hidden', borderRadius: 12 },
  cursor: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 3,
    borderColor: '#FFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  label: { fontSize: 15, color: '#BCBCC2' },
  slider: { height: 44, flex: 1 },
  preview: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#AAA',
  },
  actions: { flexDirection: 'row', gap: 12 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  save: { fontSize: 15, fontWeight: '600', color: '#FFF' },
});
