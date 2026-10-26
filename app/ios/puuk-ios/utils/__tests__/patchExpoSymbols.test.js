const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

describe('patch-expo-symbols', () => {
  const rootDir = path.resolve(__dirname, '..', '..');
  const targetFile = path.join(
    rootDir,
    'node_modules',
    'expo-symbols',
    'ios',
    'SymbolView.swift',
  );
  const patchScriptPath = path.join(
    rootDir,
    'scripts',
    'patch-expo-symbols.js',
  );

  test('SymbolView.swift is patched to support iOS 17+ automatic symbol transitions', () => {
    expect(fs.existsSync(patchScriptPath)).toBe(true);
    expect(fs.existsSync(targetFile)).toBe(true);

    execSync(`node "${patchScriptPath}"`, { stdio: 'pipe' });

    const content = fs.readFileSync(targetFile, 'utf8');
    expect(content).toContain(
      'imageView.setSymbolImage(finalImage, contentTransition: .automatic)',
    );
    expect(content).toContain('currentSymbolName');
  });
});
