import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import QueuePanel from '../QueuePanel';
import { queueKey } from '../../../utils/queueIdentity';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');
jest.mock('../../../shared/components/ArtistSelector', () => 'ArtistSelector');
jest.mock('../PlayerHeader', () => 'PlayerHeader');
jest.mock('../../QueueItem', () => 'QueueItem');
jest.mock('react-native-gesture-handler', () => {
  const { View, FlatList } = require('react-native');
  return {
    GestureDetector: ({ children }) => <View>{children}</View>,
    FlatList,
  };
});
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (value) => React.useRef({ value }).current,
  };
});

describe('QueuePanel interactions', () => {
  let renderer;
  const tracks = [2, 3, 4].map((id) => ({
    id,
    title: `Track ${id}`,
    artist: 'Artist',
  }));
  const controls = {
    repeatMode: 'off',
    autoplayEnabled: true,
    move: jest.fn(),
    remove: jest.fn(),
    clear: jest.fn(),
    toggleShuffle: jest.fn(),
    cycleRepeatMode: jest.fn(),
    toggleAutoplay: jest.fn(),
    undo: jest.fn(),
  };
  const playTrack = jest.fn();
  const props = {
    isQueueVisible: true,
    currentTrack: { id: 1, title: 'Current', artist: 'Artist' },
    upNextQueue: tracks,
    controls,
    playTrack,
  };
  const button = (label) =>
    renderer.root
      .findAllByType(TouchableOpacity)
      .find((node) => node.props.accessibilityLabel === label);
  const rows = () => renderer.root.findAllByType('QueueItem');
  beforeEach(async () => {
    jest.clearAllMocks();
    await act(async () => {
      renderer = TestRenderer.create(<QueuePanel {...props} />);
    });
  });
  afterEach(async () => {
    await act(async () => renderer.unmount());
  });

  test('reports the compact cover destination and reuses the main player menu style', async () => {
    const onCoverLayout = jest.fn();
    await act(async () => renderer.update(<QueuePanel {...props} onCoverLayout={onCoverLayout} />));
    const header = renderer.root.find((node) => typeof node.props.onLayout === 'function' && require('react-native').StyleSheet.flatten(node.props.style)?.flexDirection === 'row');
    await act(async () => header.props.onLayout({ nativeEvent: { layout: { x: 0, y: 23, width: 320, height: 60 } } }));
    expect(onCoverLayout).toHaveBeenCalledWith({ x: 0, y: 26, width: 54, height: 54 });
    expect(renderer.root.findAllByType('CoverImage')).toHaveLength(0);
    expect(renderer.root.findByType('PlayerHeader').props.styles).toBe(require('../playerStyles').default);
    const sharedHeader = renderer.root.findByType('PlayerHeader');
    expect(sharedHeader.props.menuOnly).toBeUndefined();
    expect(sharedHeader.props.handleClose).toBe(props.onClose);
    expect(sharedHeader.props.leadingActions.props.accessibilityLabel).toBe('В избранное');
  });

  test('mode and clear controls invoke the controller, and tapping a song preserves queue context', async () => {
    await act(async () => {
      button('Перемешать очередь').props.onPress();
      button('Повтор: выключен').props.onPress();
      button('Выключить автоподбор после очереди').props.onPress();
      button('Очистить очередь').props.onPress();
      rows()[1].props.onPress();
    });
    expect(controls.toggleShuffle).toHaveBeenCalledTimes(1);
    expect(controls.cycleRepeatMode).toHaveBeenCalledTimes(1);
    expect(controls.toggleAutoplay).toHaveBeenCalledTimes(1);
    expect(controls.clear).toHaveBeenCalledTimes(1);
    expect(playTrack).toHaveBeenCalledWith(tracks[1], {
      source: 'queue',
      queueIndex: 1,
    });
  });

  test('dragging commits occurrence identities, cancellation leaves order unchanged', async () => {
    await act(async () => rows()[0].props.onDragStart(tracks[0]));
    await act(async () => rows()[0].props.onDragUpdate(tracks[0], 72));
    await act(async () => rows()[0].props.onDragEnd(tracks[0], true));
    expect(controls.move).toHaveBeenCalledWith(
      queueKey(tracks[0]),
      queueKey(tracks[1]),
    );
    controls.move.mockClear();
    await act(async () => rows()[0].props.onDragStart(tracks[0]));
    await act(async () => rows()[0].props.onDragUpdate(tracks[0], 72));
    await act(async () => rows()[0].props.onDragEnd(tracks[0], false));
    expect(controls.move).not.toHaveBeenCalled();
  });

  test('an audio transition cancels an active drag before it can reorder another track', async () => {
    await act(async () => rows()[0].props.onDragStart(tracks[0]));
    await act(async () => rows()[0].props.onDragUpdate(tracks[0], 72));
    await act(async () =>
      renderer.update(<QueuePanel {...props} upNextQueue={tracks.slice(1)} />),
    );
    await act(async () => rows()[0].props.onDragEnd(tracks[0], true));
    expect(controls.move).not.toHaveBeenCalled();
  });

  test('empty queue explains autoplay and disables clearing, undo is accessible', async () => {
    await act(async () =>
      renderer.update(<QueuePanel {...props} upNextQueue={[]} />),
    );
    expect(button('Очистить очередь').props.disabled).toBe(true);
    expect(
      renderer.root
        .findAllByType(Text)
        .some(
          (node) =>
            node.props.children === 'После текущего трека подберём похожие.',
        ),
    ).toBe(true);
    await act(async () =>
      renderer.update(
        <QueuePanel
          {...props}
          controls={{ ...controls, undoMessage: 'Очередь очищена' }}
        />,
      ),
    );
    const undo = renderer.root
      .findAllByType(TouchableOpacity)
      .find((node) =>
        node
          .findAllByType(Text)
          .some((text) => text.props.children === 'Отменить'),
      );
    await act(async () => undo.props.onPress());
    expect(controls.undo).toHaveBeenCalledTimes(1);
  });
});
