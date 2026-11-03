const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');

const app = path.resolve(__dirname, '../..');
const script = path.join(app, 'scripts/patch-expo-audio.js');
const fixtures = path.join(__dirname, 'fixtures/expo-audio-58.0.10');
const names = [
  'AudioPlayer.swift',
  'AudioModule.swift',
  'MediaController.swift',
  'AudioComponentRegistry.swift',
  'AudioUtils.swift',
];
const hash = (text) => createHash('sha256').update(text).digest('hex');
const roots = [];

function pristine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puuk-audio-patch-'));
  roots.push(root);
  const ios = path.join(root, 'node_modules/expo-audio/ios');
  fs.mkdirSync(ios, { recursive: true });
  for (const name of names)
    fs.copyFileSync(path.join(fixtures, name), path.join(ios, name));
  return { root, ios };
}
function run(ios, patch = script) {
  const result = spawnSync(process.execPath, [patch], {
    encoding: 'utf8',
    env: { ...process.env, PUUK_EXPO_AUDIO_IOS_DIR: ios },
  });
  if (result.error) throw result.error;
  return result;
}
function contents(ios) {
  return Object.fromEntries(
    names
      .filter((name) => fs.existsSync(path.join(ios, name)))
      .map((name) => [name, fs.readFileSync(path.join(ios, name), 'utf8')]),
  );
}
function success(result) {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
}
function method(source, from, to) {
  return source.slice(
    source.indexOf(from),
    source.indexOf(to, source.indexOf(from) + from.length),
  );
}
let expected;
beforeAll(() => {
  const { ios } = pristine();
  success(run(ios));
  expected = contents(ios);
});
afterAll(() =>
  roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);

