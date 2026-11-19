import CryptoKit
import ExpoModulesCore
import Foundation

private struct Receipt: Codable {
  let stagingPath: String
  let status: Int
  var bytes: Int = 0
  var sha256: String?
  var failure: String?
}

private struct Transfer: Codable {
  let jobId: String
  let operationId: String
  let origin: String
  let userId: String
  let activationId: String
  let generation: Int
  let trackId: String
  let contentVersion: String
  let contentLength: Int
  let stagingPath: String
  let allowCellular: Bool
  let nativeSessionId: String
  let nativeTaskId: Int
  var receipt: Receipt?
  var bytesReceived: Int64?

  init(_ input: TransferRequest, sessionId: String, taskId: Int) {
    jobId = input.jobId
    operationId = input.operationId
    origin = input.origin
    userId = input.userId
    activationId = input.activationId
    generation = input.generation
    trackId = input.trackId
    contentVersion = input.contentVersion
    contentLength = input.contentLength
    stagingPath = input.stagingPath
    allowCellular = input.allowCellular
    nativeSessionId = sessionId
    nativeTaskId = taskId
  }
}

final class BackgroundTransfers: NSObject, URLSessionDownloadDelegate {
  static let shared = BackgroundTransfers()
  static let identifiers = ["wifi", "cellular"].map {
    "\(Bundle.main.bundleIdentifier ?? "com.fishtries.puuk").offline-downloads.v1.\($0)"
  }

  private let queue = DispatchQueue(label: "puuk.offline.transfers")
  private lazy var delegates: OperationQueue = {
    let operations = OperationQueue()
    operations.maxConcurrentOperationCount = 1
    operations.underlyingQueue = queue
    return operations
  }()
  private let files = FileManager.default
  private var sessions: [String: URLSession] = [:]
  private var handlers: [String: [() -> Void]] = [:]
  private var staged: [String: Receipt] = [:]
  private var missingSince: [String: DispatchTime] = [:]
  private var observer: (() -> Void)?
  private var lastProgressSignal = DispatchTime.now()

  private var root: URL {
    files.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("puuk-offline", isDirectory: true)
  }

  private var journal: URL {
    root.appendingPathComponent(".transfers-v1", isDirectory: true)
  }

  private func session(_ identifier: String) -> URLSession {
    if let cached = sessions[identifier] { return cached }
    let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
    configuration.allowsCellularAccess = identifier == Self.identifiers[1]
    configuration.sessionSendsLaunchEvents = true
    configuration.isDiscretionary = false
    configuration.timeoutIntervalForRequest = 60
    configuration.timeoutIntervalForResource = 15 * 60
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.httpShouldSetCookies = false
    let created = URLSession(configuration: configuration, delegate: self, delegateQueue: delegates)
    sessions[identifier] = created
    return created
  }

  func handleEvents(_ identifier: String, completion: @escaping () -> Void) {
    queue.async {
      self.handlers[identifier, default: []].append(completion)
      _ = self.session(identifier)
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    guard let identifier = session.configuration.identifier else { return }
    let completions = handlers.removeValue(forKey: identifier) ?? []
    DispatchQueue.main.async { completions.forEach { $0() } }
  }

  func observe(_ callback: (() -> Void)?) {
    queue.async { self.observer = callback }
  }

  private func signalChange() {
    if let observer { DispatchQueue.main.async { observer() } }
  }

  private enum TransferError: Error { case invalid, occupied }

  private func recordUrl(_ id: String) throws -> URL {
    guard id.range(of: "^[a-zA-Z0-9_-]{1,128}$", options: .regularExpression) != nil else {
      throw TransferError.invalid
    }
    return journal.appendingPathComponent(id + ".json")
  }

  private func stagingUrl(_ path: String) throws -> URL {
    guard path.range(of: "^staging/[a-zA-Z0-9_-]{1,128}\\.part$", options: .regularExpression) != nil else {
      throw TransferError.invalid
    }
    let canonicalRoot = root.resolvingSymlinksInPath()
    let staging = canonicalRoot.appendingPathComponent("staging", isDirectory: true)
    guard staging.resolvingSymlinksInPath().path == staging.path else { throw TransferError.invalid }
    let target = canonicalRoot.appendingPathComponent(path)
    if files.fileExists(atPath: target.path), target.resolvingSymlinksInPath().path != target.path {
      throw TransferError.invalid
    }
    return target
  }

  private func prepareDirectory(_ url: URL) throws {
    try files.createDirectory(at: url, withIntermediateDirectories: true)
    try protectAndExclude(url)
  }

  private func protectAndExclude(_ url: URL) throws {
    try files.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                            ofItemAtPath: url.path)
    var target = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try target.setResourceValues(values)
  }

