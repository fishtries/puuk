import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ActivityIndicator } from 'react-native';
import TrackLoadingBadge from '../TrackLoadingBadge';

jest.mock('react-native-reanimated', () => {
  const { View, Text } = require('react-native');
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (Comp) => Comp,
      View,
      Text,
    },
    LinearTransition: {
      springify: () => ({
        damping: () => ({ stiffness: () => ({}) }),
      }),
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

  it('renders "kinda slow" text when networkStatus is slow even if isLoading is false', async () => {
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
    const root = renderer.root;
    const texts = root.findAllByType('Text');
    expect(texts.length).toBe(1);
    expect(texts[0].props.children).toBe('kinda slow');
  });

  it('renders spinner without text when nextTrackStatus is downloading', async () => {
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
    const root = renderer.root;
    const spinner = root.findByType(ActivityIndicator);
    expect(spinner).toBeTruthy();
    const texts = root.findAllByType('Text');
    expect(texts.length).toBe(0);
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
