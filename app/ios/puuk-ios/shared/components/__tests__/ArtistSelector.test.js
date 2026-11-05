import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Modal } from 'react-native';
import Constants from 'expo-constants';
import { MenuView } from '@react-native-menu/menu';
import ArtistSelector from '../ArtistSelector';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { appOwnership: 'expo' },
}));
jest.mock('@react-native-menu/menu', () => ({
  MenuView: (props) => {
    const { View } = require('react-native');
    return <View {...props} />;
  },
}));

beforeEach(() => {
  Constants.appOwnership = 'expo';
});

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

test('native long press offers album and artist with subtitles; tap opens the artist', () => {
  Constants.appOwnership = 'standalone';
  const select = jest.fn();
  const selectAlbum = jest.fn();
  let tree;
  act(() => {
    tree = TestRenderer.create(
      <ArtistSelector
        entity={{
          artists: [credits[0]],
          album_id: 'album-1',
          album: 'Album A',
        }}
        display="Artist A"
        onSelect={select}
        onAlbumSelect={selectAlbum}
        triggerTestID="artist-button"
      />,
    );
  });
  const menu = tree.root.findByType(MenuView);
  expect(menu.props.shouldOpenOnLongPress).toBe(true);
  expect(menu.props.actions).toEqual([
    expect.objectContaining({
      id: 'album',
      subtitle: 'Album A',
      image: 'square.stack',
    }),
    expect.objectContaining({
      id: 'artist:a',
      subtitle: 'Artist A',
      image: 'mic',
    }),
  ]);
  act(() => tree.root.findByProps({ testID: 'artist-button' }).props.onPress());
  expect(select).toHaveBeenCalledWith('a');
  act(() => menu.props.onPressAction({ nativeEvent: { event: 'album' } }));
  expect(selectAlbum).toHaveBeenCalledWith('album-1');
});

test('native artist folder selects participants and rejects selections from a previous track', () => {
  Constants.appOwnership = 'standalone';
  const select = jest.fn();
  let tree;
  act(() => {
    tree = TestRenderer.create(render({ artists: credits }, select));
  });
  const menu = tree.root.findByType(MenuView);
  expect(menu.props.shouldOpenOnLongPress).toBe(false);
  expect(menu.props.actions[0].subactions).toEqual(
    credits.map((artist) => ({
      id: `artist:${artist.id}`,
      title: artist.name,
      image: 'mic',
    })),
  );
  expect(tree.root.findAllByType(Modal)).toHaveLength(0);
  act(() => menu.props.onPressAction({ nativeEvent: { event: 'artist:b' } }));
  expect(select).toHaveBeenCalledWith('b');
  const stale = menu.props.onPressAction;
  select.mockClear();
  act(() => tree.update(render({ artists: credits }, select, 'track-2')));
  act(() => stale({ nativeEvent: { event: 'artist:a' } }));
  expect(select).not.toHaveBeenCalled();
});
