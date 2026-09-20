import React from 'react';
import { View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import MaskedView from '@react-native-masked-view/masked-view';
import { easeGradient } from 'react-native-easing-gradient';
import Animated from 'react-native-reanimated';

export const TopBlurOverlay = ({ animatedBgStyle, insets }) => {
  const { colors, locations } = easeGradient({
    colorStops: {
      0: { color: "rgba(0,0,0,1)" },
      0.4: { color: "rgba(0,0,0,0.95)" },
      1: { color: "rgba(0,0,0,0)" },
    },
  });
  const topHeight = (insets?.top || 47) + 155;
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: topHeight, zIndex: 10 }} pointerEvents="none">
      <MaskedView maskElement={<LinearGradient locations={locations} colors={colors} style={StyleSheet.absoluteFill} />} style={StyleSheet.absoluteFill}>
        <BlurView intensity={40} tint="default" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { opacity: 0.7 }]}>
          <Animated.View style={[StyleSheet.absoluteFill, animatedBgStyle]} />
        </View>
      </MaskedView>
    </View>
  );
};

export const BottomBlurOverlay = ({ insets }) => {
  const { colors, locations } = easeGradient({
    colorStops: {
      0: { color: "rgba(0,0,0,0)" },
      0.5: { color: "rgba(0,0,0,0.95)" },
      1: { color: "rgba(0,0,0,1)" },
    },
  });

  const bottomInset = insets?.bottom || 34;
  const blurHeight = bottomInset + 310;

  return (
    <View
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: blurHeight,
        zIndex: 10,
      }}
      pointerEvents="none"
    >
      <MaskedView
        maskElement={
          <LinearGradient
            locations={locations}
            colors={colors}
            style={StyleSheet.absoluteFill}
          />
        }
        style={StyleSheet.absoluteFill}
      >
        <BlurView intensity={50} tint="dark" style={StyleSheet.absoluteFill} />
      </MaskedView>
    </View>
  );
};
