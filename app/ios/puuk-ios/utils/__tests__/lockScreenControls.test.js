const fs = require('fs');
const path = require('path');

describe('lock screen media controls patch', () => {
  const rootDir = path.resolve(__dirname, '..', '..');
  const mediaControllerPath = path.join(
    rootDir,
    'node_modules',
    'expo-audio',
    'ios',
    'MediaController.swift'
  );
  const patchScriptPath = path.join(rootDir, 'scripts', 'patch-expo-audio.js');

  test('patch-expo-audio.js script exists', () => {
    expect(fs.existsSync(patchScriptPath)).toBe(true);
  });

  test('MediaController.swift has nextTrackCommand and previousTrackCommand targets and enable logic', () => {
    expect(fs.existsSync(mediaControllerPath)).toBe(true);
    const content = fs.readFileSync(mediaControllerPath, 'utf8');

    // Remote commands added
    expect(content).toContain('remoteCommandCenter.nextTrackCommand.addTarget');
    expect(content).toContain('remoteCommandCenter.previousTrackCommand.addTarget');
    expect(content).toContain('player.emit(event: "nextTrack")');
    expect(content).toContain('player.emit(event: "previousTrack")');

    // Enabled state tied to !showSeekForward / !showSeekBackward
    expect(content).toContain('remoteCommandCenter.nextTrackCommand.isEnabled = !showSeekForward');
    expect(content).toContain('remoteCommandCenter.previousTrackCommand.isEnabled = !showSeekBackward');

    // Cleaned up on disable
    expect(content).toContain('remoteCommandCenter.nextTrackCommand.isEnabled = false');
    expect(content).toContain('remoteCommandCenter.previousTrackCommand.isEnabled = false');
    expect(content).toContain('remoteCommandCenter.nextTrackCommand.removeTarget(self)');
    expect(content).toContain('remoteCommandCenter.previousTrackCommand.removeTarget(self)');
  });
});
