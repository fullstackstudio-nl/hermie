const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

// `watchFolders` and `resolver.nodeModulesPaths` are left as Expo computed them.
// Expo already walks the npm workspaces and watches the hoisted root
// node_modules plus every workspace package. Adding the workspace root itself
// would move Metro's server root up to the repo root, and the native apps ask
// for `/index.bundle`, which only resolves when the server root is this package.

// `macos` has to be an explicit platform: react-native-macos ships `.macos.js`
// overrides, and Expo's default list is ios/android only.
config.resolver.platforms = ['ios', 'android', 'macos', 'native', 'web']

const upstreamResolveRequest = config.resolver.resolveRequest

// On macOS every `react-native` import — bare or deep — has to land in
// react-native-macos instead, otherwise two copies of the runtime get bundled.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstreamResolveRequest ?? context.resolveRequest

  if (platform === 'macos' && (moduleName === 'react-native' || moduleName.startsWith('react-native/'))) {
    const rewritten = `react-native-macos${moduleName.slice('react-native'.length)}`
    return resolve(context, rewritten, platform)
  }

  return resolve(context, moduleName, platform)
}

const upstreamGetModulesRunBeforeMainModule = config.serializer.getModulesRunBeforeMainModule

// Both runtimes need their InitializeCore to run before the entry module. The
// serializer is not told which platform it is serialising for, so it lists both
// and lets the resolver drop the one that is not in the graph.
config.serializer.getModulesRunBeforeMainModule = () => {
  try {
    return [
      require.resolve('react-native/Libraries/Core/InitializeCore'),
      require.resolve('react-native-macos/Libraries/Core/InitializeCore')
    ]
  } catch {
    return upstreamGetModulesRunBeforeMainModule()
  }
}

module.exports = config
