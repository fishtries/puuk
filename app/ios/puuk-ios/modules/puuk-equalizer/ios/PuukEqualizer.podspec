Pod::Spec.new do |s|
  s.name = 'PuukEqualizer'
  s.version = '1.0.0'
  s.summary = 'Seven-band playback equalizer for Puuk'
  s.homepage = 'https://puuk.fun'
  s.license = 'UNLICENSED'
  s.author = 'Puuk'
  s.platform = :ios, '16.4'
  s.source = { :git => 'https://github.com/fishtries/puuk.git' }
  s.static_framework = true
  s.swift_version = '5.9'
  s.source_files = '*.{swift,h,m,c}'
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'MediaToolbox'
end
