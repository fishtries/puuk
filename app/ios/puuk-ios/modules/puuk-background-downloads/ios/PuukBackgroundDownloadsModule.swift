import ExpoModulesCore
import Foundation

public final class PuukBackgroundDownloadsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PuukBackgroundDownloads")
    Events("change")

    OnStartObserving { [weak self] in
      BackgroundTransfers.shared.observe { [weak self] in self?.sendEvent("change") }
    }
    OnStopObserving {
      BackgroundTransfers.shared.observe(nil)
    }

    AsyncFunction("prepareStorage") { (promise: Promise) in
      BackgroundTransfers.shared.prepareStorage(promise)
    }
    AsyncFunction("start") { (input: TransferRequest, promise: Promise) in
      BackgroundTransfers.shared.start(input, promise: promise)
    }
    AsyncFunction("snapshot") { (promise: Promise) in
      BackgroundTransfers.shared.snapshot(promise)
    }
    AsyncFunction("discard") { (operationId: String, promise: Promise) in
      BackgroundTransfers.shared.discard(operationId, promise: promise)
    }
  }
}

public enum PuukBackgroundEvents {
  public static func handle(_ identifier: String, completion: @escaping () -> Void) -> Bool {
    guard BackgroundTransfers.identifiers.contains(identifier) else { return false }
    BackgroundTransfers.shared.handleEvents(identifier, completion: completion)
    return true
  }
}

struct TransferRequest: Record {
  @Field var jobId: String = ""
  @Field var operationId: String = ""
  @Field var origin: String = ""
  @Field var userId: String = ""
  @Field var activationId: String = ""
  @Field var generation: Int = 0
  @Field var trackId: String = ""
  @Field var contentVersion: String = ""
  @Field var contentLength: Int = 0
  @Field var stagingPath: String = ""
  @Field var stagingUri: String = ""
  @Field var uri: String = ""
  @Field var ifMatch: String?
  @Field var allowCellular: Bool = false
}
