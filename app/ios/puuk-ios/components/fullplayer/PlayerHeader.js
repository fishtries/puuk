import React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MenuView } from '@react-native-menu/menu';
import TrackLoadingBadge from './TrackLoadingBadge';

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
              <Ionicons name="ellipsis-horizontal" size={17} color="#ffffff" />
            </View>
          </MenuView>
        </View>
      </View>
    </>
  );
}
