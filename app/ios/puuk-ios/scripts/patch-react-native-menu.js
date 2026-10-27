const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const targetFile = path.join(
  packageRoot,
  'node_modules',
  '@react-native-menu',
  'menu',
  'ios',
  'MenuViewManager.mm',
);

if (fs.existsSync(targetFile)) {
  let content = fs.readFileSync(targetFile, 'utf8');
  const oldImport = '#import "RCTBridge.h"';
  const newImport = '#import <React/RCTBridge.h>';

  if (content.includes(oldImport)) {
    content = content.replace(oldImport, newImport);
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log(
      '[@react-native-menu/menu] Successfully patched MenuViewManager.mm for React Native 0.88+ header compatibility.',
    );
  } else if (content.includes('__has_include(<React/RCTBridge.h>)')) {
    content = content.replace(
      /#if __has_include\(<React\/RCTBridge\.h>\)[\s\S]*?#endif/,
      '#import <React/RCTBridge.h>',
    );
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log(
      '[@react-native-menu/menu] Normalized MenuViewManager.mm patch.',
    );
  } else {
    console.log(
      '[@react-native-menu/menu] MenuViewManager.mm already patched.',
    );
  }
} else {
  console.log(
    '[@react-native-menu/menu] MenuViewManager.mm not found, skipping patch.',
  );
}

// Patch Swift files to prevent Fabric's default imageColor=0 from tinting SF Symbols transparent
const swiftFiles = [
  path.join(
    packageRoot,
    'node_modules',
    '@react-native-menu',
    'menu',
    'ios',
    'Shared',
    'RCTMenuItem.swift',
  ),
  path.join(
    packageRoot,
    'node_modules',
    '@react-native-menu',
    'menu',
    'ios',
    'Shared',
    'RCTAlertAction.swift',
  ),
];

for (const swiftFile of swiftFiles) {
  if (!fs.existsSync(swiftFile)) continue;
  let swiftContent = fs.readFileSync(swiftFile, 'utf8');
  const oldCheck = 'if let imageColor = details["imageColor"] {';
  const newCheck =
    'if let imageColor = details["imageColor"] as? NSNumber, imageColor.intValue != 0 {';

  if (swiftContent.includes(oldCheck)) {
    swiftContent = swiftContent.replace(oldCheck, newCheck);
    fs.writeFileSync(swiftFile, swiftContent, 'utf8');
    console.log(
      `[@react-native-menu/menu] Successfully patched ${path.basename(swiftFile)} to preserve SF Symbol colors.`,
    );
  } else if (swiftContent.includes('imageColor.intValue != 0')) {
    console.log(
      `[@react-native-menu/menu] ${path.basename(swiftFile)} already patched.`,
    );
  }
}
