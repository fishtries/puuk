import React from 'react';
import {
  ActionSheetIOS,
  Alert,
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MenuView } from '@react-native-menu/menu';
import Constants from 'expo-constants';
import {
  SHARE_LINKS_ENABLED,
  presentShareEntity,
} from '../../utils/shareLinks';

export default function PlaylistTrackMenu({
  track,
  isFavorites,
  onAddToPlaylist,
  onEditTrack,
  onRemove,
}) {
  const actions = [
    SHARE_LINKS_ENABLED && {
      id: 'share',
      title: 'Поделиться',
      image: 'square.and.arrow.up',
    },
    onAddToPlaylist && {
      id: 'add_to_playlist',
      title: 'Add to Playlist',
      image: 'plus.circle',
    },
    onEditTrack && {
      id: 'edit_track',
      title: 'Edit Track',
      image: 'pencil',
    },
    onRemove && {
      id: 'remove',
      title: isFavorites ? 'Remove from Favorites' : 'Remove from Playlist',
      image: 'trash',
      attributes: { destructive: true },
    },
  ].filter(Boolean);

  if (!actions.length) return null;

  const selectAction = (id) => {
    if (id === 'share') return presentShareEntity(track, 'track');
    if (id === 'add_to_playlist') return onAddToPlaylist?.(track);
    if (id === 'edit_track') return onEditTrack?.(track);
    if (id === 'remove') return onRemove?.(track);
  };

  const label = `Действия с ${track.title}`;
  const icon = <Ionicons name="ellipsis-horizontal" size={20} color="#aaa" />;
  const hasNativeMenu =
    Platform.OS === 'ios' &&
    Constants.appOwnership !== 'expo' &&
    Constants.executionEnvironment !== 'storeClient';

  if (hasNativeMenu) {
    return (
      <MenuView
        actions={actions}
        themeVariant="dark"
        shouldOpenOnLongPress={false}
        onPressAction={({ nativeEvent }) => selectAction(nativeEvent.event)}
      >
        <View
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel={label}
        >
          {icon}
        </View>
      </MenuView>
    );
  }

  const openFallbackMenu = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', ...actions.map((action) => action.title)],
          cancelButtonIndex: 0,
          destructiveButtonIndex: actions.flatMap((action, index) =>
            action.attributes?.destructive ? [index + 1] : [],
          ),
          userInterfaceStyle: 'dark',
        },
        (index) => selectAction(actions[index - 1]?.id),
      );
      return;
    }

    Alert.alert(
      track.title,
      undefined,
      [
        ...actions.map((action) => ({
          text: action.title,
          style: action.attributes?.destructive ? 'destructive' : 'default',
          onPress: () => selectAction(action.id),
        })),
        { text: 'Cancel', style: 'cancel' },
      ],
      { cancelable: true },
    );
  };

  return (
    <TouchableOpacity
      onPress={openFallbackMenu}
      style={styles.button}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {icon}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
