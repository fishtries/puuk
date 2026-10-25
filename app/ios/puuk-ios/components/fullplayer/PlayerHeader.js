import React, { useMemo, useCallback } from 'react';
import {
  View,
  TouchableOpacity,
  ActionSheetIOS,
  Alert,
  Platform,
  UIManager,
} from 'react-native';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { MenuView } from '@react-native-menu/menu';
import TrackLoadingBadge from './TrackLoadingBadge';

export function isNativeMenuAvailable() {
  if (process.env.NODE_ENV === 'test') {
    return true;
  }
  if (Platform.OS !== 'ios') {
    return false;
  }
  // Expo Go (StoreClient) does not include third-party native libraries like @react-native-menu/menu
  if (
    Constants.appOwnership === 'expo' ||
    Constants.executionEnvironment === 'storeClient'
  ) {
    return false;
  }
  try {
    if (typeof UIManager.hasViewManagerConfig === 'function') {
      return UIManager.hasViewManagerConfig('MenuView');
    }
  } catch {
    return false;
  }
  return false;
}

export default function PlayerHeader({
  styles,
  handleClose,
  isLoading,
  isBufferingSlow,
  networkStatus,
  nextTrackStatus,
  displayTitle,
  handleMenuAction,
  menuActions,
}) {
  const hasNativeMenu = useMemo(() => isNativeMenuAvailable(), []);

  const handleFallbackPress = useCallback(() => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}

    const actionTitles = (menuActions || []).map((a) => a.title);

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: displayTitle,
          options: ['Cancel', ...actionTitles],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) return;
          const selected = menuActions?.[buttonIndex - 1];
          if (selected && handleMenuAction) {
            handleMenuAction({ nativeEvent: { event: selected.id } });
          }
        },
      );
    } else {
      Alert.alert(
        displayTitle || 'Track Options',
        undefined,
        [
          { text: 'Cancel', style: 'cancel' },
          ...(menuActions || []).map((action) => ({
            text: action.title,
            onPress: () => {
              if (handleMenuAction) {
                handleMenuAction({ nativeEvent: { event: action.id } });
              }
            },
          })),
        ],
        { cancelable: true },
      );
    }
  }, [displayTitle, handleMenuAction, menuActions]);

  return (
    <>
      <TouchableOpacity
        onPress={handleClose}
        hitSlop={{ top: 15, bottom: 20, left: 40, right: 40 }}
        activeOpacity={0.6}
        style={styles.topGrabberContainer}
      >
        <View style={styles.topGrabberPill} />
      </TouchableOpacity>

      <View style={styles.topHeaderRow}>
        <View style={{ flex: 1 }} />
        <View style={styles.topHeaderRight}>
          <TrackLoadingBadge
            isLoading={isLoading}
            isBufferingSlow={isBufferingSlow}
            networkStatus={networkStatus}
            nextTrackStatus={nextTrackStatus}
          />

          {hasNativeMenu ? (
            <MenuView
              title={displayTitle}
              onPressAction={handleMenuAction}
              actions={menuActions}
              shouldOpenOnLongPress={false}
            >
              <View
                style={styles.topMenuButton}
                accessibilityRole="button"
                accessibilityLabel="Track options"
              >
                <Ionicons
                  name="ellipsis-horizontal"
                  size={17}
                  color="#ffffff"
                />
              </View>
            </MenuView>
          ) : (
            <TouchableOpacity
              onPress={handleFallbackPress}
              style={styles.topMenuButton}
              accessibilityRole="button"
              accessibilityLabel="Track options"
              activeOpacity={0.7}
            >
              <Ionicons name="ellipsis-horizontal" size={17} color="#ffffff" />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </>
  );
}
