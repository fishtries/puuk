import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Switch, Text } from 'react-native';
import LoginModal from '../LoginModal';
import { getSettings, updateSetting, addSettingsListener, t } from '../../utils/settings';

jest.mock('../../utils/api', () => ({
  loginWithCode: jest.fn(),
  loginWithPassword: jest.fn(),
  logout: jest.fn(),
  setServerUrl: jest.fn(),
}));

jest.mock('expo-blur', () => ({
  BlurView: 'BlurView',
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

describe('LoginModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders Sound Check setting in Audio & Playback section and allows toggling', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LoginModal visible={true} onClose={jest.fn()} currentUser={null} />
      );
    });

    // Check that sectionAudio and soundCheck labels are rendered
    const textInstances = renderer.root.findAllByType(Text);
    const audioSectionFound = textInstances.some(
      (node) => node.props.children === t('sectionAudio').toUpperCase()
    );
    expect(audioSectionFound).toBe(true);

    const soundCheckLabelFound = textInstances.some(
      (node) => node.props.children === t('soundCheck')
    );
    expect(soundCheckLabelFound).toBe(true);

    // Find the Switch component for Sound Check
    const switches = renderer.root.findAllByType(Switch);
    expect(switches.length).toBeGreaterThanOrEqual(1);

    const soundCheckSwitch = switches[0];
    // By default soundCheck is true
    expect(soundCheckSwitch.props.value).toBe(true);

    // Toggle switch to false
    await act(async () => {
      soundCheckSwitch.props.onValueChange(false);
    });

    expect(getSettings().soundCheck).toBe(false);

    // Toggle switch back to true
    await act(async () => {
      soundCheckSwitch.props.onValueChange(true);
    });

    expect(getSettings().soundCheck).toBe(true);
  });
});