  private func prepareOfflineStorage() throws {
    try prepareDirectory(root)
    try prepareDirectory(root.appendingPathComponent("staging", isDirectory: true))
    try prepareDirectory(root.appendingPathComponent("media", isDirectory: true))
    try prepareDirectory(journal)
  }

  func prepareStorage(_ promise: Promise) {
    queue.async {
      do {
        try self.prepareOfflineStorage()
        promise.resolve(nil)
      } catch {
        promise.reject("ERR_OFFLINE_STORAGE", "Could not protect offline storage")
      }
    }
  }

  private func save(_ transfer: Transfer) throws {
    try prepareDirectory(journal)
    try JSONEncoder().encode(transfer).write(to: recordUrl(transfer.operationId), options: [
      .atomic, .completeFileProtectionUntilFirstUserAuthentication,
    ])
  }

  private func read(_ id: String) throws -> Transfer {
    try JSONDecoder().decode(Transfer.self, from: Data(contentsOf: recordUrl(id)))
  }

  private func transfer(for task: URLSessionTask, in session: URLSession) -> Transfer? {
    guard let operationId = task.taskDescription, let transfer = try? read(operationId),
          transfer.nativeTaskId == task.taskIdentifier,
          transfer.nativeSessionId == session.configuration.identifier else { return nil }
    return transfer
  }

  private func encode(_ value: some Encodable) throws -> Any {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
  }

  func start(_ input: TransferRequest, promise: Promise) {
    queue.async {
      do {
        let target = try self.stagingUrl(input.stagingPath)
        guard let supplied = URL(string: input.stagingUri), supplied.isFileURL,
              input.stagingPath == "staging/\(input.operationId).part",
              supplied.deletingLastPathComponent().resolvingSymlinksInPath().path == target.deletingLastPathComponent().path,
              supplied.lastPathComponent == target.lastPathComponent,
              input.contentLength > 0, input.contentLength <= 500 * 1024 * 1024,
              input.contentVersion.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              let url = URL(string: input.uri), ["http", "https"].contains(url.scheme ?? ""),
              url.host != nil, url.user == nil, url.password == nil else { throw TransferError.invalid }
        let record = try self.recordUrl(input.operationId)
        guard !self.files.fileExists(atPath: record.path),
              !self.files.fileExists(atPath: target.path) else { throw TransferError.occupied }
        try self.prepareOfflineStorage()
        let sessionId = Self.identifiers[input.allowCellular ? 1 : 0]
        var request = URLRequest(url: url)
        request.allowsCellularAccess = input.allowCellular
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        request.setValue(input.ifMatch, forHTTPHeaderField: "If-Match")
        let task = self.session(sessionId).downloadTask(with: request)
        task.taskDescription = input.operationId
        do {
          try self.save(Transfer(input, sessionId: sessionId, taskId: task.taskIdentifier))
        } catch {
          task.cancel()
          throw error
        }
        task.resume()
        promise.resolve(["nativeSessionId": sessionId, "nativeTaskId": task.taskIdentifier] as [String: Any])
      } catch {
        promise.reject("ERR_OFFLINE_START", "Could not start background transfer")
      }
    }
  }

  private func allTasks(_ callback: @escaping ([(String, URLSessionTask)]) -> Void) {
    session(Self.identifiers[0]).getAllTasks { wifiTasks in
      self.queue.async {
        self.session(Self.identifiers[1]).getAllTasks { cellularTasks in
          self.queue.async {
            callback(wifiTasks.map { (Self.identifiers[0], $0) } +
                     cellularTasks.map { (Self.identifiers[1], $0) })
          }
        }
      }
    }
  }

  func snapshot(_ promise: Promise) {
    queue.async {
      self.allTasks { tasks in
        do {
          try self.prepareOfflineStorage()
          let urls = try self.files.contentsOfDirectory(at: self.journal, includingPropertiesForKeys: nil)
          let records = try urls.filter { $0.pathExtension == "json" }
            .map { try self.read($0.deletingPathExtension().lastPathComponent) }
          let byId = Dictionary(uniqueKeysWithValues: records.map { ($0.operationId, $0) })
          var progress: [String: Int64] = [:]
          let active = Set(tasks.compactMap { identifier, task -> String? in
            guard let id = task.taskDescription, let record = byId[id],
                  record.nativeTaskId == task.taskIdentifier, record.nativeSessionId == identifier,
                  record.receipt == nil else {
              task.cancel()
              return nil
            }
            // A crash before resume leaves a suspended task. Obtain a new ticket on retry.
            if task.state == .suspended { task.cancel() }
            progress[id] = task.countOfBytesReceived
            return id
          })
          var transfers: [Transfer] = []
          for var record in records {
            let id = record.operationId
            if record.receipt == nil && !active.contains(id) {
              // getAllTasks can lose sight of a task before its queued delegate event arrives.
              let now = DispatchTime.now()
              if let first = self.missingSince[id], now >= first + .seconds(5) {
                record.receipt = Receipt(stagingPath: record.stagingPath, status: 0, failure: "interrupted")
                try self.save(record)
              } else if self.missingSince[id] == nil {
                self.missingSince[id] = now
                self.queue.asyncAfter(deadline: now + .seconds(5)) { self.signalChange() }
              }
            }
            if record.receipt != nil || active.contains(id) { self.missingSince.removeValue(forKey: id) }
            record.bytesReceived = progress[id]
            transfers.append(record)
          }
          promise.resolve(try self.encode(transfers))
        } catch {
          promise.reject("ERR_OFFLINE_SNAPSHOT", "Could not read background transfers")
        }
      }
    }
  }

