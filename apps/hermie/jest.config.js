module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/__tests__/**/*.test.ts?(x)', '<rootDir>/src/**/*.test.ts?(x)'],
  transformIgnorePatterns: [
    // `@noble/hashes` (PKCE, via @hermie/gateway-client) ships ESM only, so it
    // has to go through babel like the React Native packages do.
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@noble/.*|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-webview|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg))'
  ]
}
