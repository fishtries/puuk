import { StyleSheet } from 'react-native';

/**
 * Расчет геометрии нижней скругленной границы карточки приложения
 * для отображения светящегося прогресс-бара трека.
 */

export const CORNER_RADIUS = 32;
export const SVG_PAD_TOP = 50;
export const SVG_PAD_BOTTOM = 2;
export const SVG_HEIGHT = CORNER_RADIUS + SVG_PAD_TOP + SVG_PAD_BOTTOM; // 84

/**
 * Вычисляет общую длину контура нижней границы карточки.
 * L = L_left_arc (pi/2 * R) + L_center (W - 2R) + L_right_arc (pi/2 * R)
 *   = pi * R + (W - 2R)
 */
export function getBoundaryTotalLength(width, radius = CORNER_RADIUS) {
  const w = Math.max(radius * 2, width);
  const leftArc = 0.5 * Math.PI * radius;
  const centerLine = w - 2 * radius;
  const rightArc = leftArc;
  return leftArc + centerLine + rightArc;
}

/**
 * Генерирует SVG path d-атрибут для нижней границы со скругленными углами.
 */
export function getBoundaryPathD(width, radius = CORNER_RADIUS, yPad = SVG_PAD_TOP) {
  const w = Math.max(radius * 2, width);
  const yBottom = radius + yPad;
  return `M 0 ${yPad} A ${radius} ${radius} 0 0 0 ${radius} ${yBottom} L ${w - radius} ${yBottom} A ${radius} ${radius} 0 0 0 ${w} ${yPad}`;
}

/**
 * Возвращает точные координаты (x, y) и угол нормали angle для заданного прогресса [0..1].
 */
export function getPointOnBoundary(progress, width, radius = CORNER_RADIUS, yPad = SVG_PAD_TOP) {
  const w = Math.max(radius * 2, width);
  const p = Math.max(0, Math.min(1, progress || 0));
  const L1 = 0.5 * Math.PI * radius;
  const L2 = w - 2 * radius;
  const L3 = L1;
  const totalLength = L1 + L2 + L3;
  const s = p * totalLength;

  if (s <= L1) {
    // Левая дуга: угол от PI до PI/2
    const theta = Math.PI - (s / radius);
    const angle = -(theta - 0.5 * Math.PI) * (180 / Math.PI);
    return {
      x: radius + radius * Math.cos(theta),
      y: yPad + radius * Math.sin(theta),
      angle,
    };
  }

  if (s <= L1 + L2) {
    // Центральная горизонтальная линия
    const d = s - L1;
    return {
      x: radius + d,
      y: radius + yPad,
      angle: 0,
    };
  }

  // Правая дуга: угол от PI/2 до 0
  const d = s - (L1 + L2);
  const theta = 0.5 * Math.PI - (d / radius);
  const angle = (0.5 * Math.PI - theta) * (180 / Math.PI);
  return {
    x: (w - radius) + radius * Math.cos(theta),
    y: yPad + radius * Math.sin(theta),
    angle,
  };
}

/**
 * Обратное преобразование координаты касания X в значение прогресса [0..1].
 */
export function getProgressFromX(touchX, width, radius = CORNER_RADIUS) {
  const w = Math.max(radius * 2, width);
  const x = Math.max(0, Math.min(w, touchX || 0));
  const L1 = 0.5 * Math.PI * radius;
  const L2 = w - 2 * radius;
  const L3 = L1;
  const totalLength = L1 + L2 + L3;

  let s = 0;
  if (x <= radius) {
    const cosVal = Math.max(-1, Math.min(1, (x / radius) - 1));
    const theta = Math.acos(cosVal);
    s = radius * (Math.PI - theta);
  } else if (x < w - radius) {
    s = L1 + (x - radius);
  } else {
    const cosVal = Math.max(-1, Math.min(1, (x - (w - radius)) / radius));
    const theta = Math.acos(cosVal);
    const d = radius * (0.5 * Math.PI - theta);
    s = L1 + L2 + d;
  }

  return Math.max(0, Math.min(1, s / totalLength));
}