describe('SDK 58.0.10 source transformation (host only, no native runtime)', () => {
  test('patches the pristine SDK and verifies every complete output on repeat', () => {
    const { ios } = pristine();
    success(run(ios));
    expect(contents(ios)).toEqual(expected);
    const again = run(ios);
    success(again);
    expect(again.stdout).toContain('verified hashes');
    expect(contents(ios)).toEqual(expected);
  });

  test('migrates the previous installed Puuk patch to the identical output', () => {
    const { root, ios } = pristine();
    const scripts = path.join(root, 'scripts');
    fs.mkdirSync(scripts);
    const legacy = path.join(scripts, 'patch-expo-audio.cjs');
    fs.copyFileSync(path.join(fixtures, 'legacy-patch.cjs'), legacy);
    expect(hash(fs.readFileSync(legacy))).toBe(
      '1603cc8a30d954f0a1ade5b07d38eb0d6b0f37b796f6cf24a7a9de448daaf05f',
    );
    success(run(ios, legacy));
    expect(contents(ios)['AudioPlayer.swift']).toContain(
      'beginBackgroundTaskIfNeeded',
    );
    expect(contents(ios)['AudioPlayer.swift']).not.toContain('SourceContext');
    success(run(ios));
    expect(contents(ios)).toEqual(expected);
    success(run(ios));
    expect(contents(ios)).toEqual(expected);
  });

  test.each(names)(
    'rejects source drift in %s before writing any file',
    (name) => {
      const { ios } = pristine();
      fs.appendFileSync(path.join(ios, name), '\n// upstream change\n');
      const before = contents(ios);
      const result = run(ios);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Source drift: ${name} sha256=`);
      expect(contents(ios)).toEqual(before);
    },
  );

  test('does not mistake a patched marker for an intact patched implementation', () => {
    const { ios } = pristine();
    success(run(ios));
    const target = path.join(ios, 'AudioPlayer.swift');
    fs.writeFileSync(
      target,
      fs
        .readFileSync(target, 'utf8')
        .replace('self.isCurrent(context)', 'true'),
    );
    const before = contents(ios);
    expect(run(ios).status).toBe(1);
    expect(contents(ios)).toEqual(before);
  });

  test('fails clearly on a missing SDK source and preserves all remaining files', () => {
    const { ios } = pristine();
    fs.unlinkSync(path.join(ios, 'AudioUtils.swift'));
    const before = contents(ios);
    const result = run(ios);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing SDK source');
    expect(contents(ios)).toEqual(before);
  });

  test('a failed internal transform cannot leave earlier staged patches on disk', () => {
    const { root, ios } = pristine();
    const broken = path.join(root, 'broken-patch.cjs');
    fs.writeFileSync(
      broken,
      fs
        .readFileSync(script, 'utf8')
        .replace(
          /s,\s*'  private var source: AudioSource\?'/,
          "s, '  SOURCE DRIFT SENTINEL'",
        ),
    );
    const before = contents(ios);
    const result = run(ios, broken);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Source drift: expected one occurrence');
    expect(contents(ios)).toEqual(before);
  });
});

describe('native boundary source guards (static assertions, not AVFoundation tests)', () => {
  test('atomic installation accepts caller identity and rejects obsolete intent/source', () => {
    const source = expected['AudioPlayer.swift'];
    const install = method(
      source,
      '  func replaceWithAttempt(',
      '  func playForAttempt(',
    );
    expect(install).toContain('sourceAttemptId == expectedAttemptId');
    expect(install).toContain(
      'intentRevision == expectedIntentRevision, puukWantsPlayback',
    );
    expect(install).toContain('sourceAttemptId = attemptId');
    expect(install).toContain('resumeWhenReady: false');
    expect(install).not.toContain('preloaded');
    expect(expected['AudioModule.swift']).toContain(
      'Property("puukSourceIdentityVersion")',
    );
    expect(expected['AudioModule.swift']).toContain(
      'Function("replaceWithAttempt")',
    );
    expect(expected['AudioModule.swift']).toContain(
      'Function("playForAttempt")',
    );
    expect(expected['AudioModule.swift']).toContain(
      'Function("seekForAttempt")',
    );
  });

  test('source guards check both concrete player and item, not player ID/status equality', () => {
    const source = expected['AudioPlayer.swift'];
    const guard = method(
      source,
      '  private func isCurrent(',
      '  // No native-preload',
    );
    expect(guard).toContain(
      'ref === context.player && ref.currentItem === context.item',
    );
    expect(guard).toContain('sourceAttemptId == context.attemptId');
    const setup = method(
      source,
      '  private func setupPublisher()',
      '  func replaceWithPreloadedItem(',
    );
    expect(setup).not.toContain('publisher(for: \\.currentItem?.status)');
    expect(setup).toContain('item.publisher(for: \\.status)');
    expect(setup.indexOf('observedPlayer.currentItem === item')).toBeLessThan(
      setup.indexOf('self.itemStatusSubscription = nil'),
    );
    expect(setup).toContain('context.item.error?.localizedDescription');
  });

  test('progress, error, finish, and seek preserve captured callback origin for A/B/A', () => {
    const source = expected['AudioPlayer.swift'];
    const tick = method(
      source,
      '  private func registerTimeObserver()',
      '  var volume:',
    );
    expect(tick).toContain('context.player.addPeriodicTimeObserver');
    expect(tick).toContain('self.isCurrent(context)');
    expect(tick).toContain('context: context, updateNowPlaying: false');
    const finish = method(
      source,
      '  private func addPlaybackEndNotification()',
      '  private func registerTimeObserver()',
    );
    expect(finish).toContain('object: context.item');
    expect(finish).toContain(
      'finishedItem === context.item, self.isCurrent(context)',
    );
    expect(finish).toContain('], context: context)');
    const seek = method(
      source,
      '  func seekTo(',
      '  private func applyPreferredForwardBufferDuration()',
    );
    expect(seek).toContain('let context = sourceContext()');
    expect(seek).toContain(
      'if self.isCurrent(context), self.seekRevision == seekToken',
    );
    expect(seek).toContain('"nativeEvent": "seek"');
    expect(seek).toContain('"seekCompleted": finished');
    expect(seek).toContain('"seekOrigin": origin');
    const completion = seek.slice(seek.indexOf('context.player.seek('));
    expect(completion.indexOf('self.sourceLock.lock()')).toBeLessThan(
      completion.indexOf('if self.isCurrent(context)'),
    );
    const guardedSeek = method(
      source,
      '  func seekForAttempt(',
      '  @discardableResult',
    );
    expect(guardedSeek).toContain('intentRevision == expectedIntentRevision');
    expect(guardedSeek).toContain(
      'sourceLock.lock(); defer { sourceLock.unlock() }',
    );
    expect(seek).toContain('if origin == "user" { intentRevision += 1 }');
    expect(seek).toContain(
      '"nativeEvent": "seekIntent", "seekTargetSeconds": seconds',
    );
    const emit = method(
      source,
      '  private func updateStatus(',
      '  func seekTo(',
    );
    expect(emit).toContain(
      'context: SourceContext?, updateNowPlaying: Bool = true',
    );
    expect(emit).toContain('arguments["sourceAttemptId"] = context.attemptId');
    expect(emit).not.toContain('context: SourceContext? =');
  });

  test('pause cancels readiness without changing source identity; delayed resume is guarded', () => {
    const source = expected['AudioPlayer.swift'];
    const paused = method(
      source,
      '  private func setPausedIntent(',
      '  func resumePlayback()',
    );
    expect(paused).toContain('readySubscription = nil');
    expect(paused).toContain('intentRevision += 1');
    expect(paused).toContain('"nativeEvent": "intent"');
    expect(paused).not.toContain('sourceAttemptId =');
    const ready = method(
      source,
      '  private func onReady(',
      '  private func restorePlaybackState(',
    );
    expect(ready).toContain('context.item.publisher');
    expect(ready).toContain('self.intentRevision == intentToken');
    expect(ready).toContain('self.seekRevision == seekToken');
    // Paused media-reset restoration can still seek; only its eventual play requires play intent.
    expect(ready).not.toContain('self.puukWantsPlayback');
    const restore = method(
      source,
      '  private func restorePlaybackState(',
      '  private func installTap()',
    );
    expect(restore).toContain(
      'self.isCurrent(context), self.intentRevision == intentToken',
    );
    expect(restore).toContain(
      'guard finished, shouldResume, self.puukWantsPlayback',
    );
    expect(restore).toContain('self.puukWantsPlayback');
  });

  test('JS pause and system interruption reach the native intent boundary, including loading', () => {
    const module = expected['AudioModule.swift'];
    const paused = method(
      module,
      '      Function("pause") { player in',
      '      Function("remove")',
    );
    expect(paused).toContain('Self.pauseExplicitly(player)');
    expect(paused).not.toContain('player.ref.pause()');
    expect(module).not.toContain(
      'playable.isPlaying || (playable as? AudioPlayer)?.puukWantsPlayback',
    );
    expect(module).toContain('if player.pauseForInterruption() {');
    const media = expected['MediaController.swift'];
    expect(media).toContain('player.seekFromRemote(event.positionTime)');
    expect(media.split('player.seekByFromRemote(').length).toBe(3);
    expect(expected['AudioPlayer.swift']).toContain(
      'guard nativeIntent == "interrupted" else { return }',
    );
    expect(expected['MediaController.swift']).toContain(
      'player.emit(event: "nextTrack", payload: player.currentStatus())',
    );
  });

  test('source switch, teardown and release clean subscriptions/seeks; reset binds before observation', () => {
    const source = expected['AudioPlayer.swift'];
    for (const [from, to] of [
      ['  private func teardownPlayer()', '  private func onReady('],
      [
        '  private func replacePlayerItem(',
        '  private func enqueueNextLoopItem()',
      ],
      ['  public override func sharedObjectWillRelease()', '\n}'],
    ]) {
      const body = method(source, from, to);
      expect(body).toContain('readySubscription = nil');
      expect(body).toContain('itemStatusSubscription = nil');
    }
    expect(source).toContain('attemptByItem.removeAllObjects()');
    expect(source).toContain('ref.currentItem?.cancelPendingSeeks()');
    const reset = method(
      source,
      '  private func replacePlayer(with',
      '  private func teardownPlayer()',
    );
    expect(reset.indexOf('attemptByItem.setObject')).toBeLessThan(
      reset.indexOf('setupPublisher()'),
    );
    expect(expected['AudioModule.swift']).toContain(
      'player.clearSourceAttempt()',
    );
  });
});

describe('S1N corrections (static source/fixture regression checks, not native interleaving proof)', () => {
  function preCorrection() {
    const tree = pristine();
    const scripts = path.join(tree.root, 'scripts');
    fs.mkdirSync(scripts);
    const original = path.join(scripts, 's1-patch.cjs');
    fs.copyFileSync(path.join(fixtures, 's1-patch.cjs'), original);
    expect(hash(fs.readFileSync(original))).toBe(
      'c4146f0c8d041b8d163ab5256b4a2f099296d6f72d3c7c8dff2ce8f897925f71',
    );
    success(run(tree.ios, original));
    return tree;
  }

  test('migrates exact pre-correction S1 SDK output, then repeats without changes', () => {
    const { ios } = preCorrection();
    const before = contents(ios);
    expect(before['AudioPlayer.swift']).not.toContain(
      'guard finished, shouldResume',
    );
    expect(before['MediaController.swift']).not.toContain(
      'player.togglePlayback()',
    );
    success(run(ios));
    expect(contents(ios)).toEqual(expected);
    success(run(ios));
    expect(contents(ios)).toEqual(expected);
  });

  test('rejects an unknown change to a pre-correction source before any writes', () => {
    const { ios } = preCorrection();
    fs.appendFileSync(
      path.join(ios, 'AudioModule.swift'),
      '\n// source drift\n',
    );
    const before = contents(ios);
    const result = run(ios);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Source drift: AudioModule.swift');
    expect(contents(ios)).toEqual(before);
  });

  test('a corrective transform failure during S1 migration leaves every source intact', () => {
    const { root, ios } = preCorrection();
    const broken = path.join(root, 'broken-correction.cjs');
    const source = fs.readFileSync(script, 'utf8');
    const corrupted = source.replace(
      /s,\s*'  var wasPlaying = false'/,
      "s, '  MISSING CORRECTION INPUT'",
    );
    expect(corrupted).not.toBe(source);
    fs.writeFileSync(broken, corrupted);
    const before = contents(ios);
    const result = run(ios, broken);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Source drift: expected one occurrence');
    expect(contents(ios)).toEqual(before);
  });

  test('F1: interruption admission and explicit pause still share the intent lock', () => {
    const source = expected['AudioPlayer.swift'];
    const admission = method(
      source,
      '  private func admitAutomaticPause(',
      '  @discardableResult\n  func pauseForInterruption()',
    );
    expect(admission).toContain(
      'sourceLock.lock(); defer { sourceLock.unlock() }',
    );
    expect(admission).toContain(
      'let eligible = !automaticResumeBlocked && (nativeIntent == "play" ||',
    );
    expect(admission).toContain(
      'if eligible { eligibleAutomaticResumes.insert(cause) }',
    );
    expect(admission).toContain(
      'if shouldPause && nativeIntent == "play" { setPausedIntent("interrupted") }',
    );
    expect(admission.indexOf('sourceLock.lock()')).toBeLessThan(
      admission.indexOf('let eligible ='),
    );
    const explicitPause = method(source, '  func pause()', '  // Each cause');
    expect(explicitPause).toContain('eligibleAutomaticResumes.removeAll()');
    expect(explicitPause).toContain('automaticResumeBlocked = true');
    expect(explicitPause.indexOf('sourceLock.lock()')).toBeLessThan(
      explicitPause.indexOf('eligibleAutomaticResumes.removeAll()'),
    );
    expect(explicitPause.indexOf('automaticResumeBlocked = true')).toBeLessThan(
      explicitPause.indexOf('setPausedIntent("pause")'),
    );
    const resume = method(
      source,
      '  private func resumeIfPermitted(',
      '  func togglePlayback()',
    );
    expect(resume).toContain(
      '!automaticResumeBlocked, eligibleAutomaticResumes.contains(cause)',
    );
    expect(resume.indexOf('eligibleAutomaticResumes.removeAll()')).toBeLessThan(
      resume.indexOf('play(at: effectiveRate)'),
    );
  });

  test('F1: module resume bookkeeping uses the admitted result and keeps generic playable behavior', () => {
    const module = expected['AudioModule.swift'];
    const begin = method(
      module,
      '  private func handleInterruptionBegan()',
      '  private func handleInterruptionEnded(',
    );
    expect(begin).toContain(
      'if player.pauseForInterruption() {\n            interruptedPlayers.insert(player.id)',
    );
    expect(begin).toContain('} else if playable.isPlaying {');
    expect(begin).not.toContain('puukWantsPlayback');
    const pauseAll = method(
      module,
      '  private func pauseAllPlayers()',
      '  private func resumeAllPlayers()',
    );
    expect(pauseAll).toContain('player.pauseForLifecycle()');
    expect(pauseAll).toContain(
      '} else if playable.isPlaying {\n        playable.wasPlaying = true;'.replace(
        ';',
        '',
      ),
    );
    const resumeAll = method(
      module,
      '  private func resumeAllPlayers()',
      '  private func pauseAllRecorders()',
    );
    expect(resumeAll).toContain(
      'if let player = playable as? AudioPlayer {\n        player.resumePlayback()',
    );
    expect(resumeAll).toContain('} else if playable.wasPlaying {');
    const reset = method(
      module,
      '  @objc private func handleMediaServicesReset(',
      '  private func reconfigureAudioSession()',
    );
    expect(reset).not.toContain('player.wasPlaying =');
    const bookkeeping = method(
      expected['AudioPlayer.swift'],
      '  var wasPlaying:',
      '  var systemInterruptionToken:',
    );
    expect(bookkeeping.match(/sourceLock.lock\(\)/g)).toHaveLength(2);
  });

  test('F2: failed reset seek cannot play, successful restore remains observable and guarded', () => {
    const source = expected['AudioPlayer.swift'];
    const restore = method(
      source,
      '  private func restorePlaybackState(',
      '  private func installTap()',
    );
    expect(restore).toContain('[weak self] finished in');
    expect(restore).toContain(
      'self.isCurrent(context), self.intentRevision == intentToken',
    );
    expect(restore).toContain('self.seekRevision == seekToken else { return }');
    expect(restore).toContain('"seekOrigin": "recovery"');
    expect(restore).toContain('"nativeEvent": "seekIntent"');
    expect(restore).toContain('"seekCompleted": finished');
    expect(
      restore.indexOf(
        'guard finished, shouldResume, self.puukWantsPlayback else { return }',
      ),
    ).toBeLessThan(restore.indexOf('self.play(at: rate)'));
    expect(restore).not.toContain('"nativeEvent": "progress"');
  });

  test('F2: reset/source teardown invalidates operations before cancellation can reenter', () => {
    const source = expected['AudioPlayer.swift'];
    for (const [start, end] of [
      ['  private func teardownPlayer()', '  private func onReady('],
      [
        '  private func replacePlayerItem(',
        '  private func enqueueNextLoopItem()',
      ],
      ['  public override func sharedObjectWillRelease()', '\n}'],
    ]) {
      const body = method(source, start, end);
      const invalidate = body.indexOf('seekRevision += 1');
      const cancel = body.indexOf('cancelPendingSeeks()');
      expect(invalidate).toBeGreaterThanOrEqual(0);
      expect(cancel).toBeGreaterThan(invalidate);
    }
    const reset = method(
      source,
      '  func handleMediaServicesReset()',
      '  private func replacePlayer(with',
    );
    expect(reset).toContain('let shouldResume = nativeIntent == "play"');
    expect(reset).toContain(
      'replacePlayer(with: source, restoreSampling: wasSamplingEnabled)',
    );
    const replace = method(
      source,
      '  private func replacePlayer(with',
      '  private func teardownPlayer()',
    );
    expect(replace.indexOf('teardownPlayer()')).toBeLessThan(
      replace.indexOf('ref = AudioUtils.createAVPlayer'),
    );
  });

  test('F3: relative target calculation and clamping remain inside the current source lock', () => {
    const relative = method(
      expected['AudioPlayer.swift'],
      '  func seekByFromRemote(',
      '  func seekTo(',
    );
    const lock = relative.indexOf('sourceLock.lock()');
    const read = relative.indexOf('context.item.currentTime().seconds');
    const calculate = relative.indexOf('max(0, position + deltaSeconds)');
    const seek = relative.indexOf('performSeek(seconds: target');
    expect(read).toBeGreaterThan(lock);
    expect(calculate).toBeGreaterThan(read);
    expect(seek).toBeGreaterThan(calculate);
    expect(relative).toContain('target = min(target, duration)');
    for (const [start, end, arg] of [
      [
        '    let skipForwardTarget',
        '    let backwardInterval',
        'event.interval',
      ],
      [
        '    let skipBackwardTarget',
        '    let nextTrackTarget',
        '-event.interval',
      ],
    ]) {
      const handler = method(expected['MediaController.swift'], start, end);
      expect(handler).toContain('player.seekByFromRemote(' + arg + ')');
      expect(handler.indexOf('} else {')).toBeLessThan(
        handler.indexOf(
          'let currentTime = playable.lockScreenPlayer.currentTime()',
        ),
      );
      expect(handler).not.toContain('player.seekFromRemote(seekTime.seconds');
    }
  });

  test('F4: atomic toggle pauses intended play even while loading and preserves other playable types', () => {
    const toggle = method(
      expected['AudioPlayer.swift'],
      '  func togglePlayback()',
      '  private func setPausedIntent(',
    );
    expect(toggle.indexOf('sourceLock.lock()')).toBeLessThan(
      toggle.indexOf('if nativeIntent == "play"'),
    );
    expect(toggle).toContain(
      'if nativeIntent == "play" {\n      pause()\n    } else {\n      play(at: effectiveRate)',
    );
    expect(toggle).not.toContain('isPlaying');
    const handler = method(
      expected['MediaController.swift'],
      '    let togglePlayPauseTarget',
      '    let changePlaybackPositionTarget',
    );
    expect(handler).toContain('player.togglePlayback()');
    expect(handler).toContain(
      '} else if playable.isPlaying {\n        AudioModule.pauseExplicitly(playable)',
    );
    expect(handler).toContain('playable.play(at: Float(playable.currentRate');
  });
});

describe('R1 resume causes (static source checks, not native execution/interleaving proof)', () => {
  function firstCorrection() {
    const tree = pristine();
    const scripts = path.join(tree.root, 'scripts');
    fs.mkdirSync(scripts);
    const patch = path.join(scripts, 's1n-fix-patch.cjs');
    fs.copyFileSync(path.join(fixtures, 's1n-fix-patch.cjs'), patch);
    expect(hash(fs.readFileSync(patch))).toBe(
      'ee16991bacd62ab3baf89a9aa926cc08d59a715ec1b8c2a0b2a6ac28b4bcbe88',
    );
    success(run(tree.ios, patch));
    return tree;
  }

  test('migrates exact first corrective output and repeats byte-identically', () => {
    const { ios } = firstCorrection();
    expect(contents(ios)['AudioPlayer.swift']).toContain(
      'private var interruptionResumePending = false',
    );
    success(run(ios));
    expect(contents(ios)).toEqual(expected);
    success(run(ios));
    expect(contents(ios)).toEqual(expected);
  });

  test('failed R1 transformation leaves first corrective inputs intact', () => {
    const { root, ios } = firstCorrection();
    const broken = path.join(root, 'broken-r1.cjs');
    const source = fs.readFileSync(script, 'utf8');
    const changed = source.replace(
      /s,\s*`  private var interruptionResumePending = false/,
      's, `  MISSING R1 INPUT',
    );
    expect(changed).not.toBe(source);
    fs.writeFileSync(broken, changed);
    const before = contents(ios);
    const result = run(ios, broken);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Source drift: expected one occurrence');
    expect(contents(ios)).toEqual(before);
  });

  test.each(['AudioPlayer.swift', 'AudioModule.swift'])(
    'rejects a mixed corrective/R1 tree with only %s upgraded',
    (name) => {
      const { ios } = firstCorrection();
      fs.writeFileSync(path.join(ios, name), expected[name]);
      const before = contents(ios);
      const result = run(ios);
      expect(result.status).toBe(1);
      expect(contents(ios)).toEqual(before);
    },
  );

  test('foreground releases only an admitted lifecycle cause, never system permission', () => {
    const source = expected['AudioPlayer.swift'];
    const foreground = method(
      source,
      '  func resumePlayback()',
      '  public override func sharedObjectWillRelease()',
    );
    expect(foreground).toContain(
      'guard activeAutomaticPauses.remove(.lifecycle) != nil else { return }',
    );
    expect(foreground).toContain('resumeIfPermitted(for: .lifecycle)');
    expect(foreground).not.toContain('.system');
    const lifecycle = method(
      source,
      '  func pauseForLifecycle()',
      '  func pauseForRouteChange()',
    );
    expect(lifecycle).toContain(
      'admitAutomaticPause(.lifecycle, shouldPause: true)',
    );
    const system = method(
      source,
      '  func pauseForInterruption()',
      '  func beginDuckingInterruption()',
    );
    expect(system).toContain('admitAutomaticPause(.system, shouldPause: true)');
  });

  test('the R1 no-resume trace revokes overlapping eligibility before foreground can consume it', () => {
    const source = expected['AudioPlayer.swift'];
    const end = method(
      source,
      '  func finishSystemInterruption(',
      '  private func resumeIfPermitted(',
    );
    expect(end).toContain('token == systemInterruptionEpoch');
    expect(end).toContain('activeAutomaticPauses.contains(.system)');
    const noResume = method(
      end,
      '    if !shouldResume {',
      '    resumeIfPermitted(for: .system)',
    );
    expect(noResume).toContain('eligibleAutomaticResumes.removeAll()');
    expect(noResume).toContain('automaticResumeBlocked = true');
    expect(noResume).toContain('return');
    const resume = method(
      source,
      '  private func resumeIfPermitted(',
      '  func togglePlayback()',
    );
    expect(resume).toContain(
      '!automaticResumeBlocked, eligibleAutomaticResumes.contains(cause)',
    );
    expect(resume).toContain('activeAutomaticPauses.isEmpty else { return }');
  });

  test('system entry blocks foreground even for already paused or lifecycle-suspended sources', () => {
    const source = expected['AudioPlayer.swift'];
    const admit = method(
      source,
      '  private func admitAutomaticPause(',
      '  @discardableResult\n  func pauseForInterruption()',
    );
    expect(admit).toContain(
      'if cause == .system { systemInterruptionEpoch += 1 }',
    );
    expect(admit.indexOf('activeAutomaticPauses.insert(cause)')).toBeLessThan(
      admit.indexOf('let eligible ='),
    );
    expect(admit).toContain(
      'nativeIntent == "interrupted" && !eligibleAutomaticResumes.isEmpty',
    );
    expect(admit).not.toContain('guard !released, nativeIntent == "play"');
    expect(source).not.toContain('interruptionResumePending');
  });

  test('session-end policy and token are captured before async work; failed activation cannot grant resume', () => {
    const end = method(
      expected['AudioModule.swift'],
      '  private func handleInterruptionEnded(',
      '  @objc private func handleAudioSessionRouteChange(',
    );
    expect(
      end.indexOf('let audioPlayers = registry.allPlayers.values.map'),
    ).toBeLessThan(end.indexOf('sessionQueue.async'));
    expect(
      end.indexOf(
        'player.finishSystemInterruption(token: token, shouldResume: false)',
      ),
    ).toBeLessThan(end.indexOf('sessionQueue.async'));
    expect(end).toContain(
      'player.finishSystemInterruption(token: token, shouldResume: canResume)',
    );
    expect(end).toContain(
      'self.resumeInterruptedPlayers(generation: generation, shouldResume: canResume)',
    );
    const generic = method(
      expected['AudioModule.swift'],
      '  private func resumeInterruptedPlayers(',
      '  private func pauseAllPlayers()',
    );
    expect(generic).toContain(
      'if shouldResume, interruptedPlayers.contains(playable.id), !(playable is AudioPlayer) {',
    );
  });

  test('route loss and explicit audio disable grant no lifecycle/system resume permission', () => {
    const source = expected['AudioPlayer.swift'];
    const route = method(
      source,
      '  func pauseForRouteChange()',
      '  func finishSystemInterruption(',
    );
    expect(route).toContain('pause()');
    expect(route).not.toContain('admitAutomaticPause');
    const module = expected['AudioModule.swift'];
    const routeHandler = method(
      module,
      '  @objc private func handleAudioSessionRouteChange(',
      '  #if os(iOS)\n  @objc private func handleMediaServicesReset(',
    );
    expect(routeHandler).toContain('player.pauseForRouteChange()');
    expect(routeHandler).not.toContain('pauseAllPlayers()');
    const disable = method(
      module,
      '  private func setIsAudioActive(',
      '  private func',
    );
    expect(disable).toContain(
      'registry.allPlayables.forEach { Self.pauseExplicitly($0) }',
    );
    expect(disable).not.toContain('pauseAllPlayers()');
  });

  test('explicit pause and release revoke every cause; a new explicit play cannot clear an active system blocker', () => {
    const source = expected['AudioPlayer.swift'];
    const pause = method(source, '  func pause()', '  // Each cause');
    const release = method(
      source,
      '  public override func sharedObjectWillRelease()',
      '\n}',
    );
    for (const body of [pause, release]) {
      expect(body).toContain('eligibleAutomaticResumes.removeAll()');
      expect(body).toContain('automaticResumeBlocked = true');
    }
    const play = method(
      source,
      '  func play(at rate:',
      '  func setSamplingEnabled(',
    );
    expect(play).toContain('eligibleAutomaticResumes.removeAll()');
    expect(play).toContain('automaticResumeBlocked = false');
    expect(play).not.toContain('activeAutomaticPauses.removeAll()');
  });

  test('ducking still records active system blocking while generic playable behavior stays separate', () => {
    const source = expected['AudioPlayer.swift'];
    const duck = method(
      source,
      '  func beginDuckingInterruption()',
      '  func pauseForLifecycle()',
    );
    expect(duck).toContain('admitAutomaticPause(.system, shouldPause: false)');
    const module = expected['AudioModule.swift'];
    const begin = method(
      module,
      '  private func handleInterruptionBegan()',
      '  private func handleInterruptionEnded(',
    );
    expect(begin).toContain(
      '(playable as? AudioPlayer)?.beginDuckingInterruption()',
    );
    expect(begin).toContain('if playable.isPlaying {');
    expect(begin).toContain('playable.volume *= 0.5');
    expect(begin).toContain('if player.pauseForInterruption() {');
  });
});

