import type { ExpoConfig } from 'expo/config'

const BUNDLE_ID = 'nl.fullstackstudio.hermie'
const IOS_DEPLOYMENT_TARGET = '15.1'

const config: ExpoConfig = {
  name: 'Hermie',
  slug: 'hermie',
  version: '0.1.0',
  orientation: 'default',
  scheme: 'hermie',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  icon: './assets/icon.png',
  assetBundlePatterns: ['**/*'],
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: true
  },
  android: {
    package: BUNDLE_ID,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0B0D10'
    },
    edgeToEdgeEnabled: true
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
        backgroundColor: '#FFFFFF',
        dark: { backgroundColor: '#0B0D10' }
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
    ['./plugins/with-ios-deployment-target-floor', { deploymentTarget: IOS_DEPLOYMENT_TARGET }]
  ]
}

export default config
