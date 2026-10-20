import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ActivityIndicator } from 'react-native';

import AppAuthGate from '../AppAuthGate';
import LoginModal from '../LoginModal';

jest.mock('../LoginModal', () => jest.fn(() => null));

describe('AppAuthGate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('shows the loading indicator while auth is being checked', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <AppAuthGate
          isChecking
          currentUser={null}
          onLoginSuccess={jest.fn()}
        />,
      );
    });

    expect(renderer.root.findByType(ActivityIndicator).props).toMatchObject({
      size: 'large',
      color: '#FA243C',
    });
    expect(LoginModal).not.toHaveBeenCalled();
  });

  test('shows mandatory login for a signed-out user and forwards login success', () => {
    const onLoginSuccess = jest.fn();

    act(() => {
      TestRenderer.create(
        <AppAuthGate
          isChecking={false}
          currentUser={null}
          onLoginSuccess={onLoginSuccess}
        />,
      );
    });

    expect(LoginModal.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        visible: true,
        mandatory: true,
        currentUser: null,
        onLoginSuccess,
      }),
    );
  });
});
