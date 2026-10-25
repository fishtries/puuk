const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

describe('patch-react-native-menu', () => {
  const rootDir = path.resolve(__dirname, '..', '..');
  const targetFile = path.join(
    rootDir,
    'node_modules',
    '@react-native-menu',
    'menu',
    'ios',
    'MenuViewManager.mm',
  );
  const patchScriptPath = path.join(
    rootDir,
    'scripts',
    'patch-react-native-menu.js',
  );

  test('MenuViewManager.mm is patched and imports <React/RCTBridge.h>', () => {
    expect(fs.existsSync(patchScriptPath)).toBe(true);
    expect(fs.existsSync(targetFile)).toBe(true);

    execSync(`node "${patchScriptPath}"`, { stdio: 'pipe' });

    const content = fs.readFileSync(targetFile, 'utf8');
    expect(content).not.toContain('#import "RCTBridge.h"');
    expect(content).toContain('#import <React/RCTBridge.h>');
  });
});
