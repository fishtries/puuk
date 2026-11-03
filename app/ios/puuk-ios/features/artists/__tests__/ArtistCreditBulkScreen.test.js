import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import ArtistCreditBulkScreen from '../ArtistCreditBulkScreen';
import ArtistCreditsEditor from '../../../shared/components/ArtistCreditsEditor';
import {
  previewArtistReplacement,
  applyArtistReplacement,
} from '../../../shared/api/artistCredits';

jest.mock(
  '../../../shared/components/ArtistCreditsEditor',
  () => 'ArtistCreditsEditor',
);
jest.mock('../../../shared/api/artistCredits', () => ({
  previewArtistReplacement: jest.fn(),
  applyArtistReplacement: jest.fn(),
}));
const navigation = { goBack: jest.fn() };
const route = { params: { artistId: 'source-id', artistName: 'A&B' } };
const admin = { role: 'admin' };
const plan = {
  operation_id: 'operation-1',
  matched_count: 1,
  changed_count: 1,
  entries: [
    {
      entity_type: 'track',
      entity_id: 't1',
      before: [{ id: 'source-id', name: 'A&B' }],
      after: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    },
  ],
};
let tree;
const button = (label) => tree.root.findByProps({ accessibilityLabel: label });
const press = async (label) => {
  await act(async () => button(label).props.onPress());
};
beforeEach(() => {
  jest.clearAllMocks();
});
async function render(user = admin) {
  await act(async () => {
    tree = TestRenderer.create(
      <ArtistCreditBulkScreen
        route={route}
        navigation={navigation}
        currentUser={user}
      />,
    );
  });
}
async function choose() {
  await act(async () =>
    tree.root
      .findByType(ArtistCreditsEditor)
      .props.onSaveDraft(
        [{ id: 'a' }, { name: 'B' }],
        [{ id: 'a', name: 'A' }, { name: 'B' }],
      ),
  );
}

test('preview shows before and after, applies exact operation and separates album scope', async () => {
  previewArtistReplacement.mockResolvedValue(plan);
  applyArtistReplacement.mockResolvedValue({
    operation_id: 'operation-1',
    changed_count: 1,
  });
  await render();
  await choose();
  await press('Альбомы');
  await press('Предварительный просмотр');
  expect(previewArtistReplacement).toHaveBeenCalledWith('source-id', 'albums', [
    { id: 'a' },
    { name: 'B' },
  ]);
  expect(tree.root.find((node) => Array.isArray(node.props.children) && node.props.children[0] === 'Было: ' && node.props.children[1] === 'A&B')).toBeDefined();
  expect(
    tree.root.find((node) => Array.isArray(node.props.children) && node.props.children[0] === 'Станет: ' && node.props.children[1] === 'A, B'),
  ).toBeDefined();
  await press('Применить исправление');
  expect(applyArtistReplacement).toHaveBeenCalledWith(
    'source-id',
    'operation-1',
  );
  expect(tree.root.findByProps({ testID: 'bulk-result' })).toBeDefined();
});

test('conflict preserves draft and requires a fresh preview', async () => {
  previewArtistReplacement.mockResolvedValue(plan);
  applyArtistReplacement.mockRejectedValue({ status: 409 });
  await render();
  await choose();
  await press('Предварительный просмотр');
  await press('Применить исправление');
  expect(tree.root.findAllByProps({ testID: 'bulk-preview' })).toHaveLength(0);
  expect(
    tree.root.findByProps({ accessibilityRole: 'alert' }).props.children,
  ).toContain('снова');
  expect(
    tree.root.findByType(ArtistCreditsEditor).props.entity.artists,
  ).toEqual([{ id: 'a', name: 'A' }, { name: 'B' }]);
  await press('Предварительный просмотр');
  expect(previewArtistReplacement).toHaveBeenCalledTimes(2);
});

test('network failure can retry the same operation', async () => {
  previewArtistReplacement.mockResolvedValue(plan);
  applyArtistReplacement
    .mockRejectedValueOnce({ message: 'offline' })
    .mockResolvedValueOnce({ changed_count: 1 });
  await render();
  await press('Предварительный просмотр');
  await press('Применить исправление');
  await press('Применить исправление');
  expect(applyArtistReplacement.mock.calls).toEqual([
    ['source-id', 'operation-1'],
    ['source-id', 'operation-1'],
  ]);
});

test('non-admin cannot preview or apply and server 403 is shown', async () => {
  await render({ role: 'user' });
  expect(tree.root.findByProps({ accessibilityRole: 'alert' })).toBeDefined();
  expect(previewArtistReplacement).not.toHaveBeenCalled();
  await render();
  previewArtistReplacement.mockRejectedValue({ status: 403 });
  await press('Предварительный просмотр');
  expect(
    tree.root.findByProps({ accessibilityRole: 'alert' }).props.children,
  ).toContain('прав');
});
