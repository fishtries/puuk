import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ActivityIndicator } from 'react-native';
import TrackLoadingBadge from '../TrackLoadingBadge';

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
    LinearTransition: createChain(),
    Easing: {
      bezier: () => () => {},
      inOut: () => () => {},
      ease: () => {},
    },
    FadeIn: {
      duration: () => ({}),
    },
    FadeOut: {
      duration: () => ({}),
    },
  };
});

describe('TrackLoadingBadge', () => {
  it('returns null when idle and not slow', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TrackLoadingBadge
          isLoading={false}
          isBufferingSlow={false}
          networkStatus="good"
          nextTrackStatus="idle"
        />
      );
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders loading spinner without text when loading on good network', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TrackLoadingBadge
          isLoading={true}
          isBufferingSlow={false}
          networkStatus="good"
        />
      );
    });
    const root = renderer.root;
    const spinner = root.findByType(ActivityIndicator);
    expect(spinner).toBeTruthy();
    const texts = root.findAllByType('Text');
    expect(texts.length).toBe(0);
  });

  it('renders loading spinner with "kinda slow" text when buffering is slow', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TrackLoadingBadge
          isLoading={true}
          isBufferingSlow={true}
          networkStatus="good"
        />
      );
    });
    const root = renderer.root;
    const spinner = root.findByType(ActivityIndicator);
    expect(spinner).toBeTruthy();
    const texts = root.findAllByType('Text');
    expect(texts.length).toBe(1);
    expect(texts[0].props.children).toBe('kinda slow');
  });

  it('does not show a loading spinner for network quality alone', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TrackLoadingBadge
          isLoading={false}
          isBufferingSlow={false}
          networkStatus="slow"
        />
      );
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('does not show a loading spinner for background preloading', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TrackLoadingBadge
          isLoading={false}
          isBufferingSlow={false}
          networkStatus="good"
          nextTrackStatus="downloading"
        />
      );
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('hides when current loading finishes even while the next track downloads', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TrackLoadingBadge isLoading={true} nextTrackStatus="downloading" />,
      );
    });
    expect(renderer.root.findByType(ActivityIndicator)).toBeTruthy();

    await act(async () => {
      renderer.update(
        <TrackLoadingBadge isLoading={false} nextTrackStatus="downloading" />,
      );
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('shows ongoing slow buffering after initial loading finishes', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TrackLoadingBadge isLoading={false} isBufferingSlow={true} />,
      );
    });
    expect(renderer.root.findByType(ActivityIndicator)).toBeTruthy();
    expect(renderer.root.findByType('Text').props.children).toBe('kinda slow');

    await act(async () => {
      renderer.update(<TrackLoadingBadge isBufferingSlow={false} />);
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('uses entering and exiting fade animations for appearance in place', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TrackLoadingBadge
          isLoading={true}
          isBufferingSlow={false}
          networkStatus="good"
        />
      );
    });
    const root = renderer.root;
    const animatedView = root.children[0];
    expect(animatedView.props.entering).toBeDefined();
    expect(animatedView.props.exiting).toBeDefined();
  });
});
