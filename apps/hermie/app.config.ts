import type { ExpoConfig } from 'expo/config'

const BUNDLE_ID = 'nl.fullstackstudio.hermie'
const IOS_DEPLOYMENT_TARGET = '15.1'

/**
 * The midpoint of the gradient in design/icon.svg. Android composites the
 * adaptive foreground over a flat colour, so this is what makes the launcher
 * icon look like the one on iOS instead of a bubble floating on a slab.
 */
const ICON_BACKGROUND = '#1772D3'

/** The app's own backgrounds, from design/tokens.md, so the splash hands over to
 * the first screen without a flash of a different colour. */
const SPLASH_BACKGROUND_LIGHT = '#F2F2F7'
const SPLASH_BACKGROUND_DARK = '#000000'

const config: ExpoConfig = {
  name: 'Hermie',
  slug: 'hermie',
  version: '0.1.0',
  orientation: 'default',
  scheme: 'hermie',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  icon: './assets/icon.png',
  primaryColor: ICON_BACKGROUND,
  assetBundlePatterns: ['**/*'],
  // Hermie talks to one gateway the user names and to nothing else, so there is
  // no update server to check in with. `runtimeVersion` is here anyway: if
  // expo-updates is ever added, the policy has to be decided before the first
  // build goes out, not after.
  updates: {
    enabled: false
  },
  runtimeVersion: {
    policy: 'appVersion'
  },
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: true,
    infoPlist: {
      // Everything Hermie sends goes over the platform's own HTTPS stack. Saying
      // so here is what keeps App Store Connect from asking on every upload.
      ITSAppUsesNonExemptEncryption: false
    }
  },
  android: {
    package: BUNDLE_ID,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: ICON_BACKGROUND
    },
    edgeToEdgeEnabled: true,
    // A chat client needs the network and the photo library, and that is the
    // whole list. The two blocked below are pulled in by dependencies rather
    // than asked for: nothing in the app vibrates, and nothing writes to shared
    // storage — an attachment is read, resized in memory and sent.
    permissions: ['android.permission.INTERNET'],
    blockedPermissions: ['android.permission.VIBRATE', 'android.permission.WRITE_EXTERNAL_STORAGE']
  },
  web: {
    favicon: './assets/favicon.png'
  },
  plugins: [
    'expo-secure-store',
    'expo-sqlite',
    'expo-dev-client',
    [
      // Without an explicit usage string iOS TERMINATES the app the moment the
      // photo-library permission is requested — no dialog, no crash report, the
      // app simply disappears. The camera and microphone are switched off
      // because the composer only ever picks an existing image.
      'expo-image-picker',
      {
        photosPermission: 'Hermie uses your photo library so you can attach an image to a message.',
        cameraPermission: false,
        microphonePermission: false
      }
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 180,
        resizeMode: 'contain',
        backgroundColor: SPLASH_BACKGROUND_LIGHT,
        dark: { backgroundColor: SPLASH_BACKGROUND_DARK }
      }
    ],
    [
      'expo-build-properties',
      {
        ios: {
          deploymentTarget: IOS_DEPLOYMENT_TARGET
        }
      }
    ],
    ['./plugins/with-ios-deployment-target-floor', { deploymentTarget: IOS_DEPLOYMENT_TARGET }],
    // iOS 27 refuses to launch an app built against its SDK that has not adopted the UIKit scene
    // life cycle, and SDK 54's template has not. The plugin writes the manifest; the scene delegate
    // it names lives in modules/hermie-scene.
    './plugins/with-ios-scene-lifecycle'
  ]
  // extra.eas.projectId is deliberately absent. `eas init` writes it, and it
  // ties the repository to one EAS account — a fork should get its own rather
  // than inherit ours. See docs/release.md.
}

export default config