  func discard(_ operationId: String, promise: Promise) {
    queue.async {
      self.allTasks { tasks in
        do {
          let record = try self.recordUrl(operationId)
          if self.files.fileExists(atPath: record.path) {
            let transfer = try self.read(operationId)
            for (identifier, task) in tasks where identifier == transfer.nativeSessionId &&
                task.taskDescription == operationId && task.taskIdentifier == transfer.nativeTaskId {
              task.cancel()
            }
            let staging = try self.stagingUrl(transfer.stagingPath)
            if self.files.fileExists(atPath: staging.path) { try self.files.removeItem(at: staging) }
            try self.files.removeItem(at: record)
          }
          self.staged.removeValue(forKey: operationId)
          self.missingSince.removeValue(forKey: operationId)
          promise.resolve(nil)
        } catch {
          promise.reject("ERR_OFFLINE_DISCARD", "Could not discard background transfer")
        }
      }
    }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                  totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    guard let transfer = transfer(for: downloadTask, in: session) else { downloadTask.cancel(); return }
    if totalBytesWritten > Int64(transfer.contentLength) {
      let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
      staged[transfer.operationId] = Receipt(stagingPath: transfer.stagingPath, status: status,
                                             failure: status == 200 ? "integrity" : "http")
      downloadTask.cancel()
      return
    }
    let interval: Int64 = 1024 * 1024
    let now = DispatchTime.now()
    if now >= lastProgressSignal + .seconds(1),
       totalBytesWritten / interval != (totalBytesWritten - bytesWritten) / interval {
      lastProgressSignal = now
      signalChange()
    }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    guard let transfer = transfer(for: downloadTask, in: session) else { return }
    let response = downloadTask.response as? HTTPURLResponse
    var receipt = Receipt(stagingPath: transfer.stagingPath, status: response?.statusCode ?? 0)
    defer { staged[transfer.operationId] = receipt }
    guard receipt.status == 200 else {
      receipt.failure = "http"
      return
    }
    guard let origin = downloadTask.originalRequest?.url, response?.url == origin,
          response?.expectedContentLength == Int64(transfer.contentLength) else {
      receipt.failure = "integrity"
      return
    }
    do {
      let target = try stagingUrl(transfer.stagingPath)
      let bytes = try location.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard bytes == transfer.contentLength else { receipt.failure = "integrity"; return }
      try prepareDirectory(target.deletingLastPathComponent())
      try files.moveItem(at: location, to: target)
      try protectAndExclude(target)
      let file = try FileHandle(forReadingFrom: target)
      defer { try? file.close() }
      var hash = SHA256()
      while let data = try file.read(upToCount: 256 * 1024), !data.isEmpty { hash.update(data: data) }
      let sha256 = hash.finalize().map { String(format: "%02x", $0) }.joined()
      receipt.bytes = bytes
      receipt.sha256 = sha256
      if sha256 != transfer.contentVersion { receipt.failure = "integrity" }
    } catch {
      receipt.failure = storageFailure(error)
    }
  }

  private func storageFailure(_ error: Error) -> String {
    let nsError = error as NSError
    if nsError.domain == NSCocoaErrorDomain && nsError.code == NSFileWriteOutOfSpaceError { return "space" }
    return "storage"
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard var transfer = transfer(for: task, in: session), transfer.receipt == nil else { return }
    var receipt = staged.removeValue(forKey: transfer.operationId) ?? Receipt(
      stagingPath: transfer.stagingPath, status: (task.response as? HTTPURLResponse)?.statusCode ?? 0)
    if receipt.failure == nil {
      if let error = error as NSError? {
        receipt.failure = error.domain == NSURLErrorDomain && error.code == NSURLErrorCannotWriteToFile
          ? "storage" : "interrupted"
      } else if receipt.sha256 == nil {
        receipt.failure = "interrupted"
      }
    }
    transfer.receipt = receipt
    // If the disk cannot persist the receipt, the original durable record remains and
    // snapshot recovers it as interrupted once the task disappears.
    try? save(transfer)
    signalChange()
  }
}
