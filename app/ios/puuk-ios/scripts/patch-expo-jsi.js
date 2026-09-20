const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const jsiRoot = path.join(packageRoot, 'node_modules', 'expo-modules-jsi', 'apple');

function walk(directory) {
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(entryPath);
    return entry.name.endsWith('.swift') || entry.name.endsWith('.h') ? [entryPath] : [];
  });
}

let modifiedCount = 0;

for (const filePath of walk(jsiRoot)) {
  const original = fs.readFileSync(filePath, 'utf8');
  let patched = original
    // Swift 6 requires weak references to be mutable storage. Mark these
    // runtime handles explicitly because the JSI value wrappers cross
    // isolation domains by design.
    .replace(
      /(?:nonisolated\(unsafe\)\s+)?weak\s+(?:let|var)\s+runtime\b/g,
      'nonisolated(unsafe) weak var runtime',
    )
    .replace(/\bweak\s+let\b/g, 'weak var')
    // Xcode 26 rejects the ownership annotation on these C++ constructors.
    .replace(/\bSWIFT_RETURNS_RETAINED\s+/g, '');

  if (filePath.endsWith(`${path.sep}apple${path.sep}Package.swift`)) {
    // Expo JSI crosses Swift concurrency domains through synchronous C++ callbacks.
    // Complete checking treats those call-scoped raw pointers as escaping sends.
    patched = patched.replace(/\n\s*"-strict-concurrency=targeted",/g, '');
    patched = patched.replace(
      '"-no-verify-emitted-module-interface",',
      '"-no-verify-emitted-module-interface",\n          "-strict-concurrency=targeted",',
    );
  }

  if (patched !== original) {
    fs.writeFileSync(filePath, patched, 'utf8');
    modifiedCount += 1;
    console.log(`[patch-expo-jsi] Patched ${path.relative(packageRoot, filePath)}`);
  }
}

console.log(`[patch-expo-jsi] Finished. Patched ${modifiedCount} file(s).`);
