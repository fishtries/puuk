import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TouchableWithoutFeedback,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function TrackContextMenuModal({
  visible,
  track,
  onClose,
  onAddToPlaylist,
  onEditTrack,
  onPlayNext,
  onEnqueue,
}) {
  if (!track) return null;

  return (
    <Modal
      visible={visible}
      transparent={true}
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={styles.menuContainer}>
              <View style={styles.header}>
                <Text style={styles.headerTitle} numberOfLines={1}>
                  {track.title}
                </Text>
                <Text style={styles.headerArtist} numberOfLines={1}>
                  {track.artist}
                </Text>
              </View>

              {[
                {
                  title: 'Играть следующим',
                  icon: 'play-skip-forward-outline',
                  action: onPlayNext,
                },
                {
                  title: 'В конец очереди',
                  icon: 'list-outline',
                  action: onEnqueue,
                },
              ]
                .filter((item) => item.action)
                .map((item) => (
                  <TouchableOpacity
                    key={item.title}
                    style={styles.menuItem}
                    accessibilityRole="button"
                    onPress={() => {
                      onClose();
                      item.action(track);
                    }}
                  >
                    <Ionicons
                      name={item.icon}
                      size={24}
                      color="#fff"
                      style={styles.menuIcon}
                    />
                    <Text style={styles.menuText}>{item.title}</Text>
                  </TouchableOpacity>
                ))}

              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => {
                  onClose();
                  onAddToPlaylist(track);
                }}
              >
                <Ionicons
                  name="list"
                  size={24}
                  color="#fff"
                  style={styles.menuIcon}
                />
                <Text style={styles.menuText}>Add to Playlist</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => {
                  onClose();
                  onEditTrack(track);
                }}
              >
                <Ionicons
                  name="create-outline"
                  size={24}
                  color="#fff"
                  style={styles.menuIcon}
                />
                <Text style={styles.menuText}>Edit Track</Text>
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  menuContainer: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 40,
    paddingTop: 16,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
    marginBottom: 8,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  headerArtist: {
    color: '#aaa',
    fontSize: 14,
    marginTop: 4,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
  },
  menuIcon: {
    marginRight: 16,
  },
  menuText: {
    color: '#fff',
    fontSize: 16,
  },
});
