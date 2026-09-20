#!/usr/bin/env node
/**
 * `npm run web` — the built browser app in front of the fake gateway, for
 * development.
 *
 * Two processes and one rule. The fake gateway runs in COOKIE mode with its
 * Host/Origin guard armed against a name it will only ever see if Hermie Web
 * rewrites the headers — so the development loop exercises the same guard a
 * real `hermes serve` applies, rather than a permissive stand-in that lets a
 * broken proxy look healthy.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATEWAY_PORT = 9119
const WEB_PORT = 9120
const PUBLIC_HOST = `127.0.0.1:${GATEWAY_PORT}`

const children = []

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options })
  children.push(child)

  return child
}

const gateway = run('npx', [
  'tsx',
  'packages/fake-gateway/src/cli.ts',
  '--auth',
  'cookie',
  '--port',
  String(GATEWAY_PORT),
  '--public-host',
  PUBLIC_HOST
])

// A moment for the gateway's listener, so the first proxied request does not
// meet a closed port and print a scary line nobody needs to read.
setTimeout(() => {
  run('node', [
    'packages/hermie-web/bin/hermie-web.js',
    '--gateway',
    `http://${PUBLIC_HOST}`,
    '--port',
    String(WEB_PORT),
    '--no-self-update'
  ])
  console.warn(`\nHermie Web: http://127.0.0.1:${WEB_PORT}  (sign in as tester / hunter2)\n`)
}, 700)

const stop = () => {
  for (const child of children) {
    child.kill('SIGTERM')
  }

  process.exit(0)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
gateway.on('exit', stop)
