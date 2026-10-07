const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const iosDir = path.join(packageRoot, 'node_modules', 'expo-audio', 'ios');

if (!fs.existsSync(iosDir)) {
  console.log('[patch-expo-audio] expo-audio/ios not found, skipping patch.');
  process.exit(0);
}

// 1. Patch MediaController.swift for lock screen next/previous track commands with background task support
function patchMediaController() {
  const targetFile = path.join(iosDir, 'MediaController.swift');
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-expo-audio] MediaController.swift not found.');
    return;
  }
  let content = fs.readFileSync(targetFile, 'utf8');
  if (content.includes('nextTrackCommand.addTarget') && content.includes('beginBackgroundTaskIfNeeded')) {
    console.log('[patch-expo-audio] MediaController.swift already patched.');
    return;
  }

  // Handle re-patching if it was previously patched without beginBackgroundTaskIfNeeded
  if (content.includes('nextTrackCommand.addTarget') && !content.includes('beginBackgroundTaskIfNeeded')) {
    content = content.replace(
      `      player.emit(event: "nextTrack")`,
      `      player.beginBackgroundTaskIfNeeded()\n      player.emit(event: "nextTrack")`
    );
    content = content.replace(
      `      player.emit(event: "previousTrack")`,
      `      player.beginBackgroundTaskIfNeeded()\n      player.emit(event: "previousTrack")`
    );
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log('[patch-expo-audio] Successfully updated MediaController.swift with background task assertions.');
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
      player.beginBackgroundTaskIfNeeded()
      player.emit(event: "nextTrack")
      return .success
    }

    remoteCommandCenter.previousTrackCommand.addTarget { [weak self] _ in
      guard let player = self?.activePlayer else {
        return .commandFailed
      }
      player.beginBackgroundTaskIfNeeded()
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
  console.log('[patch-expo-audio] Successfully patched MediaController.swift for lock screen controls.');
}

