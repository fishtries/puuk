import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { TouchableOpacity, Text } from 'react-native';
import RecentlyListenedSection, {
  RecentlyListenedCard,
  chunkTracksIntoColumns,
} from '../RecentlyListenedSection';

jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');

describe('RecentlyListenedSection', () => {
  describe('chunkTracksIntoColumns', () => {
    test('chunks array into columns of 2 tracks per column', () => {
      expect(chunkTracksIntoColumns([])).toEqual([]);
      expect(chunkTracksIntoColumns(null)).toEqual([]);
      const tracks = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const columns = chunkTracksIntoColumns(tracks, 2);
      expect(columns).toHaveLength(2);
      expect(columns[0]).toHaveLength(2);
      expect(columns[1]).toHaveLength(1);
    });
  });
  const mockTracks = [
    {
      id: 1,
      title: 'Track One',
      artist: 'Artist One',
      coverArt: 'http://cov1.jpg',
    },
    {
      id: 2,
      title: 'Track Two',
      artist: 'Artist Two',
      coverArt: 'http://cov2.jpg',
    },
  ];

  test('returns null when tracks is empty and not loading', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <RecentlyListenedSection tracks={[]} isLoading={false} />,
      );
    });

    expect(renderer.toJSON()).toBeNull();
  });

  test('renders static skeleton when loading and tracks is empty', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <RecentlyListenedSection tracks={[]} isLoading={true} />,
      );
    });

    const root = renderer.root;
    const skeleton = root.findByProps({ testID: 'recently-listened-skeleton' });
    expect(skeleton).toBeTruthy();

    const titleText = root.findByProps({ children: 'Recently listened' });
    expect(titleText).toBeTruthy();
  });

  test('does not show skeletons if tracks are already present during background loading', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <RecentlyListenedSection tracks={mockTracks} isLoading={true} />,
      );
    });

    const root = renderer.root;
    const skeletons = root.findAllByProps({ testID: 'recently-listened-skeleton' });
    expect(skeletons).toHaveLength(0);

    expect(root.findByProps({ testID: 'recently-listened-card-1' })).toBeTruthy();
    expect(root.findByProps({ testID: 'recently-listened-card-2' })).toBeTruthy();
  });

  test('renders cards with title, artist, and accessibility labels', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <RecentlyListenedSection tracks={mockTracks} isLoading={false} />,
      );
    });

    const root = renderer.root;
    const card1 = root.findByProps({ testID: 'recently-listened-card-1' });
    expect(card1.props.accessibilityRole).toBe('button');
    expect(card1.props.accessibilityLabel).toBe('Воспроизвести Track One, Artist One');

    const texts = root.findAllByType(Text).map((t) => t.props.children);
    expect(texts).toContain('Track One');
    expect(texts).toContain('Artist One');
    expect(texts).toContain('Track Two');
    expect(texts).toContain('Artist Two');
  });

  test('tapping card invokes onPlayTrack callback once with track object', () => {
    const onPlayTrack = jest.fn();
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <RecentlyListenedSection
          tracks={mockTracks}
          onPlayTrack={onPlayTrack}
        />,
      );
    });

    const root = renderer.root;
    const card1 = root.findByProps({ testID: 'recently-listened-card-1' });

    act(() => {
      card1.props.onPress();
    });

    expect(onPlayTrack).toHaveBeenCalledTimes(1);
    expect(onPlayTrack).toHaveBeenCalledWith(mockTracks[0]);
  });

  test('tapping ellipsis invokes onPressEllipsis without calling onPlayTrack', () => {
    const onPlayTrack = jest.fn();
    const onPressEllipsis = jest.fn();

    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <RecentlyListenedSection
          tracks={mockTracks}
          onPlayTrack={onPlayTrack}
          onPressEllipsis={onPressEllipsis}
        />,
      );
    });

    const root = renderer.root;
    const ellipsis = root.findByProps({ testID: 'recently-listened-ellipsis-1' });

    act(() => {
      ellipsis.props.onPress({ stopPropagation: jest.fn() });
    });

    expect(onPressEllipsis).toHaveBeenCalledTimes(1);
    expect(onPressEllipsis).toHaveBeenCalledWith(mockTracks[0]);
    expect(onPlayTrack).not.toHaveBeenCalled();
  });

  test('shows playing badge when track matches currentTrack and isPlaying is true', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <RecentlyListenedSection
          tracks={mockTracks}
          currentTrack={{ id: 1 }}
          isPlaying={true}
        />,
      );
    });

    const root = renderer.root;
    const badge = root.findByProps({ testID: 'recently-listened-playing-1' });
    expect(badge).toBeTruthy();
    expect(badge.props.accessibilityLabel).toBe('Воспроизводится');
  });

  test('shows paused badge when track matches currentTrack and isPlaying is false', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <RecentlyListenedSection
          tracks={mockTracks}
          currentTrack={{ id: 1 }}
          isPlaying={false}
        />,
      );
    });

    const root = renderer.root;
    const badge = root.findByProps({ testID: 'recently-listened-paused-1' });
    expect(badge).toBeTruthy();
    expect(badge.props.accessibilityLabel).toBe('На паузе');
  });
});
