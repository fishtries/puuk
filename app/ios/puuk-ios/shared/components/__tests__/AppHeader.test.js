import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { View, TouchableOpacity, Text } from 'react-native';
import AppHeader from '../AppHeader';
import SyncHeaderIndicator from '../SyncHeaderIndicator';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('../../storage/settings', () => ({
  getSettings: jest.fn(() => ({ accentColor: '#FFDAB9' })),
  addSettingsListener: jest.fn(() => () => {}),
}));

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: {
      View,
    },
    useSharedValue: (init) => ({ value: init }),
    useAnimatedStyle: (fn) => fn(),
    withTiming: (to) => to,
    interpolate: (val, input, output) => output[0],
    Easing: {
      out: () => {},
      cubic: () => {},
    },
  };
});

describe('AppHeader with SyncHeaderIndicator integration', () => {
  test('размещает индикатор непосредственно слева от профиля и сохраняет кнопку плейлиста', () => {
    let renderer;
    const onAddPlaylist = jest.fn();
    const onOpenAuthModal = jest.fn();

    act(() => {
      renderer = TestRenderer.create(
        <AppHeader
          activeTab="Library"
          currentUser={{ is_authenticated: true }}
          onAddPlaylist={onAddPlaylist}
          onOpenAuthModal={onOpenAuthModal}
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

    // Ищем контейнер с правыми кнопками
    const views = root.findAllByType(View);
    // Находим View, у которого в детях есть profile button
    const rightContainer = views.find((v) => {
      if (!Array.isArray(v.props.children)) return false;
      return v.props.children.some(
        (child) =>
          React.isValidElement(child) &&
          child.type === SyncHeaderIndicator,
      );
    });

    expect(rightContainer).toBeTruthy();

    // Проверяем порядок элементов в rightContainer:
    // [onAddPlaylist, rightActions, SyncHeaderIndicator, profileButton]
    const children = rightContainer.props.children;
    const indicatorIndex = children.findIndex(
      (c) => React.isValidElement(c) && c.type === SyncHeaderIndicator,
    );
    const profileIndex = children.findIndex(
      (c) =>
        React.isValidElement(c) &&
        c.type === TouchableOpacity &&
        c.props.accessibilityLabel === 'Профиль',
    );

    expect(indicatorIndex).toBeGreaterThan(-1);
    expect(profileIndex).toBeGreaterThan(-1);
    // Индикатор стоит НЕПОСРЕДСТВЕННО слева от профиля!
    expect(indicatorIndex).toBe(profileIndex - 1);
  });
});
