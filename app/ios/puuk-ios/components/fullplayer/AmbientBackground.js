import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Dimensions, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
  cancelAnimation,
  interpolate,
  Extrapolation,
  runOnJS,
  ReduceMotion,
} from 'react-native-reanimated';
import CoverImage from '../../shared/media/CoverImage';
import { areTrackIdsEqual, getTrackId } from '../../shared/domain/trackAdapter';
import { authFetch } from '../../shared/api/api';

const { width, height } = Dimensions.get('window');

const safeWithRepeat =
  typeof withRepeat === 'function' ? withRepeat : (anim) => anim;
const safeEasingInOut = Easing?.bezier
  ? Easing.bezier(0.42, 0, 0.58, 1)
  : undefined;
const safeEasingOut = Easing?.bezier
  ? Easing.bezier(0.25, 1, 0.5, 1)
  : undefined;
const systemReduceMotion = ReduceMotion?.System || 'system';

/**
 * Checks if a hex color is valid and not a dull dark fallback.
 */
function isVibrantColor(hex) {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) return false;
  const clean = hex.replace('#', '');
  if (clean.length !== 6 && clean.length !== 3) return false;
  const num = parseInt(
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean,
    16,
  );
  if (Number.isNaN(num)) return false;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 30;
}

/**
 * Feathers an ambient colored light pool using SVG RadialGradient.
 * The opacity drops to 0 at 100%, completely eliminating any hard circular boundaries.
 */
