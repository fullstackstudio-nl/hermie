import ExpoModulesCore

/**
 Whether this process is the iOS app running on an Apple Silicon Mac.

 `ProcessInfo.processInfo.isiOSAppOnMac` is the only API that answers it, and React Native exposes
 nothing equivalent: `Platform.isMacCatalyst` reads the compile-time `TARGET_OS_MACCATALYST` flag,
 which is false for the unmodified iOS binary macOS runs as "Designed for iPad".

 A constant rather than a function. The answer is fixed for the lifetime of the process, and the
 JavaScript side needs it during the first render — a layout that has to wait for a promise flashes
 the wrong geometry first.
 */
public class HermieMacModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HermieMac")

    Constants([
      "isMac": ProcessInfo.processInfo.isiOSAppOnMac
    ])
  }
}
