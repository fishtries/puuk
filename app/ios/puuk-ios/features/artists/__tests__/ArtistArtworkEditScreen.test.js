import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import ArtistArtworkEditScreen from '../ArtistArtworkEditScreen';
import RootNavigator from '../../../navigation/RootNavigator';
import {
  updateArtistArtwork,
  deleteArtistArtwork,
} from '../../../shared/api/artists';

jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');
jest.mock('../../../navigation/MainTabs', () => () => null);
jest.mock('../../../features/albums/AlbumScreen', () => () => null);
jest.mock('../../../features/albums/AlbumEditScreen', () => () => null);
jest.mock('../../../features/playlists/PlaylistScreen', () => () => null);
jest.mock('../../../features/library/TrackEditScreen', () => () => null);
jest.mock('../ArtistScreen', () => () => null);

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest
    .fn()
    .mockResolvedValue({ granted: true }),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('../../../shared/api/artists', () => {
  const actual = jest.requireActual('../../../shared/api/artists');
  return {
    ...actual,
    updateArtistArtwork: jest.fn(),
    deleteArtistArtwork: jest.fn(),
  };
});

describe('ArtistArtworkEditScreen', () => {
  const adminUser = { id: 1, role: 'admin', username: 'admin' };
  const regularUser = { id: 2, role: 'user', username: 'listener' };

  const sampleArtist = {
    id: 'art_123',
    artist_id: 'art_123',
    name: 'Radiohead - A Very Long Band Name To Verify Truncation And Ellipsize In Screen Header',
    artwork_version: 1,
    artwork_url: 'https://puuk.app/api/artists/art_123/artwork?v=1',
  };

  const mockNavigation = {
    navigate: jest.fn(),
    goBack: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert');
  });

  afterEach(() => {
    Alert.alert.mockRestore?.();
  });

  describe('Admin Access & Permission Restriction', () => {
    test('отображает экран ограничения доступа для не-администратора (role: "user") через currentUser prop', async () => {
      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen
            route={route}
            navigation={mockNavigation}
            currentUser={regularUser}
          />,
        );
      });

      const restrictedView = renderer.root.findAllByProps({
        testID: 'admin-restricted-view',
      });
      expect(restrictedView.length).toBeGreaterThan(0);

      // Verify no upload/save actions are shown
      expect(
        renderer.root.findAllByProps({ testID: 'save-artwork-button' }),
      ).toHaveLength(0);

      // Back button works
      const backBtn = renderer.root.findAllByProps({
        accessibilityLabel: 'Вернуться назад',
      })[0];
      await act(async () => {
        backBtn.props.onPress();
      });
      expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    });

    test('отображает экран ограничения доступа при отсутствии сессии / неавторизованном пользователе (currentUser: null / undefined)', async () => {
      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen
            route={route}
            navigation={mockNavigation}
            currentUser={null}
          />,
        );
      });

      expect(
        renderer.root.findAllByProps({ testID: 'admin-restricted-view' }).length,
      ).toBeGreaterThan(0);
      expect(
        renderer.root.findAllByProps({ testID: 'save-artwork-button' }),
      ).toHaveLength(0);
    });

    test('разрешает доступ администратору (role: "admin") через currentUser prop', async () => {
      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen
            route={route}
            navigation={mockNavigation}
            currentUser={adminUser}
          />,
        );
      });

      expect(
        renderer.root.findAllByProps({ testID: 'admin-restricted-view' }),
      ).toHaveLength(0);
      expect(
        renderer.root.findAllByProps({ testID: 'save-artwork-button' }).length,
      ).toBeGreaterThan(0);
    });

    test('доказывает production wiring через RootNavigator без передачи route.params.currentUser', async () => {
      const renderRootNav = RootNavigator.type || RootNavigator;
      // 1. Проверяем не-администратора через RootNavigator wiring
      const userNavElement = renderRootNav({ currentUser: regularUser });
      const userScreenDef = React.Children.toArray(userNavElement.props.children).find(
        (child) => child.props?.name === 'ArtistEdit',
      );
      expect(userScreenDef).toBeDefined();

      let rendererUser;
      await act(async () => {
        const screenElement = userScreenDef.props.children({
          route: { params: { artistId: sampleArtist.id, artist: sampleArtist } },
          navigation: mockNavigation,
        });
        rendererUser = TestRenderer.create(screenElement);
      });

      expect(
        rendererUser.root.findAllByProps({ testID: 'admin-restricted-view' }).length,
      ).toBeGreaterThan(0);
      expect(
        rendererUser.root.findAllByProps({ testID: 'save-artwork-button' }),
      ).toHaveLength(0);

      // 2. Проверяем администратора через RootNavigator wiring
      const adminNavElement = renderRootNav({ currentUser: adminUser });
      const adminScreenDef = React.Children.toArray(adminNavElement.props.children).find(
        (child) => child.props?.name === 'ArtistEdit',
      );
      expect(adminScreenDef).toBeDefined();

      let rendererAdmin;
      await act(async () => {
        const screenElement = adminScreenDef.props.children({
          route: { params: { artistId: sampleArtist.id, artist: sampleArtist } },
          navigation: mockNavigation,
        });
        rendererAdmin = TestRenderer.create(screenElement);
      });

      expect(
        rendererAdmin.root.findAllByProps({ testID: 'admin-restricted-view' }),
      ).toHaveLength(0);
      expect(
        rendererAdmin.root.findAllByProps({ testID: 'save-artwork-button' }).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('Artwork Display & Header Truncation', () => {
    test('корректно отображает текущий server artwork и обрезает длинное имя артиста', async () => {
      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen route={route} navigation={mockNavigation} currentUser={adminUser} />,
        );
      });

      // Server artwork preview
      const preview = renderer.root.findByProps({
        testID: 'preview-server-artwork',
      });
      expect(preview.props.source).toBe(sampleArtist.artwork_url);
      expect(preview.props.source).not.toContain('token=');

      // Remove button exists because artwork_version > 0
      const removeBtn = renderer.root.findByProps({
        testID: 'remove-artwork-button',
      });
      expect(removeBtn).toBeDefined();

      // Long name truncation
      const artistNameNode = renderer.root.findAll(
        (node) =>
          node.type === 'Text' &&
          node.props.children === sampleArtist.name &&
          node.props.numberOfLines === 1 &&
          node.props.ellipsizeMode === 'tail',
      );
      expect(artistNameNode.length).toBeGreaterThan(0);
    });

    test('отображает плейсхолдер и скрывает кнопку удаления при отсутствии artwork', async () => {
      const noArtworkArtist = {
        id: 'art_456',
        name: 'New Artist',
        artwork_version: 0,
        artwork_url: null,
      };

      const route = {
        params: {
          artistId: noArtworkArtist.id,
          artist: noArtworkArtist,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen route={route} navigation={mockNavigation} currentUser={adminUser} />,
        );
      });

      expect(
        renderer.root.findAllByProps({ testID: 'preview-placeholder' }).length,
      ).toBeGreaterThan(0);
      expect(
        renderer.root.findAllByProps({ testID: 'remove-artwork-button' }),
      ).toHaveLength(0);
    });
  });

  describe('Validation Errors: Too Large and Invalid Type', () => {
    test('показывает ошибку валидации при выборе файла больше 5 MiB', async () => {
      ImagePicker.launchImageLibraryAsync.mockResolvedValueOnce({
        canceled: false,
        assets: [
          {
            uri: 'file:///var/mobile/Containers/Data/huge_image.jpg',
            fileName: 'huge_image.jpg',
            fileSize: 6 * 1024 * 1024, // 6 MiB > 5 MiB
            mimeType: 'image/jpeg',
          },
        ],
      });

      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen route={route} navigation={mockNavigation} currentUser={adminUser} />,
        );
      });

      const pickButton = renderer.root.findByProps({
        testID: 'pick-image-button',
      });
      await act(async () => {
        await pickButton.props.onPress();
      });

      // Error banner is rendered with too large message
      const errorBanner = renderer.root.findByProps({ testID: 'error-banner' });
      expect(errorBanner).toBeDefined();
      expect(
        renderer.root.findAll(
          (node) =>
            node.type === 'Text' &&
            typeof node.props.children === 'string' &&
            node.props.children.includes('5 МБ'),
        ).length,
      ).toBeGreaterThan(0);

      expect(Alert.alert).toHaveBeenCalledWith(
        'Ошибка валидации',
        expect.stringContaining('5 МБ'),
      );
      expect(updateArtistArtwork).not.toHaveBeenCalled();

      // Local file path must NOT be rendered in Text elements
      const allTextNodes = renderer.root.findAll(
        (node) => node.type === 'Text',
      );
      for (const textNode of allTextNodes) {
        const textContent = String(textNode.props.children || '');
        expect(textContent).not.toContain('file:///');
      }
    });

    test('показывает ошибку валидации при неподдерживаемом формате файла', async () => {
      ImagePicker.launchImageLibraryAsync.mockResolvedValueOnce({
        canceled: false,
        assets: [
          {
            uri: 'file:///var/mobile/Containers/Data/animated.gif',
            fileName: 'animated.gif',
            fileSize: 500 * 1024,
            mimeType: 'image/gif', // Not in JPEG, PNG, WebP
          },
        ],
      });

      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen route={route} navigation={mockNavigation} currentUser={adminUser} />,
        );
      });

      const pickButton = renderer.root.findByProps({
        testID: 'pick-image-button',
      });
      await act(async () => {
        await pickButton.props.onPress();
      });

      const errorBanner = renderer.root.findByProps({ testID: 'error-banner' });
      expect(errorBanner).toBeDefined();
      expect(
        renderer.root.findAll(
          (node) =>
            node.type === 'Text' &&
            typeof node.props.children === 'string' &&
            node.props.children.includes('JPEG, PNG и WebP'),
        ).length,
      ).toBeGreaterThan(0);

      expect(Alert.alert).toHaveBeenCalledWith(
        'Ошибка валидации',
        expect.stringContaining('JPEG, PNG и WebP'),
      );
      expect(updateArtistArtwork).not.toHaveBeenCalled();
    });
  });

  describe('Upload Flow, Multipart, Cache-Busting and Error States', () => {
    test('успешно загружает изображение через updateArtistArtwork и выполняет cache-busting', async () => {
      const onArtworkUpdated = jest.fn();
      ImagePicker.launchImageLibraryAsync.mockResolvedValueOnce({
        canceled: false,
        assets: [
          {
            uri: 'file:///var/mobile/Containers/Data/valid.jpg',
            fileName: 'valid.jpg',
            fileSize: 1.5 * 1024 * 1024,
            mimeType: 'image/jpeg',
          },
        ],
      });

      updateArtistArtwork.mockResolvedValueOnce({
        status: 'updated',
        artist_id: sampleArtist.id,
        artwork_version: 2,
      });

      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
          onArtworkUpdated,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen route={route} navigation={mockNavigation} currentUser={adminUser} />,
        );
      });

      // Pick image
      const pickButton = renderer.root.findByProps({
        testID: 'pick-image-button',
      });
      await act(async () => {
        await pickButton.props.onPress();
      });

      // Local preview rendered
      const localPreview = renderer.root.findByProps({
        testID: 'preview-local-image',
      });
      expect(localPreview.props.source.uri).toBe(
        'file:///var/mobile/Containers/Data/valid.jpg',
      );

      // Verify local file path is NEVER shown as text
      const allTextNodes = renderer.root.findAll(
        (node) => node.type === 'Text',
      );
      for (const textNode of allTextNodes) {
        expect(String(textNode.props.children || '')).not.toContain('file:///');
      }

      // Save
      const saveButton = renderer.root.findByProps({
        testID: 'save-artwork-button',
      });
      await act(async () => {
        await saveButton.props.onPress();
      });

      // Verifies updateArtistArtwork was called with artistId and asset metadata (field 'file')
      expect(updateArtistArtwork).toHaveBeenCalledWith(
        sampleArtist.id,
        expect.objectContaining({
          uri: 'file:///var/mobile/Containers/Data/valid.jpg',
          name: 'valid.jpg',
          type: 'image/jpeg',
        }),
      );

      // Cache-busting: onArtworkUpdated called with new artwork_version and versioned URL without token
      expect(onArtworkUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          artwork_version: 2,
          artwork_url: expect.stringContaining('v=2'),
        }),
      );
      const reportedUrl = onArtworkUpdated.mock.calls[0][0].artwork_url;
      expect(reportedUrl).not.toContain('token=');

      expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    });

    test('обрабатывает ошибку сервера 413 (слишком большой файл)', async () => {
      ImagePicker.launchImageLibraryAsync.mockResolvedValueOnce({
        canceled: false,
        assets: [
          {
            uri: 'file:///tmp/pic.jpg',
            fileName: 'pic.jpg',
            fileSize: 4.9 * 1024 * 1024,
            mimeType: 'image/jpeg',
          },
        ],
      });

      const error413 = new Error('Изображение должно быть не больше 5 MiB');
      error413.status = 413;
      updateArtistArtwork.mockRejectedValueOnce(error413);

      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen route={route} navigation={mockNavigation} currentUser={adminUser} />,
        );
      });

      const pickButton = renderer.root.findByProps({
        testID: 'pick-image-button',
      });
      await act(async () => {
        await pickButton.props.onPress();
      });

      const saveButton = renderer.root.findByProps({
        testID: 'save-artwork-button',
      });
      await act(async () => {
        await saveButton.props.onPress();
      });

      expect(Alert.alert).toHaveBeenCalledWith(
        'Не удалось сохранить',
        expect.stringContaining('5 МБ'),
      );
      const errorBanner = renderer.root.findByProps({ testID: 'error-banner' });
      expect(errorBanner).toBeDefined();
    });

    test('обрабатывает ошибку сервера 415 (неподдерживаемый формат)', async () => {
      ImagePicker.launchImageLibraryAsync.mockResolvedValueOnce({
        canceled: false,
        assets: [
          {
            uri: 'file:///tmp/pic.jpg',
            fileName: 'pic.jpg',
            fileSize: 1024,
            mimeType: 'image/jpeg',
          },
        ],
      });

      const error415 = new Error('Неподдерживаемый формат');
      error415.status = 415;
      updateArtistArtwork.mockRejectedValueOnce(error415);

      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen route={route} navigation={mockNavigation} currentUser={adminUser} />,
        );
      });

      const pickButton = renderer.root.findByProps({
        testID: 'pick-image-button',
      });
      await act(async () => {
        await pickButton.props.onPress();
      });

      const saveButton = renderer.root.findByProps({
        testID: 'save-artwork-button',
      });
      await act(async () => {
        await saveButton.props.onPress();
      });

      expect(Alert.alert).toHaveBeenCalledWith(
        'Не удалось сохранить',
        expect.stringContaining('JPEG, PNG и WebP'),
      );
    });

    test('обрабатывает ошибку сервера 403 (недостаточно прав администратора)', async () => {
      ImagePicker.launchImageLibraryAsync.mockResolvedValueOnce({
        canceled: false,
        assets: [
          {
            uri: 'file:///tmp/pic.jpg',
            fileName: 'pic.jpg',
            fileSize: 1024,
            mimeType: 'image/jpeg',
          },
        ],
      });

      const error403 = new Error('Forbidden');
      error403.status = 403;
      updateArtistArtwork.mockRejectedValueOnce(error403);

      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen route={route} navigation={mockNavigation} currentUser={adminUser} />,
        );
      });

      const pickButton = renderer.root.findByProps({
        testID: 'pick-image-button',
      });
      await act(async () => {
        await pickButton.props.onPress();
      });

      const saveButton = renderer.root.findByProps({
        testID: 'save-artwork-button',
      });
      await act(async () => {
        await saveButton.props.onPress();
      });

      expect(Alert.alert).toHaveBeenCalledWith(
        'Не удалось сохранить',
        expect.stringContaining('права администратора'),
      );
    });
  });

  describe('Delete / Remove Action', () => {
    test('удаляет изображение после подтверждения в диалоге Alert и сбрасывает artwork', async () => {
      const onArtworkUpdated = jest.fn();
      deleteArtistArtwork.mockResolvedValueOnce({
        status: 'removed',
        artist_id: sampleArtist.id,
      });

      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
          onArtworkUpdated,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen route={route} navigation={mockNavigation} currentUser={adminUser} />,
        );
      });

      const removeBtn = renderer.root.findByProps({
        testID: 'remove-artwork-button',
      });
      await act(async () => {
        removeBtn.props.onPress();
      });

      // Dialog confirmation requested
      expect(Alert.alert).toHaveBeenCalledWith(
        'Удалить изображение?',
        'Будет отображаться стандартный плейсхолдер.',
        expect.any(Array),
      );

      const alertButtons = Alert.alert.mock.calls[0][2];
      const deleteConfirm = alertButtons.find((btn) => btn.text === 'Удалить');
      expect(deleteConfirm).toBeDefined();

      await act(async () => {
        await deleteConfirm.onPress();
      });

      expect(deleteArtistArtwork).toHaveBeenCalledWith(sampleArtist.id);
      expect(onArtworkUpdated).toHaveBeenCalledWith({
        artwork_version: 0,
        artwork_url: null,
      });
      expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    });

    test('обрабатывает отказ от удаления в диалоге Alert', async () => {
      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen route={route} navigation={mockNavigation} currentUser={adminUser} />,
        );
      });

      const removeBtn = renderer.root.findByProps({
        testID: 'remove-artwork-button',
      });
      await act(async () => {
        removeBtn.props.onPress();
      });

      const alertButtons = Alert.alert.mock.calls[0][2];
      const cancelBtn = alertButtons.find((btn) => btn.text === 'Отмена');
      expect(cancelBtn).toBeDefined();

      expect(deleteArtistArtwork).not.toHaveBeenCalled();
      expect(mockNavigation.goBack).not.toHaveBeenCalled();
    });

    test('обрабатывает ошибку сервера 403 при удалении', async () => {
      const error403 = new Error('Forbidden');
      error403.status = 403;
      deleteArtistArtwork.mockRejectedValueOnce(error403);

      const route = {
        params: {
          artistId: sampleArtist.id,
          artist: sampleArtist,
        },
      };

      let renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ArtistArtworkEditScreen route={route} navigation={mockNavigation} currentUser={adminUser} />,
        );
      });

      const removeBtn = renderer.root.findByProps({
        testID: 'remove-artwork-button',
      });
      await act(async () => {
        removeBtn.props.onPress();
      });

      const alertButtons = Alert.alert.mock.calls[0][2];
      const deleteConfirm = alertButtons.find((btn) => btn.text === 'Удалить');

      await act(async () => {
        await deleteConfirm.onPress();
      });

      expect(Alert.alert).toHaveBeenCalledWith(
        'Не удалось удалить',
        expect.stringContaining('права администратора'),
      );
      expect(mockNavigation.goBack).not.toHaveBeenCalled();
    });
  });
});
