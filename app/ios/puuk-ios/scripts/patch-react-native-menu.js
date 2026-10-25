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

if (!fs.existsSync(targetFile)) {
  console.log(
    '[@react-native-menu/menu] MenuViewManager.mm not found, skipping patch.',
  );
  process.exit(0);
}

let content = fs.readFileSync(targetFile, 'utf8');

if (
  content.includes('#import <React/RCTBridge.h>') &&
  !content.includes('#import "RCTBridge.h"')
) {
  console.log('[@react-native-menu/menu] MenuViewManager.mm already patched.');
  process.exit(0);
}

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
  console.log('[@react-native-menu/menu] Normalized MenuViewManager.mm patch.');
}
