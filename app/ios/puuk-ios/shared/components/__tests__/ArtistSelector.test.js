import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Modal } from 'react-native';
import ArtistSelector from '../ArtistSelector';

const credits = [
  { id: 'a', name: 'Artist A' },
  {
    id: 'b',
    name: 'A very long artist name that should remain available in full',
  },
];
const render = (entity, onSelect, identity = 'track-1') => (
  <ArtistSelector
    entity={entity}
    identity={identity}
    display="Artist A, Artist B"
    onSelect={onSelect}
    triggerTestID="artist-button"
  />
);

test('empty is plain and singleton navigates directly', () => {
  const select = jest.fn();
  let tree;
  act(() => {
    tree = TestRenderer.create(render({ artists: [] }, select));
  });
  expect(tree.root.findAllByProps({ testID: 'artist-button' })).toHaveLength(0);
  act(() => {
    tree.update(render({ artists: [credits[0]] }, select));
  });
  act(() => tree.root.findByProps({ testID: 'artist-button' }).props.onPress());
  expect(select).toHaveBeenCalledWith('a');
});

test('multiple artists support cancel and selection with accessible full names', () => {
  const select = jest.fn();
  let tree;
  act(() => {
    tree = TestRenderer.create(render({ artists: credits }, select));
  });
  act(() => tree.root.findByProps({ testID: 'artist-button' }).props.onPress());
  expect(tree.root.findByType(Modal).props.visible).toBe(true);
  act(() =>
    tree.root.findByProps({ accessibilityLabel: 'Отмена' }).props.onPress(),
  );
  expect(select).not.toHaveBeenCalled();
  expect(tree.root.findByType(Modal).props.visible).toBe(false);
  act(() => tree.root.findByProps({ testID: 'artist-button' }).props.onPress());
  act(() =>
    tree.root
      .findByProps({
        accessibilityLabel: `Страница артиста ${credits[1].name}`,
      })
      .props.onPress(),
  );
  expect(select).toHaveBeenCalledWith('b');
});

test.each(['identity', 'revision'])(
  'changing %s closes the menu and rejects a stale selection',
  (change) => {
    const select = jest.fn();
    let tree;
    act(() => {
      tree = TestRenderer.create(
        render({ artists: credits, artists_revision: 1 }, select),
      );
    });
    act(() =>
      tree.root.findByProps({ testID: 'artist-button' }).props.onPress(),
    );
    const stale = tree.root.findByProps({
      accessibilityLabel: 'Страница артиста Artist A',
    }).props.onPress;
    act(() =>
      tree.update(
        render(
          { artists: credits, artists_revision: change === 'revision' ? 2 : 1 },
          select,
          change === 'identity' ? 'track-2' : 'track-1',
        ),
      ),
    );
    expect(tree.root.findByType(Modal).props.visible).toBe(false);
    act(() => stale());
    expect(select).not.toHaveBeenCalled();
  },
);
