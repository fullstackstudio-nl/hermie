// Autolinking map for the React Native CLI, which drives the macOS project.
// Expo modules are linked by `use_expo_modules!` in macos/Podfile, not here.
//
// The packages below ship no macOS implementation in the versions Expo SDK 54
// bundles, so they are excluded from the macOS build. Their JavaScript is kept
// out of the macOS bundle by `.macos.tsx` variants in src/, which is where the
// replacement behaviour lives. Re-check this on every SDK bump and record the
// outcome in docs/platform-notes.md.
module.exports = {
  dependencies: {
    'react-native-screens': { platforms: { macos: null } },
    'react-native-safe-area-context': { platforms: { macos: null } },
    '@react-native-community/netinfo': { platforms: { macos: null } }
  }
}
