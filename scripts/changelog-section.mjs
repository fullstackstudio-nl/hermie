#!/usr/bin/env node
/**
 * Prints one version's section of CHANGELOG.md, for release notes.
 *
 *   node scripts/changelog-section.mjs 0.1.0
 *   node scripts/changelog-section.mjs Unreleased
 *
 * It fails rather than printing nothing: a release whose notes quietly came out
 * empty is worse than one that did not publish.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wanted = process.argv[2]

if (!wanted) {
  console.error('usage: node scripts/changelog-section.mjs <version>')
  process.exit(2)
}

const changelog = readFileSync(resolve(repoRoot, 'CHANGELOG.md'), 'utf8')
const lines = changelog.split('\n')

// Headings look like `## [0.1.0] - 2026-09-19` or `## [Unreleased]`.
const start = lines.findIndex(line => line.startsWith(`## [${wanted}]`))

if (start === -1) {
  const found = lines.filter(line => /^##\s+\[/.test(line)).map(line => line.trim())
  console.error(`CHANGELOG.md has no section for ${wanted}.`)
  console.error(found.length > 0 ? `It has: ${found.join(', ')}` : 'It has no version sections at all.')
  process.exit(1)
}

let end = lines.length
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^##\s/.test(lines[i])) {
    end = i
    break
  }
}

// Link definitions at the foot of the file are not release notes.
const body = lines
  .slice(start + 1, end)
  .filter(line => !/^\[[^\]]+]:\s+http/.test(line))
  .join('\n')
  .trim()

if (body === '') {
  console.error(`The ${wanted} section of CHANGELOG.md is empty.`)
  process.exit(1)
}

console.log(body)
