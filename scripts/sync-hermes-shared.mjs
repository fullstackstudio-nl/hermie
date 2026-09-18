#!/usr/bin/env node
// Vendors the pure-TypeScript parts of NousResearch/hermes-agent `apps/shared`
// into packages/hermes-shared at a pinned commit.
//
//   node scripts/sync-hermes-shared.mjs          refresh the vendored copy
//   node scripts/sync-hermes-shared.mjs --check  fail if the tree has drifted
//
// The fetch-and-rewrite pipeline is implemented in M1. Until then the package
// holds no vendored sources, so --check has nothing to compare and succeeds.

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = resolve(here, '../packages/hermes-shared/upstream.json')
const check = process.argv.includes('--check')

if (!existsSync(manifest)) {
  if (check) {
    console.log('packages/hermes-shared holds no vendored sources yet — nothing to compare.')
    process.exit(0)
  }
  console.error('The vendoring pipeline is not implemented yet; it lands together with @hermes/shared.')
  console.error('See docs/adr/0003-vendor-hermes-shared.md for the agreed shape.')
  process.exit(1)
}

console.error(`${manifest} exists but this script cannot process it yet.`)
process.exit(1)