// 2. Patch AudioPlayer.swift for background task assertions and IPC throttle
function patchAudioPlayer() {
  const targetFile = path.join(iosDir, 'AudioPlayer.swift');
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-expo-audio] AudioPlayer.swift not found.');
    return;
  }
  let content = fs.readFileSync(targetFile, 'utf8');
  if (content.includes('beginBackgroundTaskIfNeeded')) {
    console.log('[patch-expo-audio] AudioPlayer.swift already patched.');
    return;
  }

  // A. Add background task fields and methods
  const oldObservers = `  // MARK: Observers
  private var timeToken: Any?
  private var cancellables = Set<AnyCancellable>()
  private var endObserver: NSObjectProtocol?`;

  const newObservers = `  // MARK: Observers
  private var timeToken: Any?
  private var cancellables = Set<AnyCancellable>()
  private var endObserver: NSObjectProtocol?

  private var backgroundTaskIdentifier: UIBackgroundTaskIdentifier = .invalid

  func beginBackgroundTaskIfNeeded() {
    guard backgroundTaskIdentifier == .invalid else { return }
    backgroundTaskIdentifier = UIApplication.shared.beginBackgroundTask(withName: "PuukAudioTransition") { [weak self] in
      self?.endBackgroundTaskIfNeeded()
    }
  }

  func endBackgroundTaskIfNeeded() {
    guard backgroundTaskIdentifier != .invalid else { return }
    let taskId = backgroundTaskIdentifier
    backgroundTaskIdentifier = .invalid
    UIApplication.shared.endBackgroundTask(taskId)
  }`;

  if (!content.includes(oldObservers)) {
    console.error('[patch-expo-audio] ERROR: Observers signature not found in AudioPlayer.swift.');
    return;
  }
  content = content.replace(oldObservers, newObservers);

  // B. End background task when playback starts
  const oldPlay = `    addPlaybackEndNotification()
    registerTimeObserver()
    ref.playImmediately(atRate: rate)

    if isActiveForLockScreen {`;

  const newPlay = `    addPlaybackEndNotification()
    registerTimeObserver()
    ref.playImmediately(atRate: rate)
    endBackgroundTaskIfNeeded()

    if isActiveForLockScreen {`;

  if (!content.includes(oldPlay)) {
    console.error('[patch-expo-audio] ERROR: play signature not found in AudioPlayer.swift.');
    return;
  }
  content = content.replace(oldPlay, newPlay);

  // C. End background task on pause
  const oldPause = `  func pause() {
    ref.pause()
  }`;

  const newPause = `  func pause() {
    ref.pause()
    endBackgroundTaskIfNeeded()
  }`;

  if (!content.includes(oldPause)) {
    console.error('[patch-expo-audio] ERROR: pause signature not found in AudioPlayer.swift.');
    return;
  }
  content = content.replace(oldPause, newPause);

  // D. End background task in sharedObjectWillRelease
  const oldRelease = `  public override func sharedObjectWillRelease() {
    ref.currentItem?.cancelPendingSeeks()`;

  const newRelease = `  public override func sharedObjectWillRelease() {
    endBackgroundTaskIfNeeded()
    ref.currentItem?.cancelPendingSeeks()`;

  if (!content.includes(oldRelease)) {
    console.error('[patch-expo-audio] ERROR: release signature not found in AudioPlayer.swift.');
    return;
  }
  content = content.replace(oldRelease, newRelease);

  // E. Begin background task on track completion
  const oldPlaybackEnd = `      if !self.isLooping {
        let currentTime = finishedItem.duration.seconds
        self.updateStatus(with: [
          "playing": false,
          "currentTime": currentTime.isNaN ? 0.0 : currentTime,
          "didJustFinish": true
        ])
        self.onPlaybackComplete?()
      }`;

  const newPlaybackEnd = `      if !self.isLooping {
        self.beginBackgroundTaskIfNeeded()
        let currentTime = finishedItem.duration.seconds
        self.updateStatus(with: [
          "playing": false,
          "currentTime": currentTime.isNaN ? 0.0 : currentTime,
          "didJustFinish": true
        ])
        self.onPlaybackComplete?()
      }`;

  if (!content.includes(oldPlaybackEnd)) {
    console.error('[patch-expo-audio] ERROR: PlaybackEnd signature not found in AudioPlayer.swift.');
    return;
  }
  content = content.replace(oldPlaybackEnd, newPlaybackEnd);

  // F. Parameterize updateStatus to avoid IPC spam on periodic time observer
  const oldUpdateStatus = `  func updateStatus(with dict: [String: Any]) {
    var arguments = currentStatus()
    arguments.merge(dict) { _, new in
      new
    }
    self.emit(event: AudioConstants.playbackStatus, payload: arguments)

    if isActiveForLockScreen {
      MediaController.shared.updateNowPlayingInfo(for: self)
    }
  }`;

  const newUpdateStatus = `  func updateStatus(with dict: [String: Any], updateNowPlaying: Bool = true) {
    var arguments = currentStatus()
    arguments.merge(dict) { _, new in
      new
    }
    self.emit(event: AudioConstants.playbackStatus, payload: arguments)

    if updateNowPlaying && isActiveForLockScreen {
      MediaController.shared.updateNowPlayingInfo(for: self)
    }
  }`;

  if (!content.includes(oldUpdateStatus)) {
    console.error('[patch-expo-audio] ERROR: updateStatus signature not found in AudioPlayer.swift.');
    return;
  }
  content = content.replace(oldUpdateStatus, newUpdateStatus);

  // G. Time observer should NOT call MediaController.updateNowPlayingInfo every 500ms
  const oldTimeObserver = `    timeToken = ref.addPeriodicTimeObserver(forInterval: interval, queue: nil) { [weak self] time in
      guard let self else {
        return
      }

      self.updateStatus(with: [
        "currentTime": time.seconds
      ])
    }`;

  const newTimeObserver = `    timeToken = ref.addPeriodicTimeObserver(forInterval: interval, queue: nil) { [weak self] time in
      guard let self else {
        return
      }

      self.updateStatus(with: [
        "currentTime": time.seconds
      ], updateNowPlaying: false)
    }`;

  if (!content.includes(oldTimeObserver)) {
    console.error('[patch-expo-audio] ERROR: timeObserver signature not found in AudioPlayer.swift.');
    return;
  }
  content = content.replace(oldTimeObserver, newTimeObserver);

  fs.writeFileSync(targetFile, content, 'utf8');
  console.log('[patch-expo-audio] Successfully patched AudioPlayer.swift for background task assertions and IPC throttle.');
}

