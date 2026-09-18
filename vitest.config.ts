import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The Expo app is covered by jest-expo (`npm run test:app`); vitest owns the
    // React-free workspace packages.
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true
  }
})
