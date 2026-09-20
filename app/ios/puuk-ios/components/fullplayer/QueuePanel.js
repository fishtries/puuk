import React from 'react';
import {
  View,
  Text,
  StyleSheet,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { GestureDetector, FlatList as GestureHandlerFlatList } from 'react-native-gesture-handler';
import QueueItem from '../QueueItem';

const QueuePanel = ({
  styles,
  queueAnimatedStyle,
  isQueueVisible,
  isLyricsView,
  queueHeaderSwipeGesture,
  upNextQueue,
  queueAnimationRef,
  playTrack,
}) => {
  return (
    <Animated.View
      style={[queueAnimatedStyle, StyleSheet.absoluteFill]}
      pointerEvents={(isQueueVisible && !isLyricsView) ? 'auto' : 'none'}
    >
      <View style={styles.queueContainer}>
        <GestureDetector gesture={queueHeaderSwipeGesture}>
          <Animated.View style={{ width: '100%', paddingBottom: 15, backgroundColor: 'transparent' }}>
            <Text style={styles.queueTitle}>These are next</Text>
          </Animated.View>
        </GestureDetector>
        <GestureHandlerFlatList
          data={upNextQueue}
          keyExtractor={(item, index) => item.id + index.toString()}
          showsVerticalScrollIndicator={false}
          renderItem={({ item, index }) => (
            <QueueItem
              item={item}
              index={index}
              isVisible={isQueueVisible}
              shouldAnimate={queueAnimationRef.current}
              onPress={() => playTrack(item)}
            />
          )}
        />
      </View>
    </Animated.View>
  );
};

export default QueuePanel;
