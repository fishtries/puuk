import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Switch, Text, Alert } from 'react-native';
import { clearOrdinaryAudioCache } from '../../../offline/availability';
jest.mock('../../../offline/availability', () => ({ clearOrdinaryAudioCache: jest.fn() }));
jest.mock('../OfflineSettings', () => () => null);
import LoginModal from '../LoginModal';
import { getSettings, updateSetting, addSettingsListener, t } from '../../../shared/storage/settings';

jest.mock('../../../shared/api/api', () => ({
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
  test.each([
    ['complete', { freedBytes: 5000, failedFiles: 0 }, t('cacheCleared')],
    ['partial', { freedBytes: 5000, failedFiles: 1 }, 'Cache partially cleared'],
    ['no space freed', { freedBytes: 0, failedFiles: 1 }, 'Could not clear cache'],
    ['protected or absent files', { freedBytes: 0, failedFiles: 0 }, t('cacheCleared')],
    ['error', null, 'Could not clear cache'],
  ])('cache confirmation reports the %s result', async (_scenario, result, message) => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    if (result) clearOrdinaryAudioCache.mockResolvedValueOnce(result);
    else clearOrdinaryAudioCache.mockRejectedValueOnce(new Error('disk error'));
    let renderer;
    await act(async () => { renderer = TestRenderer.create(<LoginModal visible onClose={jest.fn()} />); });
    const label = renderer.root.findAllByType(Text).find(node => node.props.children === t('clearCache'));
    let control = label.parent;
    while (control && typeof control.props.onPress !== 'function') control = control.parent;
    expect(control).toBeTruthy();
    await act(async () => control.props.onPress());
    const confirm = alert.mock.calls[0][2].find(button => button.style === 'destructive');
    expect(clearOrdinaryAudioCache).not.toHaveBeenCalled();
    await act(async () => { await confirm.onPress(); });
    expect(clearOrdinaryAudioCache).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[1][1]).toBe(message);
    alert.mockRestore();
    await act(async () => renderer.unmount());
  });

});
