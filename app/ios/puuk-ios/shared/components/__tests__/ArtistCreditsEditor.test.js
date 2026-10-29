import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Modal, TextInput, TouchableOpacity } from 'react-native';
import ArtistCreditsEditor from '../ArtistCreditsEditor';
import { setTrackArtists } from '../../api/artistCredits';

jest.mock('../../api/artistCredits', () => ({ setTrackArtists: jest.fn(), setAlbumArtists: jest.fn() }));
jest.mock('../../api/artists', () => ({ getArtists: jest.fn() }));

const press = async (root, label) => { const button = root.findAllByType(TouchableOpacity).find((node) => node.props.accessibilityLabel === label); await act(async () => { await button.props.onPress(); }); };
const create = async (props = {}) => {
  let tree;
  await act(async () => { tree = TestRenderer.create(<ArtistCreditsEditor visible entity={{ artists: [{ id: 'a', name: 'A' }], artists_revision: 2 }} entityId="t" scope="track" onClose={jest.fn()} onSaved={jest.fn()} {...props} />); });
  await act(async () => { tree.root.findByType(Modal).props.onShow(); });
  return tree;
};
beforeEach(() => jest.clearAllMocks());
test('conflict preserves draft and requires explicit revision reload before retry', async () => {
  const saved = jest.fn(); const close = jest.fn();
  setTrackArtists.mockRejectedValueOnce({ code: 'artists_revision_conflict', current_revision: 3, artists: [{ id: 'b', name: 'B' }] }).mockResolvedValueOnce({ artists: [{ id: 'a', name: 'A' }], artists_revision: 4 });
  const tree = await create({ onSaved: saved, onClose: close });
  await act(async () => tree.root.findByType(TextInput).props.onChangeText('New'));
  await press(tree.root, 'Добавить новое имя: New');
  await press(tree.root, 'Сохранить состав в Puuk');
  expect(saved).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  await press(tree.root, 'Обновить ревизию и продолжить правку');
  await press(tree.root, 'Сохранить состав в Puuk');
  expect(setTrackArtists).toHaveBeenLastCalledWith('t', [{ id: 'a' }, { name: 'New' }], 3);
  expect(saved).toHaveBeenCalledWith({ artists: [{ id: 'a', name: 'A' }], artists_revision: 4 });
});
test('failure and cancel do not report success', async () => {
  const saved = jest.fn(); const close = jest.fn(); setTrackArtists.mockRejectedValueOnce(new Error('offline'));
  const tree = await create({ onSaved: saved, onClose: close });
  await press(tree.root, 'Сохранить состав в Puuk');
  expect(saved).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  await press(tree.root, 'Отмена'); expect(close).toHaveBeenCalledTimes(1);
});
test('local draft returns selectors and ordered display names without a PUT', async () => {
  const saveDraft = jest.fn();
  const tree = await create({ onSaveDraft: saveDraft });
  await act(async () => tree.root.findByType(TextInput).props.onChangeText('New'));
  await press(tree.root, 'Добавить новое имя: New');
  await press(tree.root, 'Сохранить состав в Puuk');
  expect(saveDraft).toHaveBeenCalledWith([{ id: 'a' }, { name: 'New' }], [{ id: 'a', name: 'A' }, { name: 'New' }]);
  expect(setTrackArtists).not.toHaveBeenCalled();
});
