const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const iosDir = path.join(packageRoot, 'node_modules', 'expo-audio', 'ios');

if (!fs.existsSync(iosDir)) {
  console.log('[patch-expo-audio] expo-audio/ios not found, skipping patch.');
  process.exit(0);
}

// 1. Patch MediaController.swift for lock screen next/previous track commands
function patchMediaController() {
  const targetFile = path.join(iosDir, 'MediaController.swift');
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-expo-audio] MediaController.swift not found.');
    return;
  }
  let content = fs.readFileSync(targetFile, 'utf8');
  if (content.includes('nextTrackCommand.addTarget')) {
    console.log('[patch-expo-audio] MediaController.swift already patched.');
    return;
  }

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
    return;
  }

  content = content.replace(oldEnableTarget, newEnableReplacement);
  content = content.replace(oldDisableTarget, newDisableReplacement);
  fs.writeFileSync(targetFile, content, 'utf8');
  console.log('[patch-expo-audio] Successfully patched MediaController.swift for lock screen next/previous track controls.');
}

// 2. Patch AudioModule.swift to fix AVQueuePlayer replaceCurrentItem crash on preloaded items
function patchAudioModule() {
  const targetFile = path.join(iosDir, 'AudioModule.swift');
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-expo-audio] AudioModule.swift not found.');
    return;
  }
  let content = fs.readFileSync(targetFile, 'utf8');
  if (content.includes('queuePlayer.removeAllItems()')) {
    console.log('[patch-expo-audio] AudioModule.swift already patched.');
    return;
  }

  const oldReplace = `        if let uri = source.uri?.absoluteString, let cachedPlayer = self.registry.removePreloadedPlayer(forKey: uri) {
          let cachedItem = cachedPlayer.currentItem
          cachedPlayer.replaceCurrentItem(with: nil)
          player.replaceWithPreloadedItem(cachedItem)
        } else {
          player.replaceCurrentSource(source: source)
        }`;

  const newReplace = `        if let uri = source.uri?.absoluteString, let cachedPlayer = self.registry.removePreloadedPlayer(forKey: uri) {
          let cachedItem = cachedPlayer.currentItem
          if let queuePlayer = cachedPlayer as? AVQueuePlayer {
            queuePlayer.removeAllItems()
          } else {
            cachedPlayer.replaceCurrentItem(with: nil)
          }
          player.replaceWithPreloadedItem(cachedItem)
        } else {
          player.replaceCurrentSource(source: source)
        }`;

  if (!content.includes(oldReplace)) {
    console.error('[patch-expo-audio] ERROR: Target signature not found in AudioModule.swift.');
    return;
  }

  content = content.replace(oldReplace, newReplace);
  fs.writeFileSync(targetFile, content, 'utf8');
  console.log('[patch-expo-audio] Successfully patched AudioModule.swift to prevent AVQueuePlayer crash on preloaded item replacement.');
}

// 3. Patch AudioComponentRegistry.swift to fix removeAllPreloadedPlayers crash on AVQueuePlayer
function patchAudioComponentRegistry() {
  const targetFile = path.join(iosDir, 'AudioComponentRegistry.swift');
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-expo-audio] AudioComponentRegistry.swift not found.');
    return;
  }
  let content = fs.readFileSync(targetFile, 'utf8');
  if (content.includes('if let queuePlayer = $0 as? AVQueuePlayer')) {
    console.log('[patch-expo-audio] AudioComponentRegistry.swift already patched.');
    return;
  }

  const oldRemoveAll = `  func removeAllPreloadedPlayers() {
    registryQueue.async(flags: .barrier) {
      self.preloadedPlayers.values.forEach { $0.replaceCurrentItem(with: nil) }
      self.preloadedPlayers.removeAll()
    }
  }`;

  const newRemoveAll = `  func removeAllPreloadedPlayers() {
    registryQueue.async(flags: .barrier) {
      self.preloadedPlayers.values.forEach {
        if let queuePlayer = $0 as? AVQueuePlayer {
          queuePlayer.removeAllItems()
        } else {
          $0.replaceCurrentItem(with: nil)
        }
      }
      self.preloadedPlayers.removeAll()
    }
  }`;

  if (!content.includes(oldRemoveAll)) {
    console.error('[patch-expo-audio] ERROR: Target signature not found in AudioComponentRegistry.swift.');
    return;
  }

  content = content.replace(oldRemoveAll, newRemoveAll);
  fs.writeFileSync(targetFile, content, 'utf8');
  console.log('[patch-expo-audio] Successfully patched AudioComponentRegistry.swift to prevent AVQueuePlayer crash on cleanup.');
}

patchMediaController();
patchAudioModule();
patchAudioComponentRegistry();
