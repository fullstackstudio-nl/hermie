module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/__tests__/**/*.test.tsx', '<rootDir>/src/**/*.test.tsx'],
  transformIgnorePatterns: [
    // `@noble/hashes` (PKCE, via @hermie/gateway-client) ships ESM only, so it
    // has to go through babel like the React Native packages do.
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@noble/.*|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg))'
  ]
}
