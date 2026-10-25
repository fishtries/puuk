import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import FullPlayerModal from '../../FullPlayerModal';
import TrackLoadingBadge from '../TrackLoadingBadge';
import { MenuView } from '@react-native-menu/menu';
import styles from '../playerStyles';
import PlayerHeader, { isNativeMenuAvailable } from '../PlayerHeader';
import { ActionSheetIOS, TouchableOpacity } from 'react-native';
import Constants from 'expo-constants';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');
jest.mock('../lyrics/AppleLyricsView', () => 'AppleLyricsView');
jest.mock('../QueuePanel', () => 'QueuePanel');
jest.mock('../PlayerControls', () => 'PlayerControls');
jest.mock('../PlayerNetworkBanner', () => 'PlayerNetworkBanner');
jest.mock('../ChasingArrowsIcon', () => 'ChasingArrowsIcon');
jest.mock('../ProgressBar', () => 'ProgressBar');
jest.mock('../AmbientBackground', () => 'AmbientBackground');

jest.mock('@react-native-menu/menu', () => {
  const { View } = require('react-native');
  return {
    MenuView: (props) => <View testID="native-menu-view" {...props} />,
  };
});

jest.mock('react-native-safe-area-context', () => ({
  initialWindowMetrics: {
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  },
}));

jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    GestureDetector: ({ children }) => <View>{children}</View>,
    GestureHandlerRootView: ({ children }) => <View>{children}</View>,
    Gesture: {
      Simultaneous: () => ({}),
      Race: (...gestures) => gestures,
      Pan: () => {
        const gesture = {
          enabled: () => gesture,
          activeOffsetY: () => gesture,
          activeOffsetX: () => gesture,
          failOffsetX: () => gesture,
          failOffsetY: () => gesture,
          onStart: () => gesture,
          onUpdate: () => gesture,
          onEnd: () => gesture,
          onFinalize: () => gesture,
        };
        return gesture;
      },
    },
  };
});

jest.mock('react-native-reanimated', () => {
  const { View, Text } = require('react-native');
  const createChain = () => {
    const chain = {
      springify: () => chain,
      damping: () => chain,
      stiffness: () => chain,
      duration: () => chain,
      easing: () => chain,
    };
    return chain;
  };
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (Comp) => Comp,
      View,
      Text,
    },
    useSharedValue: (init) => ({ value: init }),
    useAnimatedStyle: (fn) => fn(),
    withSpring: (to) => to,
    withTiming: (to) => to,
    withSequence: (...args) => args[0],
    cancelAnimation: jest.fn(),
    runOnJS: (fn) => fn,
    interpolate: () => 1,
    Extrapolation: { CLAMP: 'clamp' },
    Easing: {
      bezier: () => () => {},
    },
    FadeIn: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
    LinearTransition: createChain(),
  };
});

describe('FullPlayerModal - Native Pop-up button & swapped order', () => {
  const mockTrack = {
    id: 'track-42',
    title: 'Bohemian Rhapsody',
    artist: 'Queen',
    coverArt: 'https://puuk.app/cover.jpg',
  };

  it('renders TrackLoadingBadge before MenuView in topHeaderRight', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={mockTrack}
          isPlaying={true}
          currentTime={15}
          duration={354}
          isLoading={true}
        />,
      );
    });

    const root = renderer.root;
    // Find the header right container
    const headerRight = root.find(
      (n) => n.props?.style === styles.topHeaderRight,
    );
    expect(headerRight).toBeTruthy();

    const children = headerRight.props.children;
    // Child 0: TrackLoadingBadge (значок загрузки / kinda slow слева)
    expect(children[0].type).toBe(TrackLoadingBadge);
    // Child 1: MenuView (нативный компонент поп ап кнопки справа)
    expect(children[1].type).toBe(MenuView);
  });

  it('configures native MenuView as a pop-up button and handles action callbacks', async () => {
    const onAddToPlaylist = jest.fn();
    const onEditTrack = jest.fn();

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={mockTrack}
          isPlaying={true}
          currentTime={15}
          duration={354}
          onAddToPlaylist={onAddToPlaylist}
          onEditTrack={onEditTrack}
          isLoading={false}
        />,
      );
    });

    const root = renderer.root;
    const menuView = root.findByProps({ testID: 'native-menu-view' });
    expect(menuView).toBeTruthy();

    // Verify pop-up button configuration (shouldOpenOnLongPress = false => primary action popup)
    expect(menuView.props.shouldOpenOnLongPress).toBe(false);
    expect(menuView.props.title).toBe('Bohemian Rhapsody');
    expect(menuView.props.actions).toEqual([
      { id: 'add_to_playlist', title: 'Add to Playlist', image: 'plus.circle' },
      { id: 'edit_track', title: 'Edit Track', image: 'pencil' },
    ]);

    // Select "Add to Playlist"
    act(() => {
      menuView.props.onPressAction({
        nativeEvent: { event: 'add_to_playlist' },
      });
    });
    expect(onAddToPlaylist).toHaveBeenCalledWith(mockTrack);

    // Select "Edit Track"
    act(() => {
      menuView.props.onPressAction({ nativeEvent: { event: 'edit_track' } });
    });
    expect(onEditTrack).toHaveBeenCalledWith(mockTrack);
  });

  it('does not have layout sliding animation on topHeaderRight so badge appears in place with fade', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={mockTrack}
          isPlaying={true}
          currentTime={15}
          duration={354}
          isLoading={true}
        />,
      );
    });

    const root = renderer.root;
    const headerRight = root.find(
      (n) => n.props?.style === styles.topHeaderRight,
    );
    expect(headerRight).toBeTruthy();
    // topHeaderRight should be a standard View without layout spring transitions
    expect(headerRight.props.layout).toBeUndefined();
  });

  it('provides ActionSheet fallback in PlayerHeader when native menu is unavailable', () => {
    const handleMenuAction = jest.fn();
    const showActionSheetSpy = jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((opts, cb) => {
        cb(1); // Select first action: "Add to Playlist"
      });

    // Mock NODE_ENV to simulate non-test environment where native menu is missing
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    Constants.appOwnership = 'expo';

    try {
      expect(isNativeMenuAvailable()).toBe(false);

      let renderer;
      act(() => {
        renderer = TestRenderer.create(
          <PlayerHeader
            styles={styles}
            handleClose={jest.fn()}
            isLoading={false}
            isBufferingSlow={false}
            networkStatus="connected"
            nextTrackStatus="idle"
            displayTitle="Bohemian Rhapsody"
            handleMenuAction={handleMenuAction}
            menuActions={[
              { id: 'add_to_playlist', title: 'Add to Playlist' },
              { id: 'edit_track', title: 'Edit Track' },
            ]}
          />,
        );
      });

      const root = renderer.root;
      // In fallback mode, a TouchableOpacity is rendered instead of native MenuView
      const buttons = root.findAllByType(TouchableOpacity);
      const menuButton = buttons.find(
        (b) => b.props.accessibilityLabel === 'Track options',
      );
      expect(menuButton).toBeTruthy();

      // Trigger fallback press
      act(() => {
        menuButton.props.onPress();
      });

      expect(showActionSheetSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Bohemian Rhapsody',
          options: ['Cancel', 'Add to Playlist', 'Edit Track'],
          cancelButtonIndex: 0,
        }),
        expect.any(Function),
      );
      expect(handleMenuAction).toHaveBeenCalledWith({
        nativeEvent: { event: 'add_to_playlist' },
      });
    } finally {
      process.env.NODE_ENV = origEnv;
      delete Constants.appOwnership;
      showActionSheetSpy.mockRestore();
    }
  });
});
