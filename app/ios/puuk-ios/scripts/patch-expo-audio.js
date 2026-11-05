// Puuk source identity v1: SDK 58.0.10 only. All transformations stage in memory.
const nodeFs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const staged = new Map();
const fs = {
  existsSync: nodeFs.existsSync,
  readFileSync: (file, encoding) =>
    staged.has(file) ? staged.get(file) : nodeFs.readFileSync(file, encoding),
  writeFileSync: (file, content) => staged.set(file, content),
};
const packageRoot = path.resolve(__dirname, '..');
const iosDir =
  process.env.PUUK_EXPO_AUDIO_IOS_DIR ||
  path.join(packageRoot, 'node_modules', 'expo-audio', 'ios');
const digest = (text) => createHash('sha256').update(text).digest('hex');
// 1. Patch MediaController.swift for lock screen controls, background task support, and immediate artwork updates
function patchMediaController() {
  const targetFile = path.join(iosDir, 'MediaController.swift');
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-expo-audio] MediaController.swift not found.');
    return;
  }
  let content = fs.readFileSync(targetFile, 'utf8');
  let modified = false;

  const isRemoteCommandsPatched =
    content.includes('player.emit(event: "nextTrack")') &&
    content.includes('beginBackgroundTaskIfNeeded');
  const isArtworkPatched =
    content.includes('info.removeValue(forKey: MPMediaItemPropertyArtwork)') &&
    content.includes('returnCacheDataElseLoad') &&
    content.includes(
      'playable.metadata?.artworkUrl == nil || playable.metadata?.artworkUrl != currentArtworkUrl',
    );

  if (isRemoteCommandsPatched && isArtworkPatched) {
    console.log('[patch-expo-audio] MediaController.swift already patched.');
    return;
  }

  // A. Remote commands
  if (!isRemoteCommandsPatched) {
    const oldNextTarget = `    let nextTrackTarget = remoteCommandCenter.nextTrackCommand.addTarget { [weak self] _ in
      guard let playable = self?.activePlayable,
            playable.supportsNextTrack else {
        return .commandFailed
      }

      playable.nextTrack()
      return .success
    }
    remoteCommandTargets.append((remoteCommandCenter.nextTrackCommand, nextTrackTarget))

    let previousTrackTarget = remoteCommandCenter.previousTrackCommand.addTarget { [weak self] _ in
      guard let playable = self?.activePlayable,
            playable.supportsPreviousTrack else {
        return .commandFailed
      }

      playable.previousTrack()
      return .success
    }
    remoteCommandTargets.append((remoteCommandCenter.previousTrackCommand, previousTrackTarget))`;

    const newNextTarget = `    let nextTrackTarget = remoteCommandCenter.nextTrackCommand.addTarget { [weak self] _ in
      guard let playable = self?.activePlayable else {
        return .commandFailed
      }
      if let player = playable as? AudioPlayer {
        player.beginBackgroundTaskIfNeeded()
        player.emit(event: "nextTrack")
      } else {
        guard playable.supportsNextTrack else { return .commandFailed }
        playable.nextTrack()
      }
      return .success
    }
    remoteCommandTargets.append((remoteCommandCenter.nextTrackCommand, nextTrackTarget))

    let previousTrackTarget = remoteCommandCenter.previousTrackCommand.addTarget { [weak self] _ in
      guard let playable = self?.activePlayable else {
        return .commandFailed
      }
      if let player = playable as? AudioPlayer {
        player.beginBackgroundTaskIfNeeded()
        player.emit(event: "previousTrack")
      } else {
        guard playable.supportsPreviousTrack else { return .commandFailed }
        playable.previousTrack()
      }
      return .success
    }
    remoteCommandTargets.append((remoteCommandCenter.previousTrackCommand, previousTrackTarget))`;

    const oldEnableLogic = `    let supportsNextTrack = activePlayable?.supportsNextTrack ?? false
    let supportsPreviousTrack = activePlayable?.supportsPreviousTrack ?? false
    let showNextTrack = (options?.showNextTrack ?? false) && supportsNextTrack
    let showPreviousTrack = (options?.showPreviousTrack ?? false) && supportsPreviousTrack

    remoteCommandCenter.skipForwardCommand.isEnabled = (options?.showSeekForward ?? false) && !showNextTrack
    remoteCommandCenter.skipBackwardCommand.isEnabled = (options?.showSeekBackward ?? false) && !showPreviousTrack
    remoteCommandCenter.nextTrackCommand.isEnabled = showNextTrack
    remoteCommandCenter.previousTrackCommand.isEnabled = showPreviousTrack`;

    const newEnableLogic = `    let showSeekForward = options?.showSeekForward ?? false
    let showSeekBackward = options?.showSeekBackward ?? false
    remoteCommandCenter.skipForwardCommand.isEnabled = showSeekForward
    remoteCommandCenter.skipBackwardCommand.isEnabled = showSeekBackward
    remoteCommandCenter.nextTrackCommand.isEnabled = !showSeekForward
    remoteCommandCenter.previousTrackCommand.isEnabled = !showSeekBackward`;

    const oldDisableLogic = `    remoteCommandCenter.skipForwardCommand.isEnabled = false
    remoteCommandCenter.skipBackwardCommand.isEnabled = false
    remoteCommandCenter.nextTrackCommand.isEnabled = false
    remoteCommandCenter.previousTrackCommand.isEnabled = false

    removeRemoteCommandTargets()`;

    const newDisableLogic = `    remoteCommandCenter.skipForwardCommand.isEnabled = false
    remoteCommandCenter.skipBackwardCommand.isEnabled = false
    remoteCommandCenter.nextTrackCommand.isEnabled = false
    remoteCommandCenter.previousTrackCommand.isEnabled = false

    remoteCommandCenter.nextTrackCommand.removeTarget(self)
    remoteCommandCenter.previousTrackCommand.removeTarget(self)
    removeRemoteCommandTargets()`;

    if (
      content.includes(oldNextTarget) &&
      content.includes(oldEnableLogic) &&
      content.includes(oldDisableLogic)
    ) {
      content = content.replace(oldNextTarget, newNextTarget);
      content = content.replace(oldEnableLogic, newEnableLogic);
      content = content.replace(oldDisableLogic, newDisableLogic);
      modified = true;
    } else {
      console.error(
        '[patch-expo-audio] ERROR: Remote command target signatures not found in MediaController.swift.',
      );
    }
  }

  // B. Immediate artwork clearing and cache policy
  if (!isArtworkPatched) {
    const oldArtworkReset = `    let nextArtworkItemIdentifier = playable.lockScreenPlayer.currentItem.map { ObjectIdentifier($0) }
    if currentArtworkItemIdentifier != nextArtworkItemIdentifier {
      resetArtworkState()
      currentArtworkItemIdentifier = nextArtworkItemIdentifier
    }`;

    const newArtworkReset = `    let nextArtworkItemIdentifier = playable.lockScreenPlayer.currentItem.map { ObjectIdentifier($0) }
    if currentArtworkItemIdentifier != nextArtworkItemIdentifier {
      currentArtworkItemIdentifier = nextArtworkItemIdentifier
      if playable.metadata?.artworkUrl == nil || playable.metadata?.artworkUrl != currentArtworkUrl {
        resetArtworkState()
      }
    }`;

    const oldArtworkUrlChange = `    if currentArtworkUrl != artworkUrl {
      currentArtworkUrl = artworkUrl
      cachedArtwork = nil
      artworkLoadToken = nil
    }`;

    const newArtworkUrlChange = `    if currentArtworkUrl != artworkUrl {
      currentArtworkUrl = artworkUrl
      cachedArtwork = nil
      artworkLoadToken = nil
      info.removeValue(forKey: MPMediaItemPropertyArtwork)
    }`;

    const oldArtworkGuard = `      guard self.activePlayable?.id == playable.id,
            self.currentArtworkUrl == artworkUrl,
            self.currentArtworkItemIdentifier == currentItemIdentifier else {
        return
      }`;

    const newArtworkGuard = `      guard self.activePlayable?.id == playable.id,
            self.currentArtworkUrl == artworkUrl else {
        return
      }`;

    const oldLoadArtwork = `  private func loadArtworkFromURL(url: URL, completion: @escaping (MPMediaItemArtwork?) -> Void) {
    URLSession.shared.dataTask(with: url) { data, _, error in`;

    const newLoadArtwork = `  private func loadArtworkFromURL(url: URL, completion: @escaping (MPMediaItemArtwork?) -> Void) {
    var request = URLRequest(url: url)
    request.cachePolicy = .returnCacheDataElseLoad
    URLSession.shared.dataTask(with: request) { data, _, error in`;

    if (
      content.includes(oldArtworkReset) &&
      content.includes(oldArtworkUrlChange) &&
      content.includes(oldArtworkGuard) &&
      content.includes(oldLoadArtwork)
    ) {
      content = content.replace(oldArtworkReset, newArtworkReset);
      content = content.replace(oldArtworkUrlChange, newArtworkUrlChange);
      content = content.replace(oldArtworkGuard, newArtworkGuard);
      content = content.replace(oldLoadArtwork, newLoadArtwork);
      modified = true;
    } else {
      console.error(
        '[patch-expo-audio] ERROR: Artwork target signatures not found in MediaController.swift.',
      );
    }
  }

  if (modified) {
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log(
      '[patch-expo-audio] Successfully patched MediaController.swift for lock screen controls and immediate artwork updates.',
    );
  }
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
    console.error(
      '[patch-expo-audio] ERROR: Observers signature not found in AudioPlayer.swift.',
    );
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
    console.error(
      '[patch-expo-audio] ERROR: play signature not found in AudioPlayer.swift.',
    );
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
    console.error(
      '[patch-expo-audio] ERROR: pause signature not found in AudioPlayer.swift.',
    );
    return;
  }
  content = content.replace(oldPause, newPause);

  // D. End background task in sharedObjectWillRelease
  const oldRelease = `  public override func sharedObjectWillRelease() {
    onRelease?()
    onRelease = nil
    ref.currentItem?.cancelPendingSeeks()`;

  const newRelease = `  public override func sharedObjectWillRelease() {
    endBackgroundTaskIfNeeded()
    onRelease?()
    onRelease = nil
    ref.currentItem?.cancelPendingSeeks()`;

  if (!content.includes(oldRelease)) {
    console.error(
      '[patch-expo-audio] ERROR: release signature not found in AudioPlayer.swift.',
    );
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
    console.error(
      '[patch-expo-audio] ERROR: PlaybackEnd signature not found in AudioPlayer.swift.',
    );
    return;
  }
  content = content.replace(oldPlaybackEnd, newPlaybackEnd);

  // F. Parameterize updateStatus to avoid IPC spam on periodic time observer
  const oldUpdateStatus = `  func updateStatus(with dict: [String: Any]) {
    // Reading currentTime waits on the player's lock while a source swap pauses it.
    var arguments = currentStatus(knownCurrentTime: dict["currentTime"] as? Double)
    arguments.merge(dict) { _, new in
      new
    }
    self.emit(event: AudioConstants.playbackStatus, payload: arguments)

    if isActiveForLockScreen {
      MediaController.shared.updateNowPlayingInfo(for: self)
    }
  }`;

  const newUpdateStatus = `  func updateStatus(with dict: [String: Any], updateNowPlaying: Bool = true) {
    // Reading currentTime waits on the player's lock while a source swap pauses it.
    var arguments = currentStatus(knownCurrentTime: dict["currentTime"] as? Double)
    arguments.merge(dict) { _, new in
      new
    }
    self.emit(event: AudioConstants.playbackStatus, payload: arguments)

    if updateNowPlaying && isActiveForLockScreen {
      MediaController.shared.updateNowPlayingInfo(for: self)
    }
  }`;

  if (!content.includes(oldUpdateStatus)) {
    console.error(
      '[patch-expo-audio] ERROR: updateStatus signature not found in AudioPlayer.swift.',
    );
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
    console.error(
      '[patch-expo-audio] ERROR: timeObserver signature not found in AudioPlayer.swift.',
    );
    return;
  }
  content = content.replace(oldTimeObserver, newTimeObserver);

  fs.writeFileSync(targetFile, content, 'utf8');
  console.log(
    '[patch-expo-audio] Successfully patched AudioPlayer.swift for background task assertions and IPC throttle.',
  );
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
    const oldReplace = `        if let uri = source?.uri?.absoluteString, let cachedPlayer = self.registry.removePreloadedPlayer(forKey: uri) {
          let cachedItem = cachedPlayer.currentItem
          cachedPlayer.replaceCurrentItem(with: nil)
          player.replaceWithPreloadedItem(cachedItem)
        } else {
          player.replaceCurrentSource(source: source)
        }`;

    const newReplace = `        if let uri = source?.uri?.absoluteString, let cachedPlayer = self.registry.removePreloadedPlayer(forKey: uri) {
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
      console.error(
        '[patch-expo-audio] ERROR: Target replace signature not found in AudioModule.swift.',
      );
    } else {
      content = content.replace(oldReplace, newReplace);
    }
  }

  // B. Prevent deactivating audio session when shouldPlayInBackground is true
  if (!content.includes('guard !self.shouldPlayInBackground else')) {
    const oldDeactivate = `  private func deactivateSession() {
    sessionQueue.asyncAfter(deadline: .now() + .milliseconds(100)) { [weak self] in`;

    const newDeactivate = `  private func deactivateSession() {
    guard !self.shouldPlayInBackground else {
      return
    }
    sessionQueue.asyncAfter(deadline: .now() + .milliseconds(100)) { [weak self] in`;

    if (content.includes(oldDeactivate)) {
      content = content.replace(oldDeactivate, newDeactivate);
    } else {
      console.error(
        '[patch-expo-audio] ERROR: deactivateSession signature not found in AudioModule.swift.',
      );
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
          self.deactivateSession()
        }
      }`;

    const newPauseSession = `      Function("pause") { player in
        player.ref.pause()
        if !player.keepAudioSessionActive && !self.shouldPlayInBackground {
          self.deactivateSession()
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
    console.log(
      '[patch-expo-audio] AudioComponentRegistry.swift already patched.',
    );
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
    console.error(
      '[patch-expo-audio] ERROR: Target signature not found in AudioComponentRegistry.swift.',
    );
    return;
  }

  content = content.replace(oldRemoveAll, newRemoveAll);
  fs.writeFileSync(targetFile, content, 'utf8');
  console.log(
    '[patch-expo-audio] Successfully patched AudioComponentRegistry.swift to prevent AVQueuePlayer crash on cleanup.',
  );
}

// 5. Patch AudioUtils.swift to prevent synchronous thread blocking on AVPlayerItem creation
function patchAudioUtils() {
  const targetFile = path.join(iosDir, 'AudioUtils.swift');
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-expo-audio] AudioUtils.swift not found.');
    return;
  }
  let content = fs.readFileSync(targetFile, 'utf8');
  if (!content.includes('automaticallyLoadedAssetKeys')) {
    console.log('[patch-expo-audio] AudioUtils.swift already patched.');
    return;
  }

  const oldItem = `    let asset = AVURLAsset(url: finalUrl, options: options)
    return AVPlayerItem(asset: asset, automaticallyLoadedAssetKeys: [.tracks, .duration])`;

  const newItem = `    let asset = AVURLAsset(url: finalUrl, options: options)
    return AVPlayerItem(asset: asset)`;

  if (!content.includes(oldItem)) {
    console.error(
      '[patch-expo-audio] ERROR: Target signature not found in AudioUtils.swift.',
    );
    return;
  }

  content = content.replace(oldItem, newItem);
  fs.writeFileSync(targetFile, content, 'utf8');
  console.log(
    '[patch-expo-audio] Successfully patched AudioUtils.swift to eliminate synchronous thread blocking on item creation.',
  );
}

function replaceOnce(content, before, after) {
  if (
    !content.includes(before) ||
    content.indexOf(before) !== content.lastIndexOf(before)
  ) {
    throw new Error(
      `Source drift: expected one occurrence of ${before.slice(0, 80)}`,
    );
  }
  return content.replace(before, after);
}

function replaceMethod(content, start, next, replacement) {
  const from = content.indexOf(start);
  const to = content.indexOf(next, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Source drift: method ${start}`);
  return content.slice(0, from) + replacement + '\n\n' + content.slice(to);
}

function patchSourceIdentity() {
  const file = path.join(iosDir, 'AudioPlayer.swift');
  let s = fs.readFileSync(file, 'utf8');
  s = replaceOnce(
    s,
    '  private var source: AudioSource?',
    `  private var source: AudioSource?

  // One immutable binding per installed source; callbacks capture their concrete item/player.
  private struct SourceContext {
    let player: AVPlayer
    let item: AVPlayerItem
    let attemptId: String?
  }
  private var attemptByItem = NSMapTable<AVPlayerItem, NSString>.weakToStrongObjects()
  private var sourceAttemptId: String?
  private var itemStatusSubscription: AnyCancellable?
  private var readySubscription: AnyCancellable?
  // Commands may arrive from JS and system remote-control threads. Recursive because KVO
  // can synchronously re-enter during an AVPlayer mutation; never hold this across an await.
  private let sourceLock = NSRecursiveLock()
  private var nativeIntent = "pause"
  private(set) var intentRevision = 0
  private var seekRevision = 0
  private var released = false

  func clearSourceAttempt() { sourceAttemptId = nil }

  var puukWantsPlayback: Bool {
    sourceLock.lock(); defer { sourceLock.unlock() }
    return nativeIntent == "play"
  }

  private func sourceContext() -> SourceContext? {
    guard !released, let item = ref.currentItem else { return nil }
    return SourceContext(player: ref, item: item, attemptId: attemptByItem.object(forKey: item).map { String($0) })
  }

  private func isCurrent(_ context: SourceContext) -> Bool {
    return !released && ref === context.player && ref.currentItem === context.item &&
      sourceAttemptId == context.attemptId &&
      attemptByItem.object(forKey: context.item).map { String($0) } == context.attemptId
  }

  // No native-preload lookup, no implicit autoplay: explicit JS intent owns this entry point.
  func replaceWithAttempt(source: AudioSource?, attemptId: String, expectedIntentRevision: Int?, expectedAttemptId: String?) -> Bool {
    guard !released, source?.uri != nil, !attemptId.isEmpty else { return false }
    if let expectedIntentRevision {
      guard intentRevision == expectedIntentRevision, puukWantsPlayback,
        sourceAttemptId == expectedAttemptId else { return false }
    }
    sourceAttemptId = attemptId
    replaceCurrentSource(source: source, resumeWhenReady: false)
    return true
  }

  func playForAttempt(_ attemptId: String, expectedIntentRevision: Int?) -> Bool {
    guard !released, sourceAttemptId == attemptId, let context = sourceContext(),
      isCurrent(context) else { return false }
    if let expectedIntentRevision {
      guard intentRevision == expectedIntentRevision, puukWantsPlayback else { return false }
    }
    play(at: effectiveRate)
    return true
  }`,
  );
  s = replaceOnce(
    s,
    '      updateStatus(with: [:])',
    '      updateStatus(with: [:], context: sourceContext())',
  );
  s = replaceOnce(
    s,
    '  func play(at rate: Float) {',
    `  func play(at rate: Float) {
    guard !released else { return }
    readySubscription = nil
    nativeIntent = "play"
    intentRevision += 1`,
  );
  s = replaceOnce(
    s,
    '    ref.playImmediately(atRate: rate)\n    endBackgroundTaskIfNeeded()',
    `    ref.playImmediately(atRate: rate)
    updateStatus(with: ["nativeEvent": "intent"], context: sourceContext())
    endBackgroundTaskIfNeeded()`,
  );
  s = replaceOnce(
    s,
    '      "id": id,',
    `      "id": id,
      "sourceIdentityVersion": 1,
      "sourceAttemptId": sourceContext()?.attemptId,
      "nativeIntent": nativeIntent,
      "intentRevision": intentRevision,
      "nativeEvent": "snapshot",`,
  );
  s = replaceMethod(
    s,
    '  func updateStatus(with dict:',
    '  func seekTo(',
    `  private func updateStatus(with dict: [String: Any], context: SourceContext?, updateNowPlaying: Bool = true) {
    // Async callers MUST pass the captured origin. Missing or obsolete context is dropped.
    guard let context, isCurrent(context) else { return }
    var arguments = currentStatus(knownCurrentTime: dict["currentTime"] as? Double)
    arguments.merge(dict) { _, new in new }
    arguments["sourceAttemptId"] = context.attemptId
    self.emit(event: AudioConstants.playbackStatus, payload: arguments)
    if updateNowPlaying && isActiveForLockScreen {
      MediaController.shared.updateNowPlayingInfo(for: self)
    }
  }`,
  );
  s = replaceMethod(
    s,
    '  func seekTo(',
    '  private func applyPreferredForwardBufferDuration()',
    `  func seekForAttempt(_ attemptId: String, seconds: Double, expectedIntentRevision: Int?) -> Bool {
    guard !released, sourceAttemptId == attemptId, seconds.isFinite, sourceContext() != nil else { return false }
    if let expectedIntentRevision {
      guard intentRevision == expectedIntentRevision else { return false }
    }
    performSeek(seconds: max(0, seconds), toleranceMillisBefore: nil,
      toleranceMillisAfter: nil, origin: expectedIntentRevision == nil ? "user" : "recovery", completion: {})
    return true
  }

  @discardableResult
  func seekFromRemote(_ seconds: Double, exact: Bool = false) -> Bool {
    guard seconds.isFinite, sourceContext() != nil else { return false }
    performSeek(seconds: max(0, seconds), toleranceMillisBefore: exact ? 0 : nil,
      toleranceMillisAfter: exact ? 0 : nil, origin: "user", completion: {})
    return true
  }

  func seekTo(seconds: Double, toleranceMillisBefore: Double? = nil, toleranceMillisAfter: Double? = nil) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      performSeek(seconds: seconds, toleranceMillisBefore: toleranceMillisBefore,
        toleranceMillisAfter: toleranceMillisAfter, origin: "user") { continuation.resume() }
    }
  }

  private func performSeek(seconds: Double, toleranceMillisBefore: Double?, toleranceMillisAfter: Double?, origin: String, completion: @escaping () -> Void) {
    guard seconds.isFinite, let context = sourceContext() else { completion(); return }
    readySubscription = nil
    seekRevision += 1
    if origin == "user" { intentRevision += 1 }
    let seekToken = seekRevision
    updateStatus(with: ["nativeEvent": "seekIntent", "seekTargetSeconds": seconds, "seekOrigin": origin], context: context)
    let time = CMTime(seconds: seconds, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
    let before = toleranceMillisBefore.map { CMTime(seconds: $0 / 1000.0, preferredTimescale: CMTimeScale(NSEC_PER_SEC)) } ?? .positiveInfinity
    let after = toleranceMillisAfter.map { CMTime(seconds: $0 / 1000.0, preferredTimescale: CMTimeScale(NSEC_PER_SEC)) } ?? .positiveInfinity
    context.player.seek(to: time, toleranceBefore: before, toleranceAfter: after) { [weak self] finished in
      if let self {
        self.sourceLock.lock(); defer { self.sourceLock.unlock() }
        if self.isCurrent(context), self.seekRevision == seekToken {
          self.updateStatus(with: ["currentTime": context.item.currentTime().seconds,
            "nativeEvent": "seek", "seekCompleted": finished, "seekOrigin": origin], context: context)
        }
      }
      completion()
    }
  }`,
  );
  s = replaceMethod(
    s,
    '  private func setupPublisher()',
    '  func replaceWithPreloadedItem(',
    `  private func setupPublisher() {
    let observedPlayer = ref
    observedPlayer.publisher(for: \\.currentItem)
      .sink { [weak self, weak observedPlayer] item in
        guard let self else { return }
        self.sourceLock.lock(); defer { self.sourceLock.unlock() }
        guard let observedPlayer, self.ref === observedPlayer, observedPlayer.currentItem === item, !self.released else { return }
        self.itemStatusSubscription = nil
        self.readySubscription = nil
        self.applyPreferredForwardBufferDuration()
        guard let item else { return }
        // Known loop/reset descendants inherit the installed source, never an arbitrary event.
        let context = SourceContext(player: observedPlayer, item: item,
          attemptId: self.attemptByItem.object(forKey: item).map { String($0) })
        guard self.isCurrent(context) else { return }
        self.itemStatusSubscription = item.publisher(for: \\.status)
          .sink { [weak self] status in
            guard let self else { return }
            self.sourceLock.lock(); defer { self.sourceLock.unlock() }
            guard self.isCurrent(context) else { return }
            if status == .readyToPlay {
              self.updateStatus(with: ["isLoaded": true, "nativeEvent": "loaded"], context: context)
              if self.isLooping { self.enqueueNextLoopItem() }
              if self.shouldInstallAudioTap || self.samplingEnabled {
                self.installTap()
                self.shouldInstallAudioTap = false
              }
            } else if status == .failed {
              self.readySubscription = nil
              self.endBackgroundTaskIfNeeded()
              self.updateStatus(with: [
                "error": context.item.error?.localizedDescription ?? "Unknown error",
                "nativeEvent": "error"
              ], context: context)
            }
          }
        // Refresh item-bound observers even when AVQueuePlayer advances its loop item.
        self.addPlaybackEndNotification()
        self.registerTimeObserver()
        if self.isLooping { self.enqueueNextLoopItem() }
        if self.samplingEnabled && self.isLoaded {
          self.uninstallTap()
          self.installTap()
        }
      }
      .store(in: &cancellables)
  }`,
  );
  s = replaceOnce(
    s,
    '  func replaceWithPreloadedItem(_ item: AVPlayerItem?) {',
    `  func replaceWithPreloadedItem(_ item: AVPlayerItem?, source: AudioSource?) {
    self.source = source
    sourceAttemptId = nil
    readySubscription = nil`,
  );
  s = replaceOnce(
    s,
    '  func replaceCurrentSource(source: AudioSource?) {',
    `  func replaceCurrentSource(source: AudioSource?, resumeWhenReady: Bool = true) {
    readySubscription = nil`,
  );
  s = replaceOnce(
    s,
    `    if wasPlaying {
      onReady { [weak self] in`,
    `    if wasPlaying && resumeWhenReady {
      onReady { [weak self] in`,
  );
  s = replaceOnce(
    s,
    '      updateStatus(with: ["mediaServicesDidReset": true])',
    '      updateStatus(with: ["mediaServicesDidReset": true, "nativeEvent": "reset"], context: sourceContext())',
  );
  s = replaceOnce(
    s,
    '      self.updateStatus(with: ["mediaServicesDidReset": true])',
    '      self.updateStatus(with: ["mediaServicesDidReset": true, "nativeEvent": "reset"], context: self.sourceContext())',
  );
  // Capture reset callback origin explicitly, and never emit a reset from a later item.
  s = replaceOnce(
    s,
    `    onReady { [weak self] in
      guard let self else { return }
      self.restorePlaybackState(time: savedTime, shouldResume: shouldResume, rate: savedRate)
      self.wasPlaying = false
      self.updateStatus(with: ["mediaServicesDidReset": true, "nativeEvent": "reset"], context: self.sourceContext())
    }`,
    `    guard let context = sourceContext() else { return }
    onReady { [weak self] in
      guard let self, self.isCurrent(context) else { return }
      self.restorePlaybackState(time: savedTime, shouldResume: shouldResume, rate: savedRate)
      self.wasPlaying = false
      self.updateStatus(with: ["mediaServicesDidReset": true, "nativeEvent": "reset"], context: context)
    }`,
  );
  s = replaceOnce(
    s,
    '    setupPublisher()\n\n    if restoreSampling',
    `    if let item = ref.currentItem, let sourceAttemptId {
      attemptByItem.setObject(sourceAttemptId as NSString, forKey: item)
    }
    setupPublisher()

    if restoreSampling`,
  );
  s = replaceOnce(
    s,
    '  private func teardownPlayer() {',
    `  private func teardownPlayer() {
    readySubscription = nil
    itemStatusSubscription = nil
    ref.currentItem?.cancelPendingSeeks()`,
  );
  s = replaceMethod(
    s,
    '  private func onReady(',
    '  private func restorePlaybackState(',
    `  private func onReady(_ completion: @escaping () -> Void) {
    guard let context = sourceContext() else { return }
    let intentToken = intentRevision
    let seekToken = seekRevision
    readySubscription = context.item.publisher(for: \\.status)
      .filter { $0 == .readyToPlay }
      .first()
      .sink { [weak self] _ in
        guard let self else { return }
        self.sourceLock.lock(); defer { self.sourceLock.unlock() }
        guard self.isCurrent(context), self.intentRevision == intentToken,
          self.seekRevision == seekToken else { return }
        completion()
      }
  }`,
  );
  s = replaceMethod(
    s,
    '  private func restorePlaybackState(',
    '  private func installTap()',
    `  private func restorePlaybackState(time: Double, shouldResume: Bool, rate: Float) {
    guard let context = sourceContext() else { return }
    let intentToken = intentRevision
    let seekToken = seekRevision
    let cmTime = CMTime(seconds: time, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
    context.player.seek(to: cmTime) { [weak self] _ in
      guard let self else { return }
      self.sourceLock.lock(); defer { self.sourceLock.unlock() }
      guard self.isCurrent(context), shouldResume,
        self.intentRevision == intentToken, self.seekRevision == seekToken,
        self.puukWantsPlayback else { return }
      self.play(at: rate)
    }
  }`,
  );
  s = replaceOnce(
    s,
    '  private func replacePlayerItem(with item: AVPlayerItem?) {',
    `  private func replacePlayerItem(with item: AVPlayerItem?) {
    readySubscription = nil
    itemStatusSubscription = nil
    ref.currentItem?.cancelPendingSeeks()
    if let timeToken { ref.removeTimeObserver(timeToken); self.timeToken = nil }
    if let endObserver { NotificationCenter.default.removeObserver(endObserver); self.endObserver = nil }
    if let item, let sourceAttemptId {
      attemptByItem.setObject(sourceAttemptId as NSString, forKey: item)
    }`,
  );
  s = replaceOnce(
    s,
    '    queuePlayer.insert(nextItem, after: currentItem)',
    `    if let attempt = attemptByItem.object(forKey: currentItem) {
      attemptByItem.setObject(attempt, forKey: nextItem)
    }
    queuePlayer.insert(nextItem, after: currentItem)`,
  );
  s = replaceMethod(
    s,
    '  private func addPlaybackEndNotification()',
    '  private func registerTimeObserver()',
    `  private func addPlaybackEndNotification() {
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    guard let context = sourceContext() else { return }
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime, object: context.item, queue: nil
    ) { [weak self] notification in
      guard let self else { return }
      self.sourceLock.lock(); defer { self.sourceLock.unlock() }
      guard let finishedItem = notification.object as? AVPlayerItem,
        finishedItem === context.item, self.isCurrent(context) else { return }
      if !self.isLooping {
        self.beginBackgroundTaskIfNeeded()
        let currentTime = context.item.duration.seconds
        self.updateStatus(with: [
          "playing": false, "currentTime": currentTime.isNaN ? 0.0 : currentTime,
          "didJustFinish": true, "nativeEvent": "finish"
        ], context: context)
        self.onPlaybackComplete?()
      }
    }
  }`,
  );
  s = replaceOnce(
    s,
    `    let updateInterval = interval / 1000`,
    `    guard let context = sourceContext() else { return }
    let updateInterval = interval / 1000`,
  );
  s = replaceOnce(
    s,
    `    timeToken = ref.addPeriodicTimeObserver(forInterval: interval, queue: nil) { [weak self] time in
      guard let self else {`,
    `    timeToken = context.player.addPeriodicTimeObserver(forInterval: interval, queue: nil) { [weak self] time in
      guard let self, self.isCurrent(context) else {`,
  );
  s = replaceOnce(
    s,
    `        "currentTime": time.seconds
      ], updateNowPlaying: false)`,
    `        "currentTime": time.seconds, "nativeEvent": "progress"
      ], context: context, updateNowPlaying: false)`,
  );
  s = replaceOnce(
    s,
    `  func pause() {
    ref.pause()
    endBackgroundTaskIfNeeded()
  }

  func resumePlayback() {
    ref.play()
  }`,
    `  func pause() {
    setPausedIntent("pause")
    wasPlaying = false
  }

  func pauseForInterruption() {
    setPausedIntent("interrupted")
  }

  private func setPausedIntent(_ intent: String) {
    readySubscription = nil
    nativeIntent = intent
    intentRevision += 1
    ref.pause()
    endBackgroundTaskIfNeeded()
    updateStatus(with: ["playing": false, "nativeEvent": "intent"], context: sourceContext())
  }

  func resumePlayback() {
    guard nativeIntent == "interrupted" else { return }
    play(at: effectiveRate)
  }`,
  );
  s = replaceOnce(
    s,
    '  public override func sharedObjectWillRelease() {',
    `  public override func sharedObjectWillRelease() {
    released = true
    readySubscription = nil
    itemStatusSubscription = nil
    attemptByItem.removeAllObjects()
    sourceAttemptId = nil`,
  );
  // One critical section covers guard + AVPlayer command, including same-source seeks.
  for (const signature of [
    '  func replaceWithAttempt(source:',
    '  func playForAttempt(',
    '  func seekForAttempt(',
    '  func seekFromRemote(',
    '  private func performSeek(',
    '  func play(at rate:',
    '  func replaceCurrentSource(',
    '  func replaceWithPreloadedItem(',
    '  private func setPausedIntent(',
    '  func resumePlayback()',
    '  func handleMediaServicesReset()',
    '  public override func sharedObjectWillRelease()',
    '  private func sourceContext()',
    '  private func isCurrent(',
    '  private func updateStatus(',
    '  func currentStatus(',
  ]) {
    const lineStart = s.indexOf(signature);
    const body = s.indexOf(' {\n', lineStart);
    if (lineStart < 0 || body < 0)
      throw new Error(`Source drift: lock boundary ${signature}`);
    s =
      s.slice(0, body + 3) +
      '    sourceLock.lock(); defer { sourceLock.unlock() }\n' +
      s.slice(body + 3);
  }
  s = replaceOnce(
    s,
    '  func clearSourceAttempt() { sourceAttemptId = nil }',
    `  func clearSourceAttempt() {
    sourceLock.lock(); defer { sourceLock.unlock() }
    sourceAttemptId = nil
  }`,
  );
  fs.writeFileSync(file, s);

  const moduleFile = path.join(iosDir, 'AudioModule.swift');
  s = fs.readFileSync(moduleFile, 'utf8');
  s = replaceOnce(
    s,
    '      Property("id") { player in',
    `      // Additive native API; absent in existing binaries, so JS must capability-check.
      Property("puukSourceIdentityVersion") { (_: AudioPlayer) in 1 }

      Function("replaceWithAttempt") { (player: AudioPlayer, source: AudioSource?, attemptId: String, expectedIntentRevision: Int?, expectedAttemptId: String?) -> Bool in
        player.replaceWithAttempt(source: source, attemptId: attemptId, expectedIntentRevision: expectedIntentRevision, expectedAttemptId: expectedAttemptId)
      }

      Function("seekForAttempt") { (player: AudioPlayer, attemptId: String, seconds: Double, expectedIntentRevision: Int?) -> Bool in
        player.seekForAttempt(attemptId, seconds: seconds, expectedIntentRevision: expectedIntentRevision)
      }

      Function("playForAttempt") { (player: AudioPlayer, attemptId: String, expectedIntentRevision: Int?) -> Bool in
        guard self.canStartPlayback() else { return false }
        guard player.playForAttempt(attemptId, expectedIntentRevision: expectedIntentRevision) else { return false }
        self.activateSession(for: player)
        return true
      }

      Property("id") { player in`,
  );
  s = replaceOnce(
    s,
    '      Function("replace") { (player, source: AudioSource?) in',
    `      Function("replace") { (player, source: AudioSource?) in
        player.clearSourceAttempt()`,
  );
  s = replaceOnce(
    s,
    '          player.replaceWithPreloadedItem(cachedItem)',
    '          player.replaceWithPreloadedItem(cachedItem, source: source)',
  );
  s = replaceOnce(
    s,
    `      Function("pause") { player in
        player.ref.pause()
        if !player.keepAudioSessionActive {`,
    `      Function("pause") { player in
        player.pause()
        if !player.keepAudioSessionActive && !self.shouldPlayInBackground {`,
  );
  // Interruption/route pause must also suppress recovery while a source is still loading.
  s = s.replaceAll(
    '      if playable.isPlaying {',
    '      if playable.isPlaying || (playable as? AudioPlayer)?.puukWantsPlayback == true {',
  );
  s = s.replaceAll(
    '          playable.pause()',
    `          if let player = playable as? AudioPlayer {
            player.pauseForInterruption()
          } else {
            playable.pause()
          }`,
  );
  s = replaceOnce(
    s,
    '        playable.pause()\n      }\n    }\n  }\n\n  private func resumeAllPlayers()',
    `        if let player = playable as? AudioPlayer {
          player.pauseForInterruption()
        } else {
          playable.pause()
        }
      }
    }
  }

  private func resumeAllPlayers()`,
  );
  fs.writeFileSync(moduleFile, s);

  const mediaFile = path.join(iosDir, 'MediaController.swift');
  s = fs.readFileSync(mediaFile, 'utf8');
  for (const event of ['nextTrack', 'previousTrack']) {
    s = replaceOnce(
      s,
      `player.emit(event: "${event}")`,
      `player.emit(event: "${event}", payload: player.currentStatus())`,
    );
  }
  s = replaceOnce(
    s,
    `      playable.lockScreenPlayer.seek(to: seekTime)`,
    `      if let player = playable as? AudioPlayer {
        player.seekFromRemote(event.positionTime)
      } else {
        playable.lockScreenPlayer.seek(to: seekTime)
      }`,
  );
  const skipSeek = `      playable.lockScreenPlayer.seek(to: seekTime, toleranceBefore: .zero, toleranceAfter: .zero)`;
  if (s.split(skipSeek).length !== 3)
    throw new Error('Source drift: expected two skip seek targets');
  s = s.replaceAll(
    skipSeek,
    `      if let player = playable as? AudioPlayer {
        player.seekFromRemote(seekTime.seconds, exact: true)
      } else {
        playable.lockScreenPlayer.seek(to: seekTime, toleranceBefore: .zero, toleranceAfter: .zero)
      }`,
  );
  fs.writeFileSync(mediaFile, s);
}

// Corrections to the exact S1 output; all entry paths first reach that pinned source.
function patchNativeCorrections() {
  for (const name of Object.keys(acceptedInputs)) {
    const file = path.join(iosDir, name);
    if (digest(fs.readFileSync(file, 'utf8')) !== acceptedInputs[name][2]) {
      throw new Error(
        `Source drift: expected canonical pre-correction S1 output: ${name}`,
      );
    }
  }
  const playerFile = path.join(iosDir, 'AudioPlayer.swift');
  let s = fs.readFileSync(playerFile, 'utf8');
  s = replaceOnce(
    s,
    '  var wasPlaying = false',
    `  private var interruptionResumePending = false
  var wasPlaying: Bool {
    get {
      sourceLock.lock(); defer { sourceLock.unlock() }
      return interruptionResumePending
    }
    set {
      sourceLock.lock(); defer { sourceLock.unlock() }
      interruptionResumePending = newValue
    }
  }`,
  );
  s = replaceOnce(
    s,
    '    nativeIntent = "play"\n    intentRevision += 1',
    '    nativeIntent = "play"\n    interruptionResumePending = false\n    intentRevision += 1',
  );
  s = replaceOnce(
    s,
    `  func pause() {
    setPausedIntent("pause")
    wasPlaying = false
  }

  func pauseForInterruption() {
    setPausedIntent("interrupted")
  }`,
    `  func pause() {
    sourceLock.lock(); defer { sourceLock.unlock() }
    interruptionResumePending = false
    setPausedIntent("pause")
  }

  // Admission and resume eligibility share the intent lock: an explicit pause wins.
  @discardableResult
  func pauseForInterruption() -> Bool {
    sourceLock.lock(); defer { sourceLock.unlock() }
    guard !released, nativeIntent == "play" else { return false }
    interruptionResumePending = true
    setPausedIntent("interrupted")
    return true
  }

  func togglePlayback() {
    sourceLock.lock(); defer { sourceLock.unlock() }
    guard !released else { return }
    if nativeIntent == "play" {
      pause()
    } else {
      play(at: effectiveRate)
    }
  }`,
  );
  s = replaceOnce(
    s,
    `    guard nativeIntent == "interrupted" else { return }
    play(at: effectiveRate)`,
    `    guard nativeIntent == "interrupted", interruptionResumePending else { return }
    interruptionResumePending = false
    play(at: effectiveRate)`,
  );
  // Reset takes its eligibility from intent while holding the source lock, not module snapshots.
  s = replaceOnce(
    s,
    '    let shouldResume = wasPlaying',
    '    let shouldResume = nativeIntent == "play"',
  );
  s = replaceOnce(s, '      self.wasPlaying = false\n', '');
  s = replaceOnce(
    s,
    `  private func teardownPlayer() {
    readySubscription = nil`,
    `  private func teardownPlayer() {
    // Invalidate BEFORE cancellation: AVFoundation may complete an old seek synchronously.
    seekRevision += 1
    readySubscription = nil`,
  );
  s = replaceOnce(
    s,
    `  private func replacePlayerItem(with item: AVPlayerItem?) {
    readySubscription = nil`,
    `  private func replacePlayerItem(with item: AVPlayerItem?) {
    seekRevision += 1
    readySubscription = nil`,
  );
  s = replaceOnce(
    s,
    '    released = true\n    readySubscription = nil',
    '    released = true\n    seekRevision += 1\n    interruptionResumePending = false\n    readySubscription = nil',
  );
  s = replaceMethod(
    s,
    '  private func restorePlaybackState(',
    '  private func installTap()',
    `  private func restorePlaybackState(time: Double, shouldResume: Bool, rate: Float) {
    sourceLock.lock(); defer { sourceLock.unlock() }
    guard time.isFinite, let context = sourceContext() else { return }
    seekRevision += 1
    let intentToken = intentRevision
    let seekToken = seekRevision
    updateStatus(with: ["nativeEvent": "seekIntent", "seekTargetSeconds": time,
      "seekOrigin": "recovery"], context: context)
    let cmTime = CMTime(seconds: time, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
    context.player.seek(to: cmTime) { [weak self] finished in
      guard let self else { return }
      self.sourceLock.lock(); defer { self.sourceLock.unlock() }
      guard self.isCurrent(context), self.intentRevision == intentToken,
        self.seekRevision == seekToken else { return }
      self.updateStatus(with: ["currentTime": context.item.currentTime().seconds,
        "nativeEvent": "seek", "seekCompleted": finished, "seekOrigin": "recovery"], context: context)
      guard finished, shouldResume, self.puukWantsPlayback else { return }
      self.play(at: rate)
    }
  }`,
  );
  s = replaceOnce(
    s,
    '  func seekTo(seconds:',
    `  // Derive relative targets from the installed item while holding the command lock.
  @discardableResult
  func seekByFromRemote(_ deltaSeconds: Double) -> Bool {
    sourceLock.lock(); defer { sourceLock.unlock() }
    guard deltaSeconds.isFinite, let context = sourceContext() else { return false }
    let position = context.item.currentTime().seconds
    guard position.isFinite else { return false }
    var target = max(0, position + deltaSeconds)
    let duration = context.item.duration.seconds
    if duration.isFinite && duration >= 0 { target = min(target, duration) }
    guard target.isFinite else { return false }
    performSeek(seconds: target, toleranceMillisBefore: 0,
      toleranceMillisAfter: 0, origin: "user", completion: {})
    return true
  }

  func seekTo(seconds:`,
  );
  fs.writeFileSync(playerFile, s);

  const moduleFile = path.join(iosDir, 'AudioModule.swift');
  s = fs.readFileSync(moduleFile, 'utf8');
  s = replaceOnce(
    s,
    `    registry.allPlayables.forEach { playable in
      if playable.isPlaying || (playable as? AudioPlayer)?.puukWantsPlayback == true {
        interruptedPlayers.insert(playable.id)
        switch interruptionMode {
        case .duckOthers:
          playerVolumes[playable.id] = playable.volume
          playable.volume *= 0.5
        case .doNotMix, .doNotMixPersistent, .mixWithOthers:
          if let player = playable as? AudioPlayer {
            player.pauseForInterruption()
          } else {
            playable.pause()
          }
        }
      }
    }`,
    `    registry.allPlayables.forEach { playable in
      switch interruptionMode {
      case .duckOthers:
        // Ducking does not revoke play intent or grant a later automatic resume.
        if playable.isPlaying {
          interruptedPlayers.insert(playable.id)
          playerVolumes[playable.id] = playable.volume
          playable.volume *= 0.5
        }
      case .doNotMix, .doNotMixPersistent, .mixWithOthers:
        if let player = playable as? AudioPlayer {
          if player.pauseForInterruption() {
            interruptedPlayers.insert(player.id)
          }
        } else if playable.isPlaying {
          interruptedPlayers.insert(playable.id)
          playable.pause()
        }
      }
    }`,
  );
  s = replaceOnce(
    s,
    `    registry.allPlayers.values.forEach { player in
      if player.isPlaying {
        player.wasPlaying = true
      }
      player.handleMediaServicesReset()
    }`,
    `    registry.allPlayers.values.forEach { player in
      player.handleMediaServicesReset()
    }`,
  );
  s = replaceOnce(
    s,
    `  private func pauseAllPlayers() {
    registry.allPlayables.forEach { playable in
      if playable.isPlaying || (playable as? AudioPlayer)?.puukWantsPlayback == true {
        playable.wasPlaying = true
        if let player = playable as? AudioPlayer {
          player.pauseForInterruption()
        } else {
          playable.pause()
        }
      }
    }
  }`,
    `  private func pauseAllPlayers() {
    registry.allPlayables.forEach { playable in
      if let player = playable as? AudioPlayer {
        // The player atomically owns admission and resume bookkeeping, including startup.
        _ = player.pauseForInterruption()
      } else if playable.isPlaying {
        playable.wasPlaying = true
        playable.pause()
      }
    }
  }`,
  );
  s = replaceOnce(
    s,
    `  private func resumeAllPlayers() {
    registry.allPlayables.forEach { playable in
      if playable.wasPlaying {
        playable.resumePlayback()
        playable.wasPlaying = false
      }
    }
  }`,
    `  private func resumeAllPlayers() {
    registry.allPlayables.forEach { playable in
      if let player = playable as? AudioPlayer {
        player.resumePlayback()
      } else if playable.wasPlaying {
        playable.resumePlayback()
        playable.wasPlaying = false
      }
    }
  }`,
  );
  fs.writeFileSync(moduleFile, s);

  const mediaFile = path.join(iosDir, 'MediaController.swift');
  s = fs.readFileSync(mediaFile, 'utf8');
  s = replaceOnce(
    s,
    `      if playable.isPlaying {
        playable.pause()
      } else {
        playable.play(at: Float(playable.currentRate > 0 ? playable.currentRate : 1.0))
      }`,
    `      if let player = playable as? AudioPlayer {
        player.togglePlayback()
      } else if playable.isPlaying {
        playable.pause()
      } else {
        playable.play(at: Float(playable.currentRate > 0 ? playable.currentRate : 1.0))
      }`,
  );
  for (const sign of ['+', '-']) {
    s = replaceOnce(
      s,
      `      let currentTime = playable.lockScreenPlayer.currentTime()
      let seekTime = currentTime ${sign} MediaController.cmTime(seconds: event.interval)
      if let player = playable as? AudioPlayer {
        player.seekFromRemote(seekTime.seconds, exact: true)
      } else {
        playable.lockScreenPlayer.seek(to: seekTime, toleranceBefore: .zero, toleranceAfter: .zero)
      }`,
      `      if let player = playable as? AudioPlayer {
        player.seekByFromRemote(${sign === '+' ? '' : '-'}event.interval)
      } else {
        let currentTime = playable.lockScreenPlayer.currentTime()
        let seekTime = currentTime ${sign} MediaController.cmTime(seconds: event.interval)
        playable.lockScreenPlayer.seek(to: seekTime, toleranceBefore: .zero, toleranceAfter: .zero)
      }`,
    );
  }
  fs.writeFileSync(mediaFile, s);
}

// R1 is applied only after the complete first corrective output has been verified.
function patchResumeCauses() {
  for (const name of Object.keys(acceptedInputs)) {
    if (
      digest(fs.readFileSync(path.join(iosDir, name), 'utf8')) !==
      acceptedInputs[name][3]
    ) {
      throw new Error(
        `Source drift: expected first S1N corrective output: ${name}`,
      );
    }
  }
  const playerFile = path.join(iosDir, 'AudioPlayer.swift');
  let s = fs.readFileSync(playerFile, 'utf8');
  s = replaceOnce(
    s,
    `  private var interruptionResumePending = false
  var wasPlaying: Bool {
    get {
      sourceLock.lock(); defer { sourceLock.unlock() }
      return interruptionResumePending
    }
    set {
      sourceLock.lock(); defer { sourceLock.unlock() }
      interruptionResumePending = newValue
    }
  }`,
    `  private enum AutomaticPauseCause: Hashable { case lifecycle, system }
  private var activeAutomaticPauses = Set<AutomaticPauseCause>()
  private var eligibleAutomaticResumes = Set<AutomaticPauseCause>()
  private var automaticResumeBlocked = false
  private var systemInterruptionEpoch = 0

  // Playable compatibility: this property never grants system-interruption permission.
  var wasPlaying: Bool {
    get {
      sourceLock.lock(); defer { sourceLock.unlock() }
      return eligibleAutomaticResumes.contains(.lifecycle)
    }
    set {
      sourceLock.lock(); defer { sourceLock.unlock() }
      if newValue && activeAutomaticPauses.contains(.lifecycle) && !automaticResumeBlocked {
        eligibleAutomaticResumes.insert(.lifecycle)
      } else {
        eligibleAutomaticResumes.remove(.lifecycle)
      }
    }
  }

  var systemInterruptionToken: Int {
    sourceLock.lock(); defer { sourceLock.unlock() }
    return systemInterruptionEpoch
  }`,
  );
  s = replaceOnce(
    s,
    `    nativeIntent = "play"
    interruptionResumePending = false`,
    `    nativeIntent = "play"
    // Explicit play replaces old eligibility, but cannot pretend an active interruption ended.
    eligibleAutomaticResumes.removeAll()
    automaticResumeBlocked = false`,
  );
  s = replaceOnce(
    s,
    `    interruptionResumePending = false
    setPausedIntent("pause")`,
    `    eligibleAutomaticResumes.removeAll()
    automaticResumeBlocked = true
    setPausedIntent("pause")`,
  );
  s = replaceMethod(
    s,
    '  // Admission and resume eligibility share the intent lock:',
    '  func togglePlayback()',
    `  // Each cause owns its admission; an overlapping cause cannot revive explicit pause.
  private func admitAutomaticPause(_ cause: AutomaticPauseCause, shouldPause: Bool) -> Bool {
    sourceLock.lock(); defer { sourceLock.unlock() }
    guard !released else { return false }
    if cause == .system { systemInterruptionEpoch += 1 }
    // Record active system/lifecycle blockers even if this source was already paused.
    activeAutomaticPauses.insert(cause)
    let eligible = !automaticResumeBlocked && (nativeIntent == "play" ||
      (nativeIntent == "interrupted" && !eligibleAutomaticResumes.isEmpty))
    if eligible { eligibleAutomaticResumes.insert(cause) }
    if shouldPause && nativeIntent == "play" { setPausedIntent("interrupted") }
    return eligible
  }

  @discardableResult
  func pauseForInterruption() -> Bool {
    admitAutomaticPause(.system, shouldPause: true)
  }

  func beginDuckingInterruption() {
    _ = admitAutomaticPause(.system, shouldPause: false)
  }

  func pauseForLifecycle() {
    _ = admitAutomaticPause(.lifecycle, shouldPause: true)
  }

  func pauseForRouteChange() {
    // Route loss grants no foreground/system resume permission: wait for explicit play.
    pause()
  }

  func finishSystemInterruption(token: Int, shouldResume: Bool) {
    sourceLock.lock(); defer { sourceLock.unlock() }
    guard !released, token == systemInterruptionEpoch,
      activeAutomaticPauses.contains(.system) else { return }
    activeAutomaticPauses.remove(.system)
    if !shouldResume {
      // A no-resume decision vetoes overlapping lifecycle permission as well.
      eligibleAutomaticResumes.removeAll()
      automaticResumeBlocked = true
      return
    }
    resumeIfPermitted(for: .system)
  }

  private func resumeIfPermitted(for cause: AutomaticPauseCause) {
    sourceLock.lock(); defer { sourceLock.unlock() }
    guard !released, !automaticResumeBlocked, eligibleAutomaticResumes.contains(cause),
      activeAutomaticPauses.isEmpty else { return }
    eligibleAutomaticResumes.removeAll()
    guard nativeIntent == "interrupted" else { return }
    play(at: effectiveRate)
  }`,
  );
  s = replaceOnce(
    s,
    `  func resumePlayback() {
    sourceLock.lock(); defer { sourceLock.unlock() }
    guard nativeIntent == "interrupted", interruptionResumePending else { return }
    interruptionResumePending = false
    play(at: effectiveRate)
  }`,
    `  func resumePlayback() {
    sourceLock.lock(); defer { sourceLock.unlock() }
    // Foreground can consume only its own admitted lifecycle pause.
    guard activeAutomaticPauses.remove(.lifecycle) != nil else { return }
    resumeIfPermitted(for: .lifecycle)
  }`,
  );
  s = replaceOnce(
    s,
    `    seekRevision += 1
    interruptionResumePending = false`,
    `    seekRevision += 1
    eligibleAutomaticResumes.removeAll()
    activeAutomaticPauses.removeAll()
    automaticResumeBlocked = true`,
  );
  fs.writeFileSync(playerFile, s);

  const moduleFile = path.join(iosDir, 'AudioModule.swift');
  s = fs.readFileSync(moduleFile, 'utf8');
  s = replaceOnce(
    s,
    `      case .duckOthers:
        // Ducking does not revoke play intent or grant a later automatic resume.`,
    `      case .duckOthers:
        (playable as? AudioPlayer)?.beginDuckingInterruption()
        // Ducking does not revoke play intent or grant a later automatic resume.`,
  );
  s = replaceMethod(
    s,
    '  private func handleInterruptionEnded(with options:',
    '  @objc private func handleAudioSessionRouteChange(',
    `  private func handleInterruptionEnded(with options: AVAudioSession.InterruptionOptions) {
    let shouldResume = options.contains(.shouldResume)
    // Capture the interruption before queueing session work. A newer begin invalidates it.
    let audioPlayers = registry.allPlayers.values.map { ($0, $0.systemInterruptionToken) }
    if !shouldResume {
      audioPlayers.forEach { player, token in
        player.finishSystemInterruption(token: token, shouldResume: false)
      }
    }
    sessionQueue.async { [weak self] in
      guard let self else { return }
      let canResume = self.audioEnabled.withLock({ $0 }) && self.applySessionActive(true)
      if shouldResume {
        audioPlayers.forEach { player, token in
          player.finishSystemInterruption(token: token, shouldResume: canResume)
        }
      }
      if canResume && shouldResume {
        self.resumeInterruptedPlayers()
      }
    }
  }`,
  );
  s = replaceOnce(
    s,
    `    case .oldDeviceUnavailable:
      pauseAllPlayers()`,
    `    case .oldDeviceUnavailable:
      registry.allPlayables.forEach { playable in
        if let player = playable as? AudioPlayer {
          player.pauseForRouteChange()
        } else if playable.isPlaying {
          playable.wasPlaying = true
          playable.pause()
        }
      }`,
  );
  // AudioPlayer system resume is already handled by its captured system token, never by
  // Playable.resumePlayback(), whose AudioPlayer meaning is lifecycle-only.
  s = replaceOnce(
    s,
    `        case .doNotMix, .doNotMixPersistent, .mixWithOthers:
          playable.resumePlayback()`,
    `        case .doNotMix, .doNotMixPersistent, .mixWithOthers:
          if !(playable is AudioPlayer) { playable.resumePlayback() }`,
  );
  s = replaceOnce(
    s,
    `        // The player atomically owns admission and resume bookkeeping, including startup.
        _ = player.pauseForInterruption()`,
    `        player.pauseForLifecycle()`,
  );
  s = replaceOnce(
    s,
    `    if !isActive {
      pauseAllPlayers()
    }`,
    `    if !isActive {
      // Explicit audio disable revokes automatic eligibility, not a lifecycle admission.
      registry.allPlayables.forEach { $0.pause() }
    }`,
  );
  fs.writeFileSync(moduleFile, s);
}

// R2: module collection/volume ownership must match the queued system end.
function patchModuleInterruptionOwnership() {
  for (const name of Object.keys(acceptedInputs)) {
    if (
      digest(fs.readFileSync(path.join(iosDir, name), 'utf8')) !==
      acceptedInputs[name][4]
    ) {
      throw new Error(`Source drift: R2 requires exact R1 output for ${name}`);
    }
  }
  const file = path.join(iosDir, 'AudioModule.swift');
  let s = fs.readFileSync(file, 'utf8');
  s = replaceOnce(
    s,
    '  private var interruptedPlayers = Set<String>()',
    `  // Serializes interruption bookkeeping and explicit stops, including remote generic playables.
  private static let interruptionStateLock = NSRecursiveLock()
  private static let explicitPauseNotification = Notification.Name("PuukAudioExplicitPause")
  private var interruptionGeneration = 0
  private var interruptionPending = false
  private var interruptedPlayers = Set<String>()`,
  );
  s = replaceOnce(
    s,
    '      setupInterruptionHandling()',
    `      NotificationCenter.default.addObserver(
        self,
        selector: #selector(handleExplicitPause(_:)),
        name: Self.explicitPauseNotification,
        object: nil
      )
      setupInterruptionHandling()`,
  );
  s = replaceOnce(
    s,
    `      Function("pause") { player in
        player.pause()`,
    `      Function("pause") { player in
        Self.pauseExplicitly(player)`,
  );
  s = replaceOnce(
    s,
    `      Function("pause") { playlist in
        playlist.pause()`,
    `      Function("pause") { playlist in
        Self.pauseExplicitly(playlist)`,
  );
  s = replaceMethod(
    s,
    '  private func handleInterruptionBegan()',
    '  private func handleInterruptionEnded(',
    `  // Notification delivery is synchronous; revoke generic resume membership and stop
  // under the same lock as interruption completion. AudioPlayer owns its intent fence.
  static func pauseExplicitly(_ playable: Playable) {
    interruptionStateLock.lock()
    defer { interruptionStateLock.unlock() }
    NotificationCenter.default.post(name: explicitPauseNotification, object: playable)
    playable.pause()
  }

  @objc private func handleExplicitPause(_ notification: Notification) {
    guard let playable = notification.object as? Playable else { return }
    Self.interruptionStateLock.lock()
    defer { Self.interruptionStateLock.unlock() }
    interruptedPlayers.remove(playable.id)
    if !(playable is AudioPlayer) { playable.wasPlaying = false }
  }

  private func handleInterruptionBegan() {
    Self.interruptionStateLock.lock()
    defer { Self.interruptionStateLock.unlock() }
    interruptionGeneration += 1
    interruptionPending = true
    // A newer begin inherits outstanding actions, including the first unducked baseline.
    registry.allPlayables.forEach { playable in
      switch interruptionMode {
      case .duckOthers:
        (playable as? AudioPlayer)?.beginDuckingInterruption()
        // Ducking records volume only; it never grants a later playback resume.
        if playable.isPlaying {
          if playerVolumes[playable.id] == nil {
            playerVolumes[playable.id] = playable.volume
            playable.volume *= 0.5
          }
        }
      case .doNotMix, .doNotMixPersistent, .mixWithOthers:
        if let player = playable as? AudioPlayer {
          if player.pauseForInterruption() {
            interruptedPlayers.insert(player.id)
          }
        } else if playable.isPlaying {
          interruptedPlayers.insert(playable.id)
          playable.pause()
        }
      }
    }

#if os(iOS)
    registry.allRecorders.values.forEach { recorder in
      recorder.pauseForSystem()
    }
#endif

    recordSessionActive(false)
  }

`,
  );
  s = replaceMethod(
    s,
    '  private func handleInterruptionEnded(',
    '  @objc private func handleAudioSessionRouteChange(',
    `  private func handleInterruptionEnded(with options: AVAudioSession.InterruptionOptions) {
    Self.interruptionStateLock.lock()
    defer { Self.interruptionStateLock.unlock() }
    guard interruptionPending else { return }
    let generation = interruptionGeneration
    let shouldResume = options.contains(.shouldResume)
    let audioPlayers = registry.allPlayers.values.map { ($0, $0.systemInterruptionToken) }
    if !shouldResume {
      audioPlayers.forEach { player, token in
        player.finishSystemInterruption(token: token, shouldResume: false)
      }
      resumeInterruptedPlayers(generation: generation, shouldResume: false)
      return
    }
    sessionQueue.async { [weak self] in
      guard let self else { return }
      Self.interruptionStateLock.lock()
      let ownsInterruption = self.interruptionPending && self.interruptionGeneration == generation
      Self.interruptionStateLock.unlock()
      guard ownsInterruption else { return }
      // Session activation is outside the bookkeeping lock; revalidate after it returns.
      let canResume = self.audioEnabled.withLock({ $0 }) && self.applySessionActive(true)
      Self.interruptionStateLock.lock()
      defer { Self.interruptionStateLock.unlock() }
      guard self.interruptionPending, self.interruptionGeneration == generation else { return }
      audioPlayers.forEach { player, token in
        player.finishSystemInterruption(token: token, shouldResume: canResume)
      }
      self.resumeInterruptedPlayers(generation: generation, shouldResume: canResume)
    }
  }

`,
  );
  s = replaceOnce(
    s,
    `    case .oldDeviceUnavailable:
      registry.allPlayables.forEach { playable in
        if let player = playable as? AudioPlayer {
          player.pauseForRouteChange()
        } else if playable.isPlaying {
          playable.wasPlaying = true
          playable.pause()
        }
      }`,
    `    case .oldDeviceUnavailable:
      Self.interruptionStateLock.lock()
      defer { Self.interruptionStateLock.unlock() }
      registry.allPlayables.forEach { playable in
        interruptedPlayers.remove(playable.id)
        if let player = playable as? AudioPlayer {
          player.pauseForRouteChange()
        } else {
          Self.pauseExplicitly(playable)
        }
      }`,
  );
  s = replaceMethod(
    s,
    '  private func resumeInterruptedPlayers()',
    '  private func pauseAllPlayers()',
    `  private func resumeInterruptedPlayers(generation: Int, shouldResume: Bool) {
    Self.interruptionStateLock.lock()
    defer { Self.interruptionStateLock.unlock() }
    guard interruptionPending, interruptionGeneration == generation else { return }
    registry.allPlayables.forEach { playable in
      // Restore the action recorded at begin, not the possibly changed audio mode.
      if let originalVolume = playerVolumes[playable.id] {
        playable.volume = originalVolume
      }
      if shouldResume, interruptedPlayers.contains(playable.id), !(playable is AudioPlayer) {
        playable.resumePlayback()
      }
    }

#if os(iOS)
    if shouldResume {
      registry.allRecorders.values.forEach { recorder in
        try? recorder.resumeAfterSystemPause()
      }
    }
#endif

    interruptedPlayers.removeAll()
    playerVolumes.removeAll()
    interruptionPending = false
  }

`,
  );
  s = replaceOnce(
    s,
    '      registry.allPlayables.forEach { $0.pause() }',
    '      registry.allPlayables.forEach { Self.pauseExplicitly($0) }',
  );
  s = replaceOnce(
    s,
    '    self.interruptionMode = mode.interruptionMode',
    `    Self.interruptionStateLock.lock()
    self.interruptionMode = mode.interruptionMode
    Self.interruptionStateLock.unlock()`,
  );
  fs.writeFileSync(file, s);
  const media = path.join(iosDir, 'MediaController.swift');
  s = fs.readFileSync(media, 'utf8');
  s = replaceOnce(
    s,
    `      playable.pause()
      return .success`,
    `      AudioModule.pauseExplicitly(playable)
      return .success`,
  );
  s = replaceOnce(
    s,
    `      } else if playable.isPlaying {
        playable.pause()`,
    `      } else if playable.isPlaying {
        AudioModule.pauseExplicitly(playable)`,
  );
  fs.writeFileSync(media, s);
}

// R2's lock-screen existential is not nominally a Playable. Keep the locked
// module pause for conformers and the original pause for other lock-screen types.
function patchRemotePauseTypes() {
  for (const name of Object.keys(acceptedInputs)) {
    if (
      digest(fs.readFileSync(path.join(iosDir, name), 'utf8')) !==
      acceptedInputs[name][5]
    )
      throw new Error(`Incomplete R2 input: ${name}`);
  }
  const file = path.join(iosDir, 'MediaController.swift');
  let s = fs.readFileSync(file, 'utf8');
  s = replaceOnce(
    s,
    `      AudioModule.pauseExplicitly(playable)
      return .success`,
    `      if let modulePlayable = playable as? Playable {
        AudioModule.pauseExplicitly(modulePlayable)
      } else {
        playable.pause()
      }
      return .success`,
  );
  s = replaceOnce(
    s,
    `      } else if playable.isPlaying {
        AudioModule.pauseExplicitly(playable)`,
    `      } else if playable.isPlaying {
        if let modulePlayable = playable as? Playable {
          AudioModule.pauseExplicitly(modulePlayable)
        } else {
          playable.pause()
        }`,
  );
  fs.writeFileSync(file, s);
}

const acceptedInputs = {
  'AudioPlayer.swift': [
    '05f1431a451513e62cb14400e60d9d3e2b56271584169f7f1603226236be78cd',
    'a36e2f1a316813a08e7d3654c3aa7a0528ecb0a071c9529f6afa37a0ae57dba2',
    '7618a05d110f31624073f91e2be9c40ad60229cfb8a22f40a8fd425b9346bd04',
    'b42d76b1585f790c8fb15a6ca9a62ba41203a1a39f753cfa4f9cf904d69c7cd7',
    '016ee2ea3246f0e53ce7437d902ca994f35f8c918b3867a3110af888d2bcd746',
    '016ee2ea3246f0e53ce7437d902ca994f35f8c918b3867a3110af888d2bcd746',
    '016ee2ea3246f0e53ce7437d902ca994f35f8c918b3867a3110af888d2bcd746',
  ],
  'AudioModule.swift': [
    '404d68b7be202ba8145667af50fd5ef0df3df4e802e660e30c6aad0e7acbbd59',
    'ae5c533a428b9f825f2fc9e7de6d60fe6ff21951fc116431cdb85edd43a04ca5',
    '27a51ef0c2d6d52938f6f078b12aa38f32cc68d8b9d3ac6303373ea28267707b',
    '25e1dbae1b86d5b86755c1d1bc8fc4598a5146fa7416c5a7875258c8af896efd',
    '07c2e437e9d99c44cc7b5c0500fb51d91d1e95283bbb93359890241037370b33',
    '81577fb10c88206da394daa548379c64b6bce4dc833287352b5bb8fd74f8e43e',
    '81577fb10c88206da394daa548379c64b6bce4dc833287352b5bb8fd74f8e43e',
  ],
  'MediaController.swift': [
    '8e0b972ef7548b174ec5b1daff1dfb69f201095e61567111dc48298182e5d0ab',
    'a01ec1da20d578ef5055d6ecb0d6f847239449a5773da82e859edef2b79469fb',
    'fe5b7b908f98632f6deb3efc71712ac9ee4489bde0ecb90fcdc1b9be33acf830',
    'd59f4d3d13fd8546cd21dfd103718b3c573cf04554c8c59dcac029e6fd029e86',
    'd59f4d3d13fd8546cd21dfd103718b3c573cf04554c8c59dcac029e6fd029e86',
    '2e90e151ddbbc9d696e7fade169d37c5ba5c12d9e7d0b9f7893302c619dcc3cd',
    'e270b82a708b56be4084ffd8dfa4e17dd16c3017f494aaccec793b3b254575b6',
  ],
  'AudioComponentRegistry.swift': [
    '45af89001f159d392b991cfd2111050e31ea3c9a23f94600e142f9974732621f',
    '8240462a8aa0b1d5db765e6346557de2cf0e984fc3298567cc159ab7f229a5a0',
    '8240462a8aa0b1d5db765e6346557de2cf0e984fc3298567cc159ab7f229a5a0',
    '8240462a8aa0b1d5db765e6346557de2cf0e984fc3298567cc159ab7f229a5a0',
    '8240462a8aa0b1d5db765e6346557de2cf0e984fc3298567cc159ab7f229a5a0',
    '8240462a8aa0b1d5db765e6346557de2cf0e984fc3298567cc159ab7f229a5a0',
    '8240462a8aa0b1d5db765e6346557de2cf0e984fc3298567cc159ab7f229a5a0',
  ],
  'AudioUtils.swift': [
    'b78865fa35bcc5b3d91279a1d1399f832b283fd5b0c326128f0ce66933b8c537',
    '7488c7cc261b9eed2e797f193fd5ed63f4676b74f397503322462a8f45c66d01',
    '7488c7cc261b9eed2e797f193fd5ed63f4676b74f397503322462a8f45c66d01',
    '7488c7cc261b9eed2e797f193fd5ed63f4676b74f397503322462a8f45c66d01',
    '7488c7cc261b9eed2e797f193fd5ed63f4676b74f397503322462a8f45c66d01',
    '7488c7cc261b9eed2e797f193fd5ed63f4676b74f397503322462a8f45c66d01',
    '7488c7cc261b9eed2e797f193fd5ed63f4676b74f397503322462a8f45c66d01',
  ],
};

function run() {
  const before = new Map();
  for (const [name, allowed] of Object.entries(acceptedInputs)) {
    const file = path.join(iosDir, name);
    if (!nodeFs.existsSync(file))
      throw new Error(`Missing SDK source: ${file}`);
    const content = nodeFs.readFileSync(file, 'utf8');
    const hash = digest(content);
    if (!allowed.includes(hash))
      throw new Error(
        `Source drift: ${name} sha256=${hash}; expected pristine SDK 58.0.10, supported legacy patch, or exact pre-correction/corrected Puuk identity v1`,
      );
    before.set(file, content);
  }
  // A fully patched tree is recognized by complete hashes, never one marker.
  if (
    [...before].every(
      ([file, content]) =>
        acceptedInputs[path.basename(file)].at(-1) === digest(content),
    ) &&
    fs
      .readFileSync(path.join(iosDir, 'AudioPlayer.swift'), 'utf8')
      .includes('private struct SourceContext')
  ) {
    console.log(
      '[patch-expo-audio] Puuk source identity v1 with S1N/R1/R2 and remote pause type corrections already patched (verified hashes).',
    );
    return;
  }
  const supportedGeneration = Array.from(
    { length: 7 },
    (_, index) => index,
  ).some((index) =>
    [...before].every(
      ([file, content]) =>
        digest(content) === acceptedInputs[path.basename(file)][index],
    ),
  );
  if (!supportedGeneration)
    throw new Error('Unsupported mixed SDK source generations');
  const isR2 = [...before].every(
    ([file, content]) =>
      digest(content) === acceptedInputs[path.basename(file)][5],
  );
  if (!isR2) {
    const isR1 = [...before].every(
      ([file, content]) =>
        digest(content) === acceptedInputs[path.basename(file)][4],
    );
    if (!isR1) {
      const isFirstCorrection = [...before].every(
        ([file, content]) =>
          digest(content) === acceptedInputs[path.basename(file)][3],
      );
      if (!isFirstCorrection) {
        const isPreCorrectionS1 = [...before].every(
          ([file, content]) =>
            digest(content) === acceptedInputs[path.basename(file)][2],
        );
        if (!isPreCorrectionS1) {
          patchMediaController();
          patchAudioPlayer();
          patchAudioModule();
          patchAudioComponentRegistry();
          patchAudioUtils();
          patchSourceIdentity();
        }
        patchNativeCorrections();
      }
      patchResumeCauses();
    }
    patchModuleInterruptionOwnership();
  }
  patchRemotePauseTypes();
  // Verify complete outputs too: a missing legacy transform must not produce partial success.
  for (const name of Object.keys(acceptedInputs)) {
    const file = path.join(iosDir, name);
    if (digest(fs.readFileSync(file, 'utf8')) !== acceptedInputs[name].at(-1)) {
      throw new Error(`Incomplete patch output: ${name}`);
    }
  }
  // Fail before the first disk write on unsupported or partially modified inputs.
  for (const [file, original] of before) {
    if (nodeFs.readFileSync(file, 'utf8') !== original)
      throw new Error(`Concurrent modification: ${file}`);
  }
  for (const [file, content] of staged)
    nodeFs.writeFileSync(file, content, 'utf8');
  console.log(
    '[patch-expo-audio] Applied Puuk source identity v1 with S1N/R1/R2 and remote pause type corrections; rebuild the iOS binary.',
  );
}

try {
  run();
} catch (error) {
  console.error(`[patch-expo-audio] ERROR: ${error.message}`);
  process.exitCode = 1;
}