// 3. Patch AudioModule.swift to fix AVQueuePlayer crash and prevent background audio session deactivation
function patchAudioModule() {
  const targetFile = path.join(iosDir, 'AudioModule.swift');
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-expo-audio] AudioModule.swift not found.');
    return;
  }
  let content = fs.readFileSync(targetFile, 'utf8');

  if (
    content.includes('queuePlayer.removeAllItems()') &&
    content.includes('guard !self.shouldPlayInBackground else') &&
    content.includes('!self.shouldPlayInBackground')
  ) {
    console.log('[patch-expo-audio] AudioModule.swift already patched.');
    return;
  }

  // A. Fix AVQueuePlayer replaceCurrentItem crash on preloaded items
  if (!content.includes('queuePlayer.removeAllItems()')) {
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
      console.error('[patch-expo-audio] ERROR: Target replace signature not found in AudioModule.swift.');
    } else {
      content = content.replace(oldReplace, newReplace);
    }
  }

  // B. Prevent deactivating audio session when shouldPlayInBackground is true
  if (!content.includes('guard !self.shouldPlayInBackground else')) {
    const oldDeactivate = `  private func deactivateSession() {
    Task {`;

    const newDeactivate = `  private func deactivateSession() {
    guard !self.shouldPlayInBackground else {
      return
    }
    Task {`;

    if (content.includes(oldDeactivate)) {
      content = content.replace(oldDeactivate, newDeactivate);
    } else {
      console.error('[patch-expo-audio] ERROR: deactivateSession signature not found in AudioModule.swift.');
    }
  }

  // C. Keep audio session active when shouldPlayInBackground is true on completion or pause
  if (!content.includes('!(self?.shouldPlayInBackground ?? false)')) {
    const oldComplete = `        player.onPlaybackComplete = { [weak self] in
          if !keepAudioSessionActive {
            self?.deactivateSession()
          }
        }`;

    const newComplete = `        player.onPlaybackComplete = { [weak self] in
          if !keepAudioSessionActive && !(self?.shouldPlayInBackground ?? false) {
            self?.deactivateSession()
          }
        }`;

    if (content.includes(oldComplete)) {
      content = content.replace(oldComplete, newComplete);
    }
  }

  if (!content.includes('!self.shouldPlayInBackground')) {
    const oldPauseSession = `      Function("pause") { player in
        player.ref.pause()
        if !player.keepAudioSessionActive {
          deactivateSession()
        }
      }`;

    const newPauseSession = `      Function("pause") { player in
        player.ref.pause()
        if !player.keepAudioSessionActive && !self.shouldPlayInBackground {
          deactivateSession()
        }
      }`;

    if (content.includes(oldPauseSession)) {
      content = content.replace(oldPauseSession, newPauseSession);
    }
  }

  fs.writeFileSync(targetFile, content, 'utf8');
  console.log('[patch-expo-audio] Successfully patched AudioModule.swift.');
}

// 4. Patch AudioComponentRegistry.swift to fix removeAllPreloadedPlayers crash on AVQueuePlayer
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
patchAudioPlayer();
patchAudioModule();
patchAudioComponentRegistry();