describe('R2 module ownership (static source/fixture checks, not native interleaving proof)', () => {
  function r1() {
    const tree = pristine();
    const scripts = path.join(tree.root, 'scripts');
    fs.mkdirSync(scripts);
    const patch = path.join(scripts, 's1n-r1-patch.cjs');
    fs.copyFileSync(path.join(fixtures, 's1n-r1-patch.cjs'), patch);
    expect(hash(fs.readFileSync(patch))).toBe(
      'cb7535449e3c410af58eb6947a765d7da230c80be73e3f0dc9bb5e7f0c16e3a0',
    );
    success(run(tree.ios, patch));
    return tree;
  }
  const module = () => expected['AudioModule.swift'];
  const begin = () =>
    method(
      module(),
      '  private func handleInterruptionBegan()',
      '  private func handleInterruptionEnded(',
    );
  const end = () =>
    method(
      module(),
      '  private func handleInterruptionEnded(',
      '  @objc private func handleAudioSessionRouteChange(',
    );
  const cleanup = () =>
    method(
      module(),
      '  private func resumeInterruptedPlayers(',
      '  private func pauseAllPlayers()',
    );

  test('migrates exact R1 output, repeats byte-identically and preserves the entire AudioPlayer', () => {
    const { ios } = r1();
    const before = contents(ios);
    expect(hash(before['AudioModule.swift'])).toBe(
      '07c2e437e9d99c44cc7b5c0500fb51d91d1e95283bbb93359890241037370b33',
    );
    success(run(ios));
    expect(contents(ios)).toEqual(expected);
    expect(expected['AudioPlayer.swift']).toBe(before['AudioPlayer.swift']);
    success(run(ios));
    expect(contents(ios)).toEqual(expected);
  });

  test('failed R2 transform preserves every exact R1 source before the first disk write', () => {
    const { root, ios } = r1();
    const broken = path.join(root, 'broken-r2.cjs');
    const source = fs.readFileSync(script, 'utf8');
    const changed = source.replace(
      /s,\s*'  private var interruptedPlayers = Set<String>\(\)'/,
      "s, '  MISSING R2 INPUT'",
    );
    expect(changed).not.toBe(source);
    fs.writeFileSync(broken, changed);
    const before = contents(ios);
    const result = run(ios, broken);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Source drift: expected one occurrence');
    expect(contents(ios)).toEqual(before);
  });

  test('rejects a partly migrated R1/R2 module and preserves all bytes', () => {
    const { ios } = r1();
    fs.writeFileSync(
      path.join(ios, 'AudioModule.swift'),
      expected['AudioModule.swift'],
    );
    const before = contents(ios);
    expect(run(ios).status).toBe(1);
    expect(contents(ios)).toEqual(before);
  });

  test('overlapping begins retain the first baseline and apply ducking only once', () => {
    const source = begin();
    expect(source.indexOf('Self.interruptionStateLock.lock()')).toBeLessThan(
      source.indexOf('interruptionGeneration += 1'),
    );
    expect(source).toContain('defer { Self.interruptionStateLock.unlock() }');
    expect(source).toContain('interruptionPending = true');
    expect(source).not.toContain('removeAll()');
    expect(source).toContain(
      'if playerVolumes[playable.id] == nil {\n            playerVolumes[playable.id] = playable.volume\n            playable.volume *= 0.5\n          }',
    );
    const duck = method(
      source,
      '      case .duckOthers:',
      '      case .doNotMix,',
    );
    expect(duck).not.toContain('interruptedPlayers.insert');
  });

  test('old end cannot finish players, restore volume, resume recorders or clear a newer begin', () => {
    const source = end();
    expect(
      source.indexOf('let generation = interruptionGeneration'),
    ).toBeLessThan(source.indexOf('sessionQueue.async'));
    const queued = source.slice(source.indexOf('sessionQueue.async'));
    expect(
      queued.indexOf('guard ownsInterruption else { return }'),
    ).toBeLessThan(queued.indexOf('self.applySessionActive(true)'));
    const fence =
      'guard self.interruptionPending, self.interruptionGeneration == generation else { return }';
    expect(queued.indexOf(fence)).toBeGreaterThan(
      queued.indexOf('self.applySessionActive(true)'),
    );
    expect(queued.indexOf(fence)).toBeLessThan(
      queued.indexOf('player.finishSystemInterruption('),
    );
    expect(queued.indexOf(fence)).toBeLessThan(
      queued.indexOf('self.resumeInterruptedPlayers('),
    );
    expect(
      queued.indexOf('defer { Self.interruptionStateLock.unlock() }'),
    ).toBeLessThan(queued.indexOf(fence));
    const finish = cleanup();
    const guard =
      'guard interruptionPending, interruptionGeneration == generation else { return }';
    for (const mutation of [
      'playable.volume = originalVolume',
      'playable.resumePlayback()',
      'recorder.resumeAfterSystemPause()',
      'interruptedPlayers.removeAll()',
      'playerVolumes.removeAll()',
      'interruptionPending = false',
    ]) {
      expect(finish.indexOf(guard)).toBeLessThan(finish.indexOf(mutation));
      expect(finish.indexOf(mutation)).toBeGreaterThan(-1);
    }
  });

  test('matching no-resume and failed activation restore volume without automatic playback', () => {
    const source = end();
    const denied = method(
      source,
      '    if !shouldResume {',
      '    sessionQueue.async',
    );
    expect(denied).toContain(
      'player.finishSystemInterruption(token: token, shouldResume: false)',
    );
    expect(denied).toContain(
      'resumeInterruptedPlayers(generation: generation, shouldResume: false)',
    );
    expect(denied).toContain('return');
    expect(source).toContain(
      'self.resumeInterruptedPlayers(generation: generation, shouldResume: canResume)',
    );
    const finish = cleanup();
    expect(finish.indexOf('playable.volume = originalVolume')).toBeLessThan(
      finish.indexOf('if shouldResume,'),
    );
    expect(finish).toContain(
      'if shouldResume, interruptedPlayers.contains(playable.id), !(playable is AudioPlayer)',
    );
    expect(finish).toContain('if shouldResume {\n      registry.allRecorders');
  });

  test('mode changes cannot reinterpret recorded ducking as playback admission', () => {
    expect(cleanup()).not.toContain('interruptionMode');
    expect(module()).toContain(
      'Self.interruptionStateLock.lock()\n    self.interruptionMode = mode.interruptionMode\n    Self.interruptionStateLock.unlock()',
    );
    expect(cleanup()).toContain(
      'if let originalVolume = playerVolumes[playable.id]',
    );
    expect(cleanup()).toContain('interruptedPlayers.contains(playable.id)');
  });

  test('explicit and route stops serialize generic resume revocation with the actual pause', () => {
    const explicit = method(
      module(),
      '  static func pauseExplicitly(',
      '  @objc private func handleExplicitPause(',
    );
    expect(explicit.indexOf('interruptionStateLock.lock()')).toBeLessThan(
      explicit.indexOf('NotificationCenter.default.post('),
    );
    expect(explicit.indexOf('NotificationCenter.default.post(')).toBeLessThan(
      explicit.indexOf('playable.pause()'),
    );
    expect(explicit).toContain('defer { interruptionStateLock.unlock() }');
    const revoke = method(
      module(),
      '  @objc private func handleExplicitPause(',
      '  private func handleInterruptionBegan()',
    );
    expect(revoke).toContain('interruptedPlayers.remove(playable.id)');
    expect(revoke).toContain(
      'if !(playable is AudioPlayer) { playable.wasPlaying = false }',
    );
    const route = method(
      module(),
      '  @objc private func handleAudioSessionRouteChange(',
      '  #if os(iOS)\n  @objc private func handleMediaServicesReset(',
    );
    expect(route).toContain('interruptedPlayers.remove(playable.id)');
    expect(route).toContain('Self.pauseExplicitly(playable)');
    expect(route).not.toContain('wasPlaying = true');
    expect(module()).toContain('Self.pauseExplicitly(playlist)');
    expect(
      expected['MediaController.swift'].split(
        'AudioModule.pauseExplicitly(playable)',
      ).length,
    ).toBe(3);
    expect(module()).toContain('selector: #selector(handleExplicitPause(_:))');
    expect(module()).toContain(
      'NotificationCenter.default.removeObserver(self)',
    );
  });
});
