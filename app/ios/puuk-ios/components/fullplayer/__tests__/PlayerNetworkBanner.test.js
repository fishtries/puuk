import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import PlayerNetworkBanner from '../PlayerNetworkBanner';
import { TRACK_STATUS } from '../../../utils/preloadScheduler';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

describe('PlayerNetworkBanner', () => {
  it('returns null when nextTrackStatus is DOWNLOADING (no "Подготовка следующего трека" banner)', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <PlayerNetworkBanner
          networkStatus="good"
          nextTrackStatus={TRACK_STATUS.DOWNLOADING}
          isBufferingSlow={false}
        />
      );
    });

    expect(renderer.toJSON()).toBeNull();
  });

  it('returns null in default/idle state', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <PlayerNetworkBanner
          networkStatus="good"
          nextTrackStatus={TRACK_STATUS.IDLE}
        />
      );
    });

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders error banner when networkStatus is error or nextTrackStatus is FAILED', () => {
    const onRetry = jest.fn();
    const onSkip = jest.fn();

    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <PlayerNetworkBanner
          networkStatus="error"
          nextTrackStatus={TRACK_STATUS.FAILED}
          networkError="Сбой загрузки"
          onRetry={onRetry}
          onSkip={onSkip}
        />
      );
    });

    const root = renderer.root;
    const textNodes = root.findAllByType('Text');
    const texts = textNodes.map((n) => n.props.children);
    expect(texts).toContain('Сбой загрузки');
    expect(texts).toContain('Повторить');
    expect(texts).toContain('Пропустить');

    // Trigger action buttons
    const retryBtn = root.find((n) => n.props?.onPress === onRetry);
    const skipBtn = root.find((n) => n.props?.onPress === onSkip);
    expect(retryBtn).toBeTruthy();
    expect(skipBtn).toBeTruthy();

    act(() => {
      retryBtn.props.onPress();
    });
    expect(onRetry).toHaveBeenCalled();

    act(() => {
      skipBtn.props.onPress();
    });
    expect(onSkip).toHaveBeenCalled();
  });
});
