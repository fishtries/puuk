import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import {
  getSelectableArtists,
  normalizeCredits,
} from '../domain/artistCredits';

export default function ArtistSelector({
  entity,
  identity,
  display,
  onSelect,
  controlStyle,
  textStyle,
  triggerTestID,
  numberOfLines,
  disabled,
}) {
  const artists = getSelectableArtists({
    artists: normalizeCredits(
      entity?.artists,
      entity?.artist_id,
      entity?.album_artist || entity?.artist,
    ),
  });
  const target = JSON.stringify([identity, entity?.artists_revision, artists]);
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const [openedTarget, setOpenedTarget] = useState(null);
  useEffect(() => {
    setOpenedTarget(null);
  }, [target]);
  const close = () => setOpenedTarget(null);
  const label =
    artists.length > 1
      ? `Выбрать артиста: ${display}`
      : `Страница артиста ${display}`;
  if (!artists.length || !onSelect || disabled)
    return (
      <Text
        style={textStyle}
        numberOfLines={numberOfLines}
        ellipsizeMode="tail"
      >
        {display}
      </Text>
    );
  return (
    <>
      <TouchableOpacity
        testID={triggerTestID}
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        style={controlStyle}
        onPress={() =>
          artists.length === 1
            ? onSelect(artists[0].id)
            : setOpenedTarget(target)
        }
      >
        <Text
          style={textStyle}
          numberOfLines={numberOfLines}
          ellipsizeMode="tail"
        >
          {display}
        </Text>
      </TouchableOpacity>
      <Modal
        visible={openedTarget === target}
        transparent
        animationType="fade"
        onRequestClose={close}
      >
        <TouchableWithoutFeedback onPress={close} accessible={false}>
          <View style={styles.overlay}>
            <TouchableWithoutFeedback accessible={false}>
              <View style={styles.menu} accessibilityViewIsModal>
                <Text style={styles.heading}>Выберите артиста</Text>
                <ScrollView style={styles.list}>
                  {artists.map((artist) => (
                    <TouchableOpacity
                      key={artist.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Страница артиста ${artist.name}`}
                      style={styles.item}
                      onPress={() => {
                        if (
                          openedTarget === target &&
                          currentTarget.current === target
                        ) {
                          close();
                          onSelect(artist.id);
                        }
                      }}
                    >
                      <Text style={styles.text}>{artist.name}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Отмена"
                  style={styles.item}
                  onPress={close}
                >
                  <Text style={styles.text}>Отмена</Text>
                </TouchableOpacity>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </>
  );
}
const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  menu: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 16,
    paddingBottom: 40,
    maxHeight: '80%',
  },
  heading: {
    color: '#aaa',
    fontSize: 14,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  list: { flexGrow: 0 },
  item: { paddingVertical: 16, paddingHorizontal: 20 },
  text: { color: '#fff', fontSize: 16 },
});
