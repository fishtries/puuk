// Jest setup for React Native & Expo in Puuk iOS

// Ensure asset module ID 1 exists in AssetRegistry for mocked assets in tests
try {
  const {
    AssetRegistry,
  } = require('react-native/src/private/assets/AssetRegistry');
  if (AssetRegistry && !AssetRegistry.getAssetByID(1)) {
    AssetRegistry.registerAsset({
      __packager_asset: true,
      fileSystemLocation: '',
      httpServerLocation: '',
      width: 100,
      height: 100,
      scales: [1],
      hash: 'mock-font-hash',
      name: 'mock-font',
      type: 'ttf',
    });
  }
} catch {
  // Ignore if AssetRegistry location changes
}

// Mock expo-font to avoid trying to load font files in test environment
try {
  jest.mock('expo-font', () => ({
    ...jest.requireActual('expo-font'),
    loadAsync: jest.fn(() => Promise.resolve()),
    isLoaded: jest.fn(() => true),
  }));
} catch {
  // Ignore
}

// Mock @react-native-masked-view/masked-view for Jest
try {
  jest.mock('@react-native-masked-view/masked-view', () => {
    const React = require('react');
    const { View } = require('react-native');
    return ({ children }) => React.createElement(View, null, children);
  });
} catch {
  // Ignore
}
