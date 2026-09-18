#!/usr/bin/env node
// Convenience wrapper around check-commit-message.mjs for a commit range.
//
//   node scripts/check-no-trailers.mjs                  (origin/main..HEAD)
//   node scripts/check-no-trailers.mjs <base>..<head>

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const checker = fileURLToPath(new URL('./check-commit-message.mjs', import.meta.url))
const range = process.argv[2] ?? 'origin/main..HEAD'

const result = spawnSync(process.execPath, [checker, '--range', range], { stdio: 'inherit' })
process.exit(result.status ?? 1)
