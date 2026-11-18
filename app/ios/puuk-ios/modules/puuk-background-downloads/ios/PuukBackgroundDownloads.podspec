Pod::Spec.new do |s|
  s.name = 'PuukBackgroundDownloads'
  s.version = '1.0.0'
  s.summary = 'Durable iOS audio transfer receipts for Puuk'
  s.homepage = 'https://puuk.fun'
  s.license = 'UNLICENSED'
  s.author = 'Puuk'
  s.platform = :ios, '16.4'
  s.source = { :git => 'https://github.com/fishtries/puuk.git' }
  s.static_framework = true
  s.swift_version = '5.9'
  s.source_files = '*.swift'
  s.dependency 'ExpoModulesCore'
end
