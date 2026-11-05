import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ActivityIndicator, TouchableOpacity, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import SyncHeaderIndicator from '../SyncHeaderIndicator';
import SyncStatusModal from '../SyncStatusModal';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

describe('SyncHeaderIndicator component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('исчезает при отсутствии активных операций и ошибок (idle)', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <SyncHeaderIndicator
          syncStatus={{
            isLoading: false,
            hasError: false,
            isServerUnavailable: false,
            isNetworkError: false,
            errors: [],
          }}
        />,
      );
    });

    expect(renderer.toJSON()).toBeNull();
  });

  test('отображает небольшую крутилку при активной фоновой операции', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <SyncHeaderIndicator
          syncStatus={{
            isLoading: true,
            hasError: false,
            isServerUnavailable: false,
            isNetworkError: false,
            errors: [],
          }}
        />,
      );
    });

    const root = renderer.root;
    const spinner = root.findByType(ActivityIndicator);
    expect(spinner).toBeTruthy();
    expect(spinner.props.size).toBe('small');

    const button = root.findByProps({ testID: 'sync-header-indicator' });
    expect(button.props.accessibilityLabel).toBe('Синхронизация данных');
  });

  test('отображает спокойную иконку при ошибке соединения', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <SyncHeaderIndicator
          syncStatus={{
            isLoading: false,
            hasError: true,
            isServerUnavailable: false,
            isNetworkError: true,
            errors: [{ id: 'catalog', error: { message: 'Network failed' } }],
          }}
        />,
      );
    });

    const root = renderer.root;
    const icon = root.findByProps({ testID: 'sync-indicator-error-icon' });
    expect(icon).toBeTruthy();
    expect(icon.props.name).toBe('cloud-offline-outline');
    expect(icon.props.color).toBe('#E5A93C');

    const button = root.findByProps({ testID: 'sync-header-indicator' });
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.hitSlop).toEqual({
      top: 10,
      bottom: 10,
      left: 10,
      right: 10,
    });
  });

  test('нажатие на ошибку открывает краткий статус и действие «Повторить»', () => {
    const onRetryMock = jest.fn();
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <SyncHeaderIndicator
          onRetry={onRetryMock}
          syncStatus={{
            isLoading: false,
            hasError: true,
            isServerUnavailable: false,
            isNetworkError: true,
            errors: [{ id: 'catalog', error: { message: 'Network failed' } }],
          }}
        />,
      );
    });

    const root = renderer.root;
    const button = root.findByProps({ testID: 'sync-header-indicator' });

    // Тап по иконке ошибки
    act(() => {
      button.props.onPress();
    });

    const modal = root.findByType(SyncStatusModal);
    expect(modal.props.visible).toBe(true);

    const retryBtn = root.findByProps({ testID: 'sync-modal-retry-button' });
    act(() => {
      retryBtn.props.onPress();
    });

    expect(onRetryMock).toHaveBeenCalledTimes(1);
    expect(modal.props.visible).toBe(false);
  });

  test('для 5xx сообщает о недоступности сервера, не утверждая, что у телефона нет интернета', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <SyncStatusModal
          visible={true}
          onClose={() => {}}
          onRetry={() => {}}
          isServerUnavailable={true}
          isNetworkError={false}
          errors={[{ id: 'catalog', error: { status: 500 } }]}
        />,
      );
    });

    const root = renderer.root;
    const texts = root.findAllByType(Text);
    const titleText = texts.find((t) => t.props.children === 'Сервер недоступен');
    expect(titleText).toBeTruthy();

    const bodyText = texts.find((t) =>
      String(t.props.children).includes('Сервер Puuk временно недоступен (ошибка 5xx)'),
    );
    expect(bodyText).toBeTruthy();
    // Не утверждает, что у телефона нет интернета!
    expect(String(bodyText.props.children)).not.toContain('нет интернета');
  });
});
