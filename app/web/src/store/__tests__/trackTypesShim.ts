// Runtime shims for the Node test runner: type stripping erases interfaces,
// so value-style named imports of type-only symbols need linkable exports.
// tsc keeps using the real src/types/* files; these placeholders only exist
// to satisfy ESM linking inside this test process.
export const Track = undefined;
export const LyricsLine = undefined;
