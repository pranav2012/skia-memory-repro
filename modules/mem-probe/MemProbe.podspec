Pod::Spec.new do |s|
  s.name = "MemProbe"
  s.version = "0.1.0"
  s.summary = "Reads the app's own memory footprint for the Skia memory repro."
  s.license = { :type => "MIT" }
  s.author = "skia-memory-repro"
  s.homepage = "https://github.com/expo/expo"
  s.platforms = { :ios => "16.4" }
  s.swift_version = "5.9"
  s.source = { :git => "https://github.com/expo/expo.git" }
  s.static_framework = true
  s.dependency "ExpoModulesCore"
  s.source_files = "ios/**/*.{h,m,mm,swift}"
end
