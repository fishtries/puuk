import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import FullPlayerModal from '../../FullPlayerModal';
import TrackLoadingBadge from '../TrackLoadingBadge';
import { MenuView } from '@react-native-menu/menu';
import styles from '../playerStyles';
import PlayerHeader, { isNativeMenuAvailable } from '../PlayerHeader';
import { ActionSheetIOS, TouchableOpacity, Text } from 'react-native';
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

  it('does not give the empty player a track ID for background or lyrics requests', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <FullPlayerModal isPlayerVisible={true} currentTrack={null} />,
      );
    });
    expect(renderer.root.findByType('AmbientBackground').props.currentTrack.id).toBeUndefined();
    expect(renderer.root.findByType('AppleLyricsView').props.currentTrack.id).toBeUndefined();
    await act(async () => renderer.unmount());
  });

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
    expect(menuView.props.title).toBeUndefined();
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
          options: ['Cancel', 'Add to Playlist', 'Edit Track'],
          cancelButtonIndex: 0,
        }),
        expect.any(Function),
      );
      expect(showActionSheetSpy.mock.calls[0][0].title).toBeUndefined();
      expect(handleMenuAction).toHaveBeenCalledWith({
        nativeEvent: { event: 'add_to_playlist' },
      });
    } finally {
      process.env.NODE_ENV = origEnv;
      delete Constants.appOwnership;
      showActionSheetSpy.mockRestore();
    }
  });

  describe('artist navigation control (contracts 3.4 & 6.2)', () => {
    const artistTrack = {
      id: 'trk-100',
      title: 'Paranoid Android',
      artist: 'Radiohead',
      artist_id: 'art_radiohead_123',
    };

    it('renders accessible tappable artist control with touch target >= 44pt and VoiceOver label', async () => {
      const onArtistPressMock = jest.fn();
      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <FullPlayerModal
            isPlayerVisible={true}
            currentTrack={artistTrack}
            isPlaying={true}
            currentTime={30}
            duration={383}
            onArtistPress={onArtistPressMock}
          />,
        );
      });

      const root = renderer.root;
      const artistButton = root.findByProps({ testID: 'player-artist-button' });
      expect(artistButton).toBeTruthy();
      expect(artistButton.props.accessibilityRole).toBe('button');
      expect(artistButton.props.accessibilityLabel).toBe('Страница артиста Radiohead');
      expect(artistButton.props.hitSlop.top).toBeGreaterThanOrEqual(8);
      expect(artistButton.props.hitSlop.bottom).toBeGreaterThanOrEqual(8);
      expect(artistButton.props.hitSlop.left).toBeGreaterThanOrEqual(8);
      expect(artistButton.props.hitSlop.right).toBeGreaterThanOrEqual(8);
      expect(artistButton.props.style.minHeight).toBeUndefined();

      const artistText = artistButton.findByType(Text);
      expect(artistText.props.children).toBe('Radiohead');
      expect(artistText.props.numberOfLines).toBe(1);
      expect(artistText.props.ellipsizeMode).toBe('tail');
    });

    it('pressing artist control navigates by stable artistId without altering playback or queue', async () => {
      const onArtistPressMock = jest.fn();
      const togglePlayPauseMock = jest.fn();
      const fetchNextTrackMock = jest.fn();
      const playPreviousTrackMock = jest.fn();

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <FullPlayerModal
            isPlayerVisible={true}
            currentTrack={artistTrack}
            isPlaying={true}
            currentTime={30}
            duration={383}
            togglePlayPause={togglePlayPauseMock}
            fetchNextTrack={fetchNextTrackMock}
            playPreviousTrack={playPreviousTrackMock}
            onArtistPress={onArtistPressMock}
          />,
        );
      });

      const root = renderer.root;
      const artistButton = root.findByProps({ testID: 'player-artist-button' });

      act(() => {
        artistButton.props.onPress();
      });

      expect(onArtistPressMock).toHaveBeenCalledTimes(1);
      expect(onArtistPressMock).toHaveBeenCalledWith('art_radiohead_123');

      // Playback and queue controls must be completely untouched
      expect(togglePlayPauseMock).not.toHaveBeenCalled();
      expect(fetchNextTrackMock).not.toHaveBeenCalled();
      expect(playPreviousTrackMock).not.toHaveBeenCalled();
    });

    it('does not render tappable button when artist_id is missing', async () => {
      const trackWithoutArtistId = {
        id: 'trk-101',
        title: 'Various Song',
        artist: 'Various Artists',
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <FullPlayerModal
            isPlayerVisible={true}
            currentTrack={trackWithoutArtistId}
            isPlaying={true}
            currentTime={10}
            duration={200}
            onArtistPress={jest.fn()}
          />,
        );
      });

      const root = renderer.root;
      expect(root.findAllByProps({ testID: 'player-artist-button' })).toHaveLength(0);

      const texts = root.findAllByType(Text);
      const plainArtistText = texts.find((t) => t.props.children === 'Various Artists');
      expect(plainArtistText).toBeTruthy();
      expect(plainArtistText.props.numberOfLines).toBe(1);
      expect(plainArtistText.props.ellipsizeMode).toBe('tail');
    });

    it('does not render tappable button when onArtistPress is not provided', async () => {
      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <FullPlayerModal
            isPlayerVisible={true}
            currentTrack={artistTrack}
            isPlaying={true}
            currentTime={10}
            duration={200}
          />,
        );
      });

      const root = renderer.root;
      expect(root.findAllByProps({ testID: 'player-artist-button' })).toHaveLength(0);
    });

    it('renders long artist names with ellipsis without breaking layout', async () => {
      const longArtistTrack = {
        id: 'trk-102',
        title: 'Epic Journey',
        artist: 'A Very Long Symphony Orchestra Featuring Multiple Guest Soloists And Ensemble Collaborators',
        artist_id: 'art_long_456',
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <FullPlayerModal
            isPlayerVisible={true}
            currentTrack={longArtistTrack}
            isPlaying={true}
            currentTime={0}
            duration={600}
            onArtistPress={jest.fn()}
          />,
        );
      });

      const root = renderer.root;
      const artistButton = root.findByProps({ testID: 'player-artist-button' });
      expect(artistButton).toBeTruthy();
      const text = artistButton.findByType(Text);
      expect(text.props.numberOfLines).toBe(1);
      expect(text.props.ellipsizeMode).toBe('tail');
    });
  });
});