const SoftOrb = React.memo(({ id, size, color, opacity = 0.5 }) => {
  if (!color || !isVibrantColor(color)) return null;

  return (
    <View
      style={{ width: size, height: size }}
      pointerEvents="none"
      testID="ambient-soft-orb"
    >
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" rx="50%" ry="50%">
            <Stop offset="0%" stopColor={color} stopOpacity={opacity} />
            <Stop offset="30%" stopColor={color} stopOpacity={opacity * 0.7} />
            <Stop offset="65%" stopColor={color} stopOpacity={opacity * 0.25} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={size} height={size} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
});

const TrackVisualLayer = React.memo(
  ({
    track,
    color,
    layerId,
    animatedScaleStyle,
    animatedDriftStyle,
    animatedOrb1Style,
    animatedOrb2Style,
  }) => {
    return (
      <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
        {/* Layer 1: Deep wide atmospheric background wash (scale 1.8, heavy blur 85px) */}
        <Animated.View
          style={[
            styles.coverWrapper,
            styles.coverDeepLayer,
            animatedScaleStyle,
          ]}
          pointerEvents="none"
        >
          <CoverImage
            source={track?.coverArt}
            style={styles.deepCoverImage}
            resizeMode="cover"
            blurRadius={Platform.OS === 'ios' ? 85 : 45}
          />
        </Animated.View>

        {/* Layer 2: Dynamic organic breathing artwork layer (scale 1.45, blur 55px, slow drift) */}
        <Animated.View
          style={[
            styles.coverWrapper,
            styles.coverBreathingLayer,
            animatedDriftStyle,
          ]}
          pointerEvents="none"
        >
          <CoverImage
            source={track?.coverArt}
            style={styles.breathingCoverImage}
            resizeMode="cover"
            blurRadius={Platform.OS === 'ios' ? 55 : 35}
          />
        </Animated.View>

        {/* Layer 3: Soft feathered luminous accent pools (radial gradient, NO sharp borders) */}
        {color && isVibrantColor(color) && (
          <>
            <Animated.View
              style={[styles.orb1Container, animatedOrb1Style]}
              pointerEvents="none"
            >
              <SoftOrb
                id={`orb1_${layerId}`}
                size={Math.round(width * 1.15)}
                color={color}
                opacity={0.45}
              />
            </Animated.View>

            <Animated.View
              style={[styles.orb2Container, animatedOrb2Style]}
              pointerEvents="none"
            >
              <SoftOrb
                id={`orb2_${layerId}`}
                size={Math.round(width * 1.05)}
                color={color}
                opacity={0.35}
              />
            </Animated.View>
          </>
        )}
      </View>
    );
  },
);

const AmbientBackground = ({
  currentTrack,
  isPlaying = false,
  isPlayerVisible = false,
  expandProgress,
}) => {
  const [displayedTrack, setDisplayedTrack] = useState(currentTrack);
  const [outgoingTrack, setOutgoingTrack] = useState(null);
  const [color, setColor] = useState(() => currentTrack?.cover_color || null);

  const crossfadeProgress = useSharedValue(1);
  const breathScale = useSharedValue(1.2);
  const driftTranslateX = useSharedValue(0);
  const driftTranslateY = useSharedValue(0);
  const orbTranslateX = useSharedValue(0);
  const orbTranslateY = useSharedValue(0);
  const orb2TranslateX = useSharedValue(0);
  const orb2TranslateY = useSharedValue(0);

  const prevTrackIdRef = useRef(getTrackId(currentTrack));

  // Asynchronously resolve track cover_color if absent on the track object
  useEffect(() => {
    const trackId = getTrackId(currentTrack);
    if (!trackId) {
      setColor(null);
      return;
    }

    if (currentTrack?.cover_color) {
      setColor(currentTrack.cover_color);
      return;
    }

    let isCancelled = false;
    authFetch(`/api/color/${encodeURIComponent(String(trackId))}`)
      .then((res) => {
        if (!isCancelled && res?.ok) {
          return res.json();
        }
        return null;
      })
      .then((data) => {
        if (!isCancelled && data?.color) {
          setColor(data.color);
        }
      })
      .catch(() => {});

    return () => {
      isCancelled = true;
    };
  }, [currentTrack]);

  // Double-buffering crossfade when switching tracks
  useEffect(() => {
    const currentId = getTrackId(currentTrack);

    if (!areTrackIdsEqual(currentTrack, displayedTrack)) {
      prevTrackIdRef.current = currentId;

      if (displayedTrack) {
        setOutgoingTrack(displayedTrack);
        setDisplayedTrack(currentTrack);
        crossfadeProgress.value = 0;
        crossfadeProgress.value = withTiming(
          1,
          {
            duration: 650,
            easing: safeEasingOut,
            reduceMotion: systemReduceMotion,
          },
          (finished) => {
            if (finished) {
              runOnJS(setOutgoingTrack)(null);
            }
          },
        );
      } else {
        setDisplayedTrack(currentTrack);
        crossfadeProgress.value = 1;
      }
    }
  }, [currentTrack, displayedTrack]);

  // Organic breathing & drifting loop tied to isPlaying & isPlayerVisible
  useEffect(() => {
    if (!isPlayerVisible) {
      cancelAnimation(breathScale);
      cancelAnimation(driftTranslateX);
      cancelAnimation(driftTranslateY);
      cancelAnimation(orbTranslateX);
      cancelAnimation(orbTranslateY);
      cancelAnimation(orb2TranslateX);
      cancelAnimation(orb2TranslateY);
      return;
    }

    if (isPlaying) {
      breathScale.value = safeWithRepeat(
        withSequence(
          withTiming(1.35, {
            duration: 10000,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
          withTiming(1.2, {
            duration: 10000,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
        ),
        -1,
        true,
      );

      driftTranslateX.value = safeWithRepeat(
        withSequence(
          withTiming(20, {
            duration: 9000,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
          withTiming(-20, {
            duration: 9500,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
        ),
        -1,
        true,
      );

      driftTranslateY.value = safeWithRepeat(
        withSequence(
          withTiming(-16, {
            duration: 8500,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
          withTiming(16, {
            duration: 10500,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
        ),
        -1,
        true,
      );

      orbTranslateX.value = safeWithRepeat(
        withSequence(
          withTiming(30, {
            duration: 8000,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
          withTiming(-30, {
            duration: 8500,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
        ),
        -1,
        true,
      );

      orbTranslateY.value = safeWithRepeat(
        withSequence(
          withTiming(-20, {
            duration: 7000,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
          withTiming(20, {
            duration: 9000,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
        ),
        -1,
        true,
      );

      orb2TranslateX.value = safeWithRepeat(
        withSequence(
          withTiming(-25, {
            duration: 8500,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
          withTiming(25, {
            duration: 7500,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
        ),
        -1,
        true,
      );

      orb2TranslateY.value = safeWithRepeat(
        withSequence(
          withTiming(20, {
            duration: 9500,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
          withTiming(-20, {
            duration: 8000,
            easing: safeEasingInOut,
            reduceMotion: systemReduceMotion,
          }),
        ),
        -1,
        true,
      );
    } else {
      // Gently return to resting position when paused
      breathScale.value = withTiming(1.2, {
        duration: 1200,
        easing: safeEasingOut,
        reduceMotion: systemReduceMotion,
      });
      driftTranslateX.value = withTiming(0, {
        duration: 1200,
        easing: safeEasingOut,
        reduceMotion: systemReduceMotion,
      });
      driftTranslateY.value = withTiming(0, {
        duration: 1200,
        easing: safeEasingOut,
        reduceMotion: systemReduceMotion,
      });
      orbTranslateX.value = withTiming(0, {
        duration: 1200,
        easing: safeEasingOut,
        reduceMotion: systemReduceMotion,
      });
      orbTranslateY.value = withTiming(0, {
        duration: 1200,
        easing: safeEasingOut,
        reduceMotion: systemReduceMotion,
      });
      orb2TranslateX.value = withTiming(0, {
        duration: 1200,
        easing: safeEasingOut,
        reduceMotion: systemReduceMotion,
      });
      orb2TranslateY.value = withTiming(0, {
        duration: 1200,
        easing: safeEasingOut,
        reduceMotion: systemReduceMotion,
      });
    }

    return () => {
      cancelAnimation(breathScale);
      cancelAnimation(driftTranslateX);
      cancelAnimation(driftTranslateY);
      cancelAnimation(orbTranslateX);
      cancelAnimation(orbTranslateY);
      cancelAnimation(orb2TranslateX);
      cancelAnimation(orb2TranslateY);
    };
  }, [isPlaying, isPlayerVisible]);

  // Overall container opacity tied to expandProgress or isPlayerVisible
  const containerAnimatedStyle = useAnimatedStyle(() => {
    if (!expandProgress) {
      return { opacity: isPlayerVisible ? 1 : 0 };
    }
    const opacity = interpolate(
      expandProgress.value,
      [0, 0.35],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return {
      opacity,
    };
  });

  const animatedScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: breathScale.value }],
  }));

  const animatedDriftStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: breathScale.value * 1.05 },
      { translateX: driftTranslateX.value },
      { translateY: driftTranslateY.value },
    ],
  }));

  const animatedOrb1Style = useAnimatedStyle(() => ({
    transform: [
      { translateX: orbTranslateX.value },
      { translateY: orbTranslateY.value },
    ],
  }));

  const animatedOrb2Style = useAnimatedStyle(() => ({
    transform: [
      { translateX: orb2TranslateX.value },
      { translateY: orb2TranslateY.value },
    ],
  }));

  const outgoingAnimatedStyle = useAnimatedStyle(() => ({
    opacity: 1 - crossfadeProgress.value,
  }));

  const currentAnimatedStyle = useAnimatedStyle(() => ({
    opacity: crossfadeProgress.value,
  }));

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFillObject,
        styles.container,
        containerAnimatedStyle,
      ]}
      pointerEvents="none"
      accessibilityElementsHidden={true}
      importantForAccessibility="no-hide-descendants"
    >
      {/* 1. Base dark background */}
      <View
        style={[StyleSheet.absoluteFillObject, styles.baseDark]}
        pointerEvents="none"
      />

      {/* 2. Visual artwork & orbs layers (double-buffered crossfade) */}
      {outgoingTrack && (
        <Animated.View
          style={[StyleSheet.absoluteFillObject, outgoingAnimatedStyle]}
          pointerEvents="none"
        >
          <TrackVisualLayer
            track={outgoingTrack}
            color={color}
            layerId="outgoing"
            animatedScaleStyle={animatedScaleStyle}
            animatedDriftStyle={animatedDriftStyle}
            animatedOrb1Style={animatedOrb1Style}
            animatedOrb2Style={animatedOrb2Style}
          />
        </Animated.View>
      )}

      <Animated.View
        style={[StyleSheet.absoluteFillObject, currentAnimatedStyle]}
        pointerEvents="none"
      >
        <TrackVisualLayer
          track={displayedTrack}
          color={color}
          layerId="current"
          animatedScaleStyle={animatedScaleStyle}
          animatedDriftStyle={animatedDriftStyle}
          animatedOrb1Style={animatedOrb1Style}
          animatedOrb2Style={animatedOrb2Style}
        />
      </Animated.View>

      {/* 3. Native hardware blur overlay to melt layers into frosted silk */}
      <BlurView
        intensity={Platform.OS === 'ios' ? 45 : 60}
        tint="dark"
        style={StyleSheet.absoluteFillObject}
        pointerEvents="none"
      />

      {/* 4. Multi-stop Apple Music Contrast Vignette */}
      <LinearGradient
        colors={[
          'rgba(0, 0, 0, 0.62)',
          'rgba(0, 0, 0, 0.15)',
          'rgba(0, 0, 0, 0.38)',
          'rgba(0, 0, 0, 0.82)',
        ]}
        locations={[0, 0.32, 0.68, 1]}
        style={StyleSheet.absoluteFillObject}
        pointerEvents="none"
      />
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    zIndex: 0,
  },
  baseDark: {
    backgroundColor: '#050508',
  },
  coverWrapper: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  coverDeepLayer: {
    opacity: 0.82,
  },
  coverBreathingLayer: {
    opacity: 0.65,
  },
  deepCoverImage: {
    width: Math.max(width, height) * 1.3,
    height: Math.max(width, height) * 1.3,
  },
  breathingCoverImage: {
    width: Math.max(width, height) * 1.15,
    height: Math.max(width, height) * 1.15,
  },
  orb1Container: {
    position: 'absolute',
    top: -height * 0.1,
    right: -width * 0.25,
  },
  orb2Container: {
    position: 'absolute',
    bottom: height * 0.08,
    left: -width * 0.25,
  },
});

export default React.memo(AmbientBackground);
