import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The second TypeScript project, and why this package needs one.
 *
 * `tsconfig.json` here SHIPS: unlike every other workspace it emits JavaScript,
 * because the release zip and the Docker image both run `dist/server`. That is
 * why it excludes `src/**\/*.test.ts` — the tests would otherwise be emitted
 * into `dist/server` and published with the package.
 *
 * The cost of that exclusion was found in R10c and it was total: nothing
 * type-checked the tests. A suite could construct a `PushRegistration` without
 * its `owner`, or read a mock's second argument the mock never declared, and
 * the only thing that would ever notice was vitest at runtime, on the lines it
 * happened to reach. Turning the check on found eleven of exactly those.
 *
 * So this is a build-configuration test rather than a behaviour one, and it
 * pins the three facts that together make the gate real. Any one of them
 * quietly coming undone puts the hole straight back, and nothing else in the
 * suite would fail.
 */

// `__dirname` rather than `import.meta`, because this package compiles to
// CommonJS — which the gate this file is about pointed out on its first run.
const PACKAGE = path.resolve(__dirname, '..')
const REPO = path.resolve(PACKAGE, '..', '..')

/**
 * Read a tsconfig, which is JSON with comments.
 *
 * Both files here comment on whole lines only, so dropping those is enough and
 * is worth far less than a JSON5 dependency in a package that ships.
 */
async function readTsconfig(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, 'utf8')
  const stripped = raw
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

  return JSON.parse(stripped) as Record<string, unknown>
}

describe('the shipping project', () => {
  it('still keeps the tests out of what it emits', async () => {
    const config = await readTsconfig(path.join(PACKAGE, 'tsconfig.json'))
    const options = config.compilerOptions as Record<string, unknown>

    // If this ever stops being true, the second project below is no longer
    // needed — and neither is this test. Until then it is the reason for both.
    expect(config.exclude).toContain('src/**/*.test.ts')
    expect(options.emitDeclarationOnly).toBe(false)
    expect(options.outDir).toBe('./dist/server')
  })
})

describe('the test project', () => {
  it('checks the tests and emits nothing', async () => {
    const config = await readTsconfig(path.join(PACKAGE, 'tsconfig.test.json'))
    const options = config.compilerOptions as Record<string, unknown>

    expect(config.extends).toBe('./tsconfig.json')
    expect(config.include).toContain('src/**/*.ts')
    // The whole point: the parent's exclusion is lifted.
    expect(config.exclude).toEqual([])
    expect(options.noEmit).toBe(true)
    // Not composite, so `tsc -b` cannot be talked into emitting declarations
    // for it, and so the root project reference list stays about shipping code.
    expect(options.composite).toBe(false)
  })
})

describe('the gate', () => {
  it('is run by the root typecheck script', async () => {
    const manifest = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }

    // A project nobody runs checks nothing. This is the line that turns the
    // file above into a gate.
    expect(manifest.scripts.typecheck).toContain('packages/hermie-web/tsconfig.test.json')
  })
})
