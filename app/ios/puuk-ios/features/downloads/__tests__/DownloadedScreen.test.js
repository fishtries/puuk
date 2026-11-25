import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import DownloadedScreen from '../DownloadedScreen';
import useDownloaded from '../useDownloaded';
import { removeOfflineCollection } from '../../../offline/collections';
jest.mock('../useDownloaded');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('../../../offline/collections', () => ({
  removeOfflineCollection: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../../../offline', () => ({ isOfflineSessionCurrent: () => true }));
jest.mock('../../../shared/storage/settings', () => ({
  getSettings: () => ({ language: 'en' }),
}));
const button = (root, label) =>
  root.findAll((node) => node.props.accessibilityLabel === label)[0];
// Inspect rendered text without serializing the virtualized list's React element props.
function renderedText(node) {
  if (typeof node === 'string') return node;
  return (node?.children || []).map(renderedText).join('');
}
const session = {};
const item = {
  key: { kind: 'playlist', collectionId: '1' },
  title: 'A very long collection name that must remain accessible',
  tracks: [
    { id: 1, title: 'Ready', artist: 'Artist' },
    { id: 2, title: 'Waiting' },
  ],
  progress: {
    ready: 1,
    total: 2,
    tracks: [{ state: 'ready' }, { state: 'queued' }],
  },
};
const data = {
  session,
  collections: [item],
  budget: {
    usedBytes: 6 * 1024 ** 3,
    limitBytes: 5 * 1024 ** 3,
    overLimitBytes: 1024 ** 3,
    pauseReason: 'network',
  },
  wave: { readyMinutes: 12.8, targetMinutes: 60, pauseReason: 'network' },
};
test('partial offline collection plays only ready tracks, opens and removes the chosen download', async () => {
  useDownloaded.mockReturnValue(data);
  const navigation = { navigate: jest.fn(), goBack: jest.fn() },
    play = jest.fn();
  let tree;
  await act(async () => {
    tree = TestRenderer.create(
      <DownloadedScreen
        navigation={navigation}
        onPlayTrackList={play}
        onOpenAuthModal={jest.fn()}
      />,
    );
  });
  await act(async () =>
    button(tree.root, 'Play Ready, Artist').props.onPress(),
  );
  expect(play).toHaveBeenCalledWith([item.tracks[0]], 0);
  expect(
    tree.root.findAll(
      (node) => node.props.accessibilityLabel === 'Play Waiting, ',
    ).length,
  ).toBe(0);
  expect(
    tree.root.findByProps({ accessibilityLabel: `${item.title}, 1 / 2` }),
  ).toBeTruthy();
  await act(async () =>
    button(tree.root, `Remove download: ${item.title}`).props.onPress(),
  );
  expect(removeOfflineCollection).toHaveBeenCalledWith(session, item.key);
  const text = renderedText(tree.toJSON());
  expect(text).toContain('6.00 GiB');
  expect(text).toContain('Waiting for network');
  expect(text).toContain('Over the limit');
});
test('empty and unavailable library have clear states', async () => {
  useDownloaded.mockReturnValue({ ...data, collections: [] });
  let tree;
  await act(async () => {
    tree = TestRenderer.create(
      <DownloadedScreen navigation={{ goBack: jest.fn() }} />,
    );
  });
  expect(renderedText(tree.toJSON())).toContain('No downloads yet');
  useDownloaded.mockReturnValue(null);
  await act(async () =>
    tree.update(<DownloadedScreen navigation={{ goBack: jest.fn() }} />),
  );
  expect(renderedText(tree.toJSON())).toContain('unavailable');
});

test('shows each download state and unsupported without hiding playable tracks', async () => {
  const states = [
    'network',
    'space',
    'retry',
    'queued',
    'transferring',
    'verifying',
    'failed',
    'ready',
  ];
  const tracks = states.map((state, id) => ({ id, title: `Track ${id}` }));
  useDownloaded.mockReturnValue({
    ...data,
    downloadStatus: 'unsupported',
    wave: { readyMinutes: 0, targetMinutes: 60, pauseReason: null },
    collections: [
      {
        ...item,
        tracks,
        progress: {
          total: 8,
          ready: 1,
          tracks: states.map((state) => ({ state })),
        },
      },
    ],
  });
  let tree;
  await act(async () => {
    tree = TestRenderer.create(
      <DownloadedScreen
        navigation={{ goBack: jest.fn() }}
        onPlayTrackList={jest.fn()}
      />,
    );
  });
  const output = renderedText(tree.toJSON());
  for (const label of [
    'Waiting for network',
    'Waiting for space',
    'Waiting to retry',
    'Queued',
    'Downloading',
    'Verifying',
    'Download failed',
    'Downloads are not supported in this build',
  ])
    expect(output).toContain(label);
  expect(button(tree.root, 'Play Track 7, ')).toBeTruthy();
});

test('opens a large downloaded playlist without mounting every track', async () => {
  const tracks = Array.from({ length: 2500 }, (_, id) => ({ id, title: `Song ${id}` }));
  const states = tracks.map(() => ({ state: 'ready' }));
  useDownloaded.mockReturnValue({ ...data, collections: [
    { ...item, tracks, progress: { total: tracks.length, ready: tracks.length, tracks: states } },
  ] });
  const play = jest.fn();
  let tree;
  await act(async () => {
    tree = TestRenderer.create(<DownloadedScreen navigation={{}} onPlayTrackList={play} />);
  });
  expect(button(tree.root, 'Play Song 0, ')).toBeTruthy();
  const mounted = new Set(tree.root.findAll(n => n.props.accessibilityLabel?.startsWith('Play Song '))
    .map(n => n.props.accessibilityLabel));
  expect(mounted.size).toBeLessThan(100);
  await act(async () => button(tree.root, 'Play Song 1, ').props.onPress());
  expect(play).toHaveBeenCalledWith(tracks, 1);
  await act(async () => tree.unmount());
});
