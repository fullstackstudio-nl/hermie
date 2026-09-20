#!/usr/bin/env node
// The published entry point. Everything real is in dist/server; this file only
// exists so `npx hermie-web` and the Docker ENTRYPOINT have something stable to
// point at, and so a missing build fails with a sentence rather than a stack.
'use strict'

try {
  require('../dist/server/cli.js')
} catch (error) {
  if (error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes('dist/server')) {
    console.error('hermie-web: this package has not been built. Run `npm run web:build` in the repository first.')
    process.exit(1)
  }

  throw error
}
