import React, { useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getSettings, addSettingsListener } from '../utils/settings';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolate,
  Easing
} from 'react-native-reanimated';

const TABS = [
  { key: 'Home', index: 0, title: 'puuk' },
  { key: 'Search', index: 1, title: 'search' },
  { key: 'Library', index: 2, title: 'library' },
];

const TAB_INDEX_MAP = {
  Home: 0,
  Search: 1,
  Library: 2,
};

const SLIDE_DISTANCE = 36;

function TabTitleItem({ title, index, activeIndex }) {
  const animatedStyle = useAnimatedStyle(() => {
    const diff = activeIndex.value - index;
    const translateX = -diff * SLIDE_DISTANCE;
    const opacity = Math.max(0, 1 - Math.abs(diff) * 2);

    return {
      position: 'absolute',
      left: 0,
      right: 0,
      transform: [{ translateX }],
      opacity,
    };
  });

  return (
    <Animated.View style={animatedStyle} pointerEvents="none">
      <Text style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
    </Animated.View>
  );
}

export default function AppHeader({
  activeTab = 'Home',
  title,
  currentUser,
  onOpenAuthModal,
  onAddPlaylist,
  rightActions
}) {
  const [accentColor, setAccentColor] = useState(() => getSettings().accentColor || '#FFDAB9');

  useEffect(() => {
    const unsub = addSettingsListener((s) => {
      if (s.accentColor) setAccentColor(s.accentColor);
    });
    return unsub;
  }, []);

  const targetIndex = TAB_INDEX_MAP[activeTab] ?? 0;
  const activeIndex = useSharedValue(targetIndex);

  useEffect(() => {
    activeIndex.value = withTiming(targetIndex, {
      duration: 190,
      easing: Easing.out(Easing.cubic),
    });
  }, [targetIndex]);

  // Плавное появление кнопки создания плейлиста только на вкладке Медиатека (индекс 2)
  const isLibraryTab = activeTab === 'Library';
  const addBtnAnimatedStyle = useAnimatedStyle(() => {
    const diff = Math.abs(activeIndex.value - 2);
    const opacity = Math.max(0, 1 - diff * 2.5);
    const scale = interpolate(activeIndex.value, [1.5, 2], [0.85, 1], 'clamp');

    return {
      opacity,
      transform: [{ scale }],
    };
  });

  return (
    <View style={styles.headerContainer}>
      <View style={styles.titleArea}>
        {title ? (
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
        ) : (
          TABS.map((tab) => (
            <TabTitleItem
              key={tab.key}
              title={tab.title}
              index={tab.index}
              activeIndex={activeIndex}
            />
          ))
        )}
      </View>

      <View style={styles.rightContainer}>
        {onAddPlaylist && (
          <Animated.View
            style={addBtnAnimatedStyle}
            pointerEvents={isLibraryTab ? 'auto' : 'none'}
          >
            <TouchableOpacity
              style={styles.actionButton}
              onPress={onAddPlaylist}
              activeOpacity={0.7}
              hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            >
              <Ionicons name="add" size={24} color="#fff" />
            </TouchableOpacity>
          </Animated.View>
        )}

        {rightActions}

        {onOpenAuthModal && (
          <TouchableOpacity
            style={styles.profileButton}
            onPress={onOpenAuthModal}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
          >
            <Ionicons
              name={
                currentUser?.is_authenticated
                  ? 'person-circle'
                  : 'person-circle-outline'
              }
              size={26}
              color={currentUser?.is_authenticated ? accentColor : '#8E8E93'}
            />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    height: 64,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    backgroundColor: 'transparent',
  },
  titleArea: {
    flex: 1,
    height: 44,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  headerTitle: {
    fontSize: 34,
    fontWeight: 'bold',
    color: '#ffffff',
    letterSpacing: -0.5,
  },
  rightContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  actionButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#161722',
    borderWidth: 1,
    borderColor: '#242636',
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#161722',
    borderWidth: 1,
    borderColor: '#242636',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
