const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const targetFile = path.join(
  packageRoot,
  'node_modules',
  'expo-audio',
  'ios',
  'MediaController.swift'
);

if (!fs.existsSync(targetFile)) {
  console.log('[patch-expo-audio] MediaController.swift not found, skipping patch.');
  process.exit(0);
}

let content = fs.readFileSync(targetFile, 'utf8');

if (content.includes('nextTrackCommand.addTarget')) {
  console.log('[patch-expo-audio] MediaController.swift already patched.');
  process.exit(0);
}

// 1. Hook up nextTrackCommand & previousTrackCommand in enableRemoteCommands
const oldEnableTarget = `    remoteCommandCenter.playCommand.isEnabled = true
    remoteCommandCenter.pauseCommand.isEnabled = true
    remoteCommandCenter.togglePlayPauseCommand.isEnabled = true
    remoteCommandCenter.changePlaybackPositionCommand.isEnabled = !isLiveStream
    remoteCommandCenter.skipForwardCommand.isEnabled = options?.showSeekForward ?? false
    remoteCommandCenter.skipBackwardCommand.isEnabled = options?.showSeekBackward ?? false`;

const newEnableReplacement = `    remoteCommandCenter.nextTrackCommand.addTarget { [weak self] _ in
      guard let player = self?.activePlayer else {
        return .commandFailed
      }
      player.emit(event: "nextTrack")
      return .success
    }

    remoteCommandCenter.previousTrackCommand.addTarget { [weak self] _ in
      guard let player = self?.activePlayer else {
        return .commandFailed
      }
      player.emit(event: "previousTrack")
      return .success
    }

    let showSeekForward = options?.showSeekForward ?? false
    let showSeekBackward = options?.showSeekBackward ?? false
    remoteCommandCenter.playCommand.isEnabled = true
    remoteCommandCenter.pauseCommand.isEnabled = true
    remoteCommandCenter.togglePlayPauseCommand.isEnabled = true
    remoteCommandCenter.changePlaybackPositionCommand.isEnabled = !isLiveStream
    remoteCommandCenter.skipForwardCommand.isEnabled = showSeekForward
    remoteCommandCenter.skipBackwardCommand.isEnabled = showSeekBackward
    remoteCommandCenter.nextTrackCommand.isEnabled = !showSeekForward
    remoteCommandCenter.previousTrackCommand.isEnabled = !showSeekBackward`;

// 2. Unhook nextTrackCommand & previousTrackCommand in disableRemoteCommands
const oldDisableTarget = `    remoteCommandCenter.skipForwardCommand.isEnabled = false
    remoteCommandCenter.skipBackwardCommand.isEnabled = false

    // Remove event targets
    remoteCommandCenter.playCommand.removeTarget(self)
    remoteCommandCenter.pauseCommand.removeTarget(self)
    remoteCommandCenter.togglePlayPauseCommand.removeTarget(self)
    remoteCommandCenter.changePlaybackPositionCommand.removeTarget(self)
    remoteCommandCenter.skipForwardCommand.removeTarget(self)
    remoteCommandCenter.skipBackwardCommand.removeTarget(self)`;

const newDisableReplacement = `    remoteCommandCenter.skipForwardCommand.isEnabled = false
    remoteCommandCenter.skipBackwardCommand.isEnabled = false
    remoteCommandCenter.nextTrackCommand.isEnabled = false
    remoteCommandCenter.previousTrackCommand.isEnabled = false

    // Remove event targets
    remoteCommandCenter.playCommand.removeTarget(self)
    remoteCommandCenter.pauseCommand.removeTarget(self)
    remoteCommandCenter.togglePlayPauseCommand.removeTarget(self)
    remoteCommandCenter.changePlaybackPositionCommand.removeTarget(self)
    remoteCommandCenter.skipForwardCommand.removeTarget(self)
    remoteCommandCenter.skipBackwardCommand.removeTarget(self)
    remoteCommandCenter.nextTrackCommand.removeTarget(self)
    remoteCommandCenter.previousTrackCommand.removeTarget(self)`;

if (!content.includes(oldEnableTarget) || !content.includes(oldDisableTarget)) {
  console.error('[patch-expo-audio] ERROR: Target signatures not found in MediaController.swift.');
  process.exit(1);
}

content = content.replace(oldEnableTarget, newEnableReplacement);
content = content.replace(oldDisableTarget, newDisableReplacement);

fs.writeFileSync(targetFile, content, 'utf8');
console.log('[patch-expo-audio] Successfully patched MediaController.swift for lock screen next/previous track controls.');
