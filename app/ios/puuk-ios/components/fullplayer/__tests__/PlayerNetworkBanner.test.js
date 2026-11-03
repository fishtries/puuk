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
        />,
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
        />,
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
        />,
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

  it('renders recovering banner when current.status is recovering', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <PlayerNetworkBanner
          current={{ status: 'recovering', error: null }}
          networkStatus="slow"
        />,
      );
    });

    const root = renderer.root;
    const textNodes = root.findAllByType('Text');
    const texts = textNodes.map((n) => n.props.children);
    expect(texts).toContain('Восстановление воспроизведения...');
    // No action buttons during automatic recovery
    const retryButtons = root.findAll(
      (n) => n.props?.accessibilityLabel === 'Повторить',
    );
    expect(retryButtons.length).toBe(0);
  });

  it('renders safe category error strings for current track errors without raw text', () => {
    const errorKinds = [
      { kind: 'auth', expected: 'Ошибка авторизации' },
      { kind: 'not_found', expected: 'Трек недоступен', retryable: false },
      { kind: 'timeout', expected: 'Таймаут воспроизведения' },
      { kind: 'transient', expected: 'Ошибка сети при воспроизведении' },
      { kind: 'playback', expected: 'Ошибка воспроизведения' },
    ];

    for (const { kind, expected, retryable } of errorKinds) {
      let renderer;
      const onRetryCurrent = jest.fn();
      const onSkip = jest.fn();

      act(() => {
        renderer = TestRenderer.create(
          <PlayerNetworkBanner
            current={{
              status: 'error',
              error: {
                kind,
                retryable: retryable ?? true,
                message: 'https://secret.token.com/leak/error',
              },
            }}
            networkStatus="error"
            onRetryCurrent={onRetryCurrent}
            onSkip={onSkip}
          />,
        );
      });

      const root = renderer.root;
      const textNodes = root.findAllByType('Text');
      const texts = textNodes.map((n) => n.props.children);

      expect(texts).toContain(expected);
      // Ensure no raw message or URL leak
      expect(texts.some((t) => String(t).includes('secret.token'))).toBe(false);

      if (retryable === false) {
        expect(texts).not.toContain('Повторить');
      } else {
        expect(texts).toContain('Повторить');
        const retryBtn = root.find((n) => n.props?.onPress === onRetryCurrent);
        act(() => {
          retryBtn.props.onPress();
        });
        expect(onRetryCurrent).toHaveBeenCalled();
      }
    }
  });

  it('renders next-failure banner and routes retry to onRetryNext when current track is healthy', () => {
    const onRetryCurrent = jest.fn();
    const onRetryNext = jest.fn();
    const onSkip = jest.fn();

    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <PlayerNetworkBanner
          current={{ status: 'playing', error: null }}
          next={{ status: TRACK_STATUS.FAILED, error: { kind: 'network' } }}
          nextTrackStatus={TRACK_STATUS.FAILED}
          networkStatus="error"
          onRetryCurrent={onRetryCurrent}
          onRetryNext={onRetryNext}
          onSkip={onSkip}
        />,
      );
    });

    const root = renderer.root;
    const textNodes = root.findAllByType('Text');
    const texts = textNodes.map((n) => n.props.children);
    expect(texts).toContain('Сбой загрузки следующего трека');
    expect(texts).toContain('Повторить');

    const retryBtn = root.find((n) => n.props?.onPress === onRetryNext);
    act(() => {
      retryBtn.props.onPress();
    });
    expect(onRetryNext).toHaveBeenCalled();
    expect(onRetryCurrent).not.toHaveBeenCalled();
  });

  it('prioritizes current track error over next track failure', () => {
    const onRetryCurrent = jest.fn();
    const onRetryNext = jest.fn();

    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <PlayerNetworkBanner
          current={{
            status: 'error',
            error: { kind: 'timeout', retryable: true },
          }}
          next={{ status: TRACK_STATUS.FAILED, error: { kind: 'network' } }}
          networkStatus="error"
          onRetryCurrent={onRetryCurrent}
          onRetryNext={onRetryNext}
        />,
      );
    });

    const root = renderer.root;
    const textNodes = root.findAllByType('Text');
    const texts = textNodes.map((n) => n.props.children);

    expect(texts).toContain('Таймаут воспроизведения');
    expect(texts).not.toContain('Сбой загрузки следующего трека');

    const retryBtn = root.find((n) => n.props?.onPress === onRetryCurrent);
    act(() => {
      retryBtn.props.onPress();
    });
    expect(onRetryCurrent).toHaveBeenCalled();
    expect(onRetryNext).not.toHaveBeenCalled();
  });
});
