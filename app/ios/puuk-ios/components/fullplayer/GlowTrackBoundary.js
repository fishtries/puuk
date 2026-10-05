import React, { useState, useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import Svg, { Path, Rect, G, Defs, LinearGradient, Stop, Filter, FeGaussianBlur } from 'react-native-svg';

import {
  CORNER_RADIUS,
  SVG_HEIGHT,
  SVG_PAD_TOP,
  getBoundaryTotalLength,
  getBoundaryPathD,
} from '../../utils/boundaryGeometry';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const GlowTrackBoundary = React.memo(function GlowTrackBoundary({
  currentTime = 0,
  duration = 0,
  isPlaying = false,
  accentColor = '#FFDAB9',
  width = SCREEN_WIDTH,
}) {
  // Плавный интерполированный прогресс (0..1)
  const [displayProgress, setDisplayProgress] = useState(() => {
    if (!duration || duration <= 0) return 0;
    return Math.max(0, Math.min(1, currentTime / duration));
  });

  const playheadRef = useRef({
    time: currentTime,
    ts: Date.now(),
    isPlaying,
    duration,
  });

  // Синхронизация при приходе дискретных тиков времени от нативного плеера
  useEffect(() => {
    playheadRef.current = {
      time: currentTime,
      ts: Date.now(),
      isPlaying,
      duration,
    };
  }, [currentTime, isPlaying, duration]);

  // Непрерывная 60fps интерполяция прогресса между дискретными тиками expo-audio
  useEffect(() => {
    let animId;

    const tick = () => {
      const { time, ts, isPlaying: playing, duration: dur } = playheadRef.current;
      if (dur > 0) {
        if (playing) {
          const deltaSec = (Date.now() - ts) / 1000;
          const current = Math.min(dur, Math.max(0, time + deltaSec));
          setDisplayProgress(current / dur);
        } else {
          setDisplayProgress(Math.min(1, Math.max(0, time / dur)));
        }
      } else {
        setDisplayProgress(0);
      }

      if (playing) {
        animId = requestAnimationFrame(tick);
      }
    };

    if (isPlaying && duration > 0) {
      animId = requestAnimationFrame(tick);
    } else {
      tick();
    }

    return () => {
      if (animId) cancelAnimationFrame(animId);
    };
  }, [isPlaying, duration]);

  const totalLength = useMemo(() => {
    return getBoundaryTotalLength(width, CORNER_RADIUS);
  }, [width]);

  const pathD = useMemo(() => {
    return getBoundaryPathD(width, CORNER_RADIUS, SVG_PAD_TOP);
  }, [width]);

  const dashOffset = useMemo(() => {
    return totalLength * (1 - displayProgress);
  }, [totalLength, displayProgress]);

  const yBottom = CORNER_RADIUS + SVG_PAD_TOP;

  return (
    <View style={styles.container} pointerEvents="none">
      <Svg
        width={width}
        height={SVG_HEIGHT}
        viewBox={`0 0 ${width} ${SVG_HEIGHT}`}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      >
        <Defs>
          {/* Физический фильтр размытия по Гауссу для широкого атмосферного свечения */}
          <Filter id="ambientBlur" x="-30%" y="-30%" width="160%" height="160%">
            <FeGaussianBlur stdDeviation="12" />
          </Filter>

          {/* Фильтр размытия средней дальности для мягкого ореола */}
          <Filter id="midBlur" x="-30%" y="-30%" width="160%" height="160%">
            <FeGaussianBlur stdDeviation="5" />
          </Filter>

          {/* Сверхширокое высокое рассеянное свечение вверх */}
          <LinearGradient
            id="neonTallAmbientDiffuse"
            x1="0"
            y1={yBottom}
            x2="0"
            y2={0}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%" stopColor={accentColor} stopOpacity={0.35} />
            <Stop offset="25%" stopColor={accentColor} stopOpacity={0.20} />
            <Stop offset="50%" stopColor={accentColor} stopOpacity={0.08} />
            <Stop offset="75%" stopColor={accentColor} stopOpacity={0.02} />
            <Stop offset="100%" stopColor={accentColor} stopOpacity={0.0} />
          </LinearGradient>

          {/* Широкий неоновый ореол средней дальности */}
          <LinearGradient
            id="neonMidHalo"
            x1="0"
            y1={yBottom}
            x2="0"
            y2={SVG_PAD_TOP}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%" stopColor={accentColor} stopOpacity={0.65} />
            <Stop offset="35%" stopColor={accentColor} stopOpacity={0.40} />
            <Stop offset="70%" stopColor={accentColor} stopOpacity={0.15} />
            <Stop offset="100%" stopColor={accentColor} stopOpacity={0.0} />
          </LinearGradient>

          {/* Тело линии: мягкий переход цвета акцента без едкого белого пересвета */}
          <LinearGradient
            id="neonTubeBody"
            x1="0"
            y1={yBottom}
            x2="0"
            y2={SVG_PAD_TOP}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0%" stopColor="#ffffff" stopOpacity={0.65} />
            <Stop offset="30%" stopColor={accentColor} stopOpacity={0.85} />
            <Stop offset="100%" stopColor={accentColor} stopOpacity={0.70} />
          </LinearGradient>
        </Defs>

        {/* Базовая направляющая по скругленной границе */}
        <Path
          d={pathD}
          fill="none"
          stroke="rgba(255, 255, 255, 0.08)"
          strokeWidth={1}
        />

        {/* СЛОЙ 1: Высокое атмосферное рассеянное свечение с истинным Gaussian Blur (яркий градиент вверх) */}
        {displayProgress > 0 ? (
          <Path
            d={pathD}
            fill="none"
            stroke="url(#neonTallAmbientDiffuse)"
            strokeWidth={30}
            filter="url(#ambientBlur)"
            strokeDasharray={`${totalLength} ${totalLength}`}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
          />
        ) : null}

        {/* СЛОЙ 2: Мягкий неоновый ореол средней дальности с Gaussian Blur (яркий насыщенный свет) */}
        {displayProgress > 0 ? (
          <Path
            d={pathD}
            fill="none"
            stroke="url(#neonMidHalo)"
            strokeWidth={14}
            filter="url(#midBlur)"
            strokeDasharray={`${totalLength} ${totalLength}`}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
          />
        ) : null}

        {/* СЛОЙ 3: Тело линии — мягкое и приглушенное, без резкого белого пересвета */}
        {displayProgress > 0 ? (
          <Path
            d={pathD}
            fill="none"
            stroke="url(#neonTubeBody)"
            strokeWidth={2.4}
            strokeOpacity={0.75}
            strokeDasharray={`${totalLength} ${totalLength}`}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
          />
        ) : null}

        {/* СЛОЙ 4: Деликатный мягкий акцентный блик по центру */}
        {displayProgress > 0 ? (
          <Path
            d={pathD}
            fill="none"
            stroke="#ffffff"
            strokeWidth={0.8}
            strokeOpacity={0.4}
            strokeDasharray={`${totalLength} ${totalLength}`}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
          />
        ) : null}
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: SVG_HEIGHT,
    zIndex: 40,
  },
});

export default GlowTrackBoundary;
