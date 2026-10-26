const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const targetFile = path.join(
  packageRoot,
  'node_modules',
  'expo-symbols',
  'ios',
  'SymbolView.swift',
);

if (!fs.existsSync(targetFile)) {
  console.log('[expo-symbols] SymbolView.swift not found, skipping patch.');
  process.exit(0);
}

let content = fs.readFileSync(targetFile, 'utf8');

const isAlreadyPatched =
  content.includes(
    'imageView.setSymbolImage(finalImage, contentTransition: .automatic)',
  ) && content.includes('#if canImport(Symbols)');

if (isAlreadyPatched) {
  console.log('[expo-symbols] SymbolView.swift already patched.');
  process.exit(0);
}

// 1. Add #if canImport(Symbols) import Symbols #endif if missing
if (!content.includes('import Symbols')) {
  content = content.replace(
    'import ExpoModulesCore',
    `import ExpoModulesCore\n#if canImport(Symbols)\nimport Symbols\n#endif`,
  );
}

// 2. Fix invalid `with: .automatic` argument label if an older patch was applied
if (content.includes('imageView.setSymbolImage(finalImage, with: .automatic)')) {
  content = content.replace(
    'imageView.setSymbolImage(finalImage, with: .automatic)',
    'imageView.setSymbolImage(finalImage, contentTransition: .automatic)',
  );
  fs.writeFileSync(targetFile, content, 'utf8');
  console.log(
    '[expo-symbols] Successfully updated SymbolView.swift with correct contentTransition parameter.',
  );
  process.exit(0);
}

const oldReloadMethod = `#if !os(macOS)
  private func reloadSymbolIOS() {
    guard let image = UIImage(systemName: name) else {
      return
    }
    imageView.image = image
    imageView.contentMode = imageContentMode
    imageView.preferredSymbolConfiguration = getSymbolConfig()

    if let tint {
      if symbolType != .hierarchical {
        imageView.image = image.withTintColor(tint, renderingMode: .alwaysOriginal)
      }
    }

    // Effects need to be added last
    if #available(iOS 17.0, tvOS 17.0, *) {
      imageView.removeAllSymbolEffects()
      if animated {
        addSymbolEffects()
      }
    }
  }
#else`;

const newReloadMethod = `#if !os(macOS)
  private var currentSymbolName: String?

  private func reloadSymbolIOS() {
    guard let image = UIImage(systemName: name) else {
      return
    }
    let config = getSymbolConfig()
    let configuredImage = image.applyingSymbolConfiguration(config) ?? image
    let finalImage: UIImage
    if let tint, symbolType != .hierarchical {
      finalImage = configuredImage.withTintColor(tint, renderingMode: .alwaysOriginal)
      imageView.tintColor = tint
    } else {
      finalImage = configuredImage
    }
    imageView.contentMode = imageContentMode
    imageView.preferredSymbolConfiguration = config

    // In iOS 17+, smoothly animate symbol transitions (e.g. play.fill <-> pause.fill) using Apple's native Magic Replace transition
    if #available(iOS 17.0, tvOS 17.0, *) {
      let isChangingSymbol = currentSymbolName != nil && currentSymbolName != name
      currentSymbolName = name
      if isChangingSymbol {
        imageView.setSymbolImage(finalImage, contentTransition: .automatic)
      } else {
        imageView.image = finalImage
      }
      imageView.removeAllSymbolEffects()
      if animated {
        addSymbolEffects()
      }
    } else {
      imageView.image = finalImage
    }
  }
#else`;

if (content.includes(oldReloadMethod)) {
  content = content.replace(oldReloadMethod, newReloadMethod);
  fs.writeFileSync(targetFile, content, 'utf8');
  console.log(
    '[expo-symbols] Successfully patched SymbolView.swift for iOS 17+ Magic Replace symbol transitions.',
  );
} else {
  console.warn(
    '[expo-symbols] WARNING: reloadSymbolIOS signature not found in SymbolView.swift.',
  );
}
