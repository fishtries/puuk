import AVFoundation
import ExpoModulesCore

public final class PuukEqualizerModule: Module {
  private let mix = PUEqualizerMix()
  private weak var player: AVPlayer?
  private weak var item: AVPlayerItem?
  private var observation: NSKeyValueObservation?
  private var load: Task<Void, Never>?
  private var installed: AVAudioMix?
  private var active = false
  private var unavailable = false

  public func definition() -> ModuleDefinition {
    Name("PuukEqualizer")
    Events("availability")
    AsyncFunction("isUnavailable") { self.unavailable }.runOnQueue(.main)
    Function("bind") { (audio: SharedRef<AVPlayer>) in
      DispatchQueue.main.async { [weak self] in self?.observe(audio.ref) }
    }
    Function("configure") { (gains: [Int]) in
      DispatchQueue.main.async { [weak self] in
        guard let self, gains.count == 7 else { return }
        self.mix.update(gains: gains.map { NSNumber(value: $0) })
        self.active = gains.contains { $0 != 0 }
        self.refresh()
      }
    }
    Function("unbind") {
      DispatchQueue.main.async { [weak self] in self?.observe(nil) }
    }
    OnDestroy {
      DispatchQueue.main.async { [self] in self.observe(nil) }
    }
  }

  private func observe(_ next: AVPlayer?) {
    guard player !== next || next == nil else { return }
    observation = nil
    clearItem()
    player = next
    observation = next?.observe(\.currentItem, options: [.initial, .new]) { [weak self] observed, _ in
      DispatchQueue.main.async {
        guard let self, self.player === observed else { return }
        self.refresh()
      }
    }
  }

  private func reportUnavailable(_ value: Bool) {
    unavailable = value
    sendEvent("availability", ["unavailable": value])
  }

  private func clearItem() {
    load?.cancel()
    load = nil
    if let installed, item?.audioMix === installed { item?.audioMix = nil }
    installed = nil
    item = nil
  }

  private func refresh() {
    if item !== player?.currentItem {
      clearItem()
      item = player?.currentItem
      reportUnavailable(false)
    }
    guard active, installed == nil, load == nil, let item else { return }
    load = Task { @MainActor [weak self, weak item] in
      guard let self, let item else { return }
      let tracks = try? await item.asset.loadTracks(withMediaType: .audio)
      guard !Task.isCancelled, self.player?.currentItem === item else { return }
      self.load = nil
      guard self.active else { return }
      guard let track = tracks?.first, let audioMix = self.mix.makeMix(track: track) else {
        self.reportUnavailable(true)
        return
      }
      item.audioMix = audioMix
      self.installed = item.audioMix
      self.reportUnavailable(false)
    }
  }
}
