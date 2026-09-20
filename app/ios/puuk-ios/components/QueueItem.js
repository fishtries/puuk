import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, StyleSheet, Easing, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import CoverImage from './CoverImage';

const QueueItem = ({ item, index, isVisible, shouldAnimate, onPress }) => {
  const anim = useRef(new Animated.Value(0)).current;
  const animY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isVisible) {
      if (shouldAnimate) {
        anim.setValue(0);
        animY.setValue(0);
        Animated.parallel([
          Animated.timing(anim, {
            toValue: 1,
            duration: 400,
            delay: index * 60,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.spring(animY, {
            toValue: 1,
            delay: index * 60,
            tension: 60,
            friction: 8,
            useNativeDriver: true,
          })
        ]).start();
      } else {
        anim.setValue(1);
        animY.setValue(1);
      }
    }
    // Убран блок else: теперь элементы не пропадают мгновенно, а плавно исчезают вместе с контейнером очереди
  }, [anim, animY, index, isVisible, shouldAnimate]);

  return (
    <Animated.View style={[styles.queueItem, {
      opacity: anim,
      transform: [
        { translateY: animY.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }) }
      ]
    }]}>
      <TouchableOpacity style={styles.queueItemTouchable} onPress={onPress} activeOpacity={0.7}>
        <CoverImage source={item.coverArt} style={styles.queueItemImage} />
        <View style={styles.queueItemInfo}>
          <Text style={styles.queueItemTitle} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.queueItemArtist} numberOfLines={1}>{item.artist}</Text>
        </View>
        <Ionicons name="menu" size={20} color="#8e8e93" />
      </TouchableOpacity>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  queueItem: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  queueItemTouchable: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  queueItemImage: {
    width: 44,
    height: 44,
    borderRadius: 6,
    marginRight: 12,
  },
  queueItemInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  queueItemTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 4,
  },
  queueItemArtist: {
    color: '#8e8e93',
    fontSize: 14,
  },
  albumArtPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1c1c1e',
  },
});

export default QueueItem;
