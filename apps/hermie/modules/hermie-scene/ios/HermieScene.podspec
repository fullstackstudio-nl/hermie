require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'HermieScene'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  # iOS only, and that includes the Mac: "Designed for iPad" runs this same slice.
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  # No ExpoModulesCore dependency and no module in expo-module.config.json: there is no JavaScript
  # side to this. Autolinking is used only to get the pod into the build, and the app target's
  # `-ObjC` link flag is what keeps a class nobody references at compile time — UIKit finds
  # `HermieSceneDelegate` by the name in Info.plist — out of the linker's dead-strip.
  s.frameworks = 'UIKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
