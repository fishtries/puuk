const fs = require('fs');
const path = require('path');

const targetFiles = [
  'node_modules/@expo/expo-modules-macros-plugin/apple/Package.swift',
  'node_modules/expo-modules-jsi/apple/Package.swift',
];

let modifiedCount = 0;

for (const relPath of targetFiles) {
  const fullPath = path.resolve(__dirname, '..', relPath);
  if (fs.existsSync(fullPath)) {
    let content = fs.readFileSync(fullPath, 'utf8');
    if (content.includes('swift-tools-version: 6.2')) {
      content = content.replace(/swift-tools-version: 6\.2/g, 'swift-tools-version: 6.0');
      fs.writeFileSync(fullPath, content, 'utf8');
      console.log(`[patch-swift-version] Patched ${relPath} (6.2 -> 6.0)`);
      modifiedCount++;
    }
  }
}

console.log(`[patch-swift-version] Finished. Patched ${modifiedCount} file(s).`);
