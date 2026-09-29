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
    .replace(/\bSWIFT_RETURNS_RETAINED\s+/g, '')
    // Swift 6.2/Xcode 26 diagnoses the call-scoped pointers as task-isolated
    // when they are implicitly captured by the JavaScriptActor closure.
    .replace(
      /(nonisolated\(unsafe\) let thisPtr = thisPtr\s+nonisolated\(unsafe\) let argumentsPtr = argumentsPtr\s+nonisolated\(unsafe\) let resultPtr = resultPtr\s+[\s\S]*?resultPtr\.pointee = JavaScriptActor\.assumeIsolated \{)(?!\s*\[)/g,
      '$1 [thisPtr, argumentsPtr] in',
    );

  if (filePath.endsWith(`${path.sep}apple${path.sep}Package.swift`)) {
    patched = patched.replace(/\n\s*"-strict-concurrency=targeted",/g, '');
    patched = patched.replace(/^\s*"-strict-concurrency=targeted",\n/gm, '');
  }

  // Also remove -quiet from build-xcframework.sh so any errors during xcframework build are visible
  const buildScript = path.join(jsiRoot, 'scripts', 'build-xcframework.sh');
  if (fs.existsSync(buildScript)) {
    const scriptContent = fs.readFileSync(buildScript, 'utf8');
    const unquietContent = scriptContent.replace(/\s+-quiet\s*\\/g, ' \\');
    if (unquietContent !== scriptContent) {
      fs.writeFileSync(buildScript, unquietContent, 'utf8');
      console.log('[patch-expo-jsi] Removed -quiet from build-xcframework.sh for verbose build logs');
    }
  }

  if (patched !== original) {
    fs.writeFileSync(filePath, patched, 'utf8');
    modifiedCount += 1;
    console.log(`[patch-expo-jsi] Patched ${path.relative(packageRoot, filePath)}`);
  }
}

console.log(`[patch-expo-jsi] Finished. Patched ${modifiedCount} file(s).`);
