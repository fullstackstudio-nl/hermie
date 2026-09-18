#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { type FakeAuthMode, type Scenario, startFakeGateway } from './server'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '9119' },
    auth: { type: 'string', default: 'none' },
    token: { type: 'string' },
    'close-code': { type: 'string' },
    scenario: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    help: { type: 'boolean', default: false }
  }
})

if (values.help) {
  console.log(
    [
      'fake-gateway — a stand-in for `hermes serve`',
      '',
      '  --port <n>              listen port (default 9119)',
      '  --host <addr>           bind address (default 127.0.0.1)',
      '  --auth none|token|native  authentication mode (default none)',
      '  --token <value>         session token for --auth token',
      '  --close-code <n>        close code used when a WS upgrade fails auth (default 4401)',
      '  --scenario <file.json>  scripted prompt replies'
    ].join('\n')
  )
  process.exit(0)
}

const auth = values.auth as FakeAuthMode

if (!['none', 'token', 'native'].includes(auth)) {
  console.error(`--auth must be none, token or native (got ${values.auth}).`)
  process.exit(1)
}

let scenario: Scenario | undefined

if (values.scenario) {
  scenario = JSON.parse(readFileSync(values.scenario, 'utf8')) as Scenario
}

const gateway = await startFakeGateway({
  port: Number.parseInt(values.port ?? '9119', 10),
  host: values.host ?? '127.0.0.1',
  auth,
  ...(values.token ? { token: values.token } : {}),
  ...(values['close-code'] ? { closeCode: Number.parseInt(values['close-code'], 10) } : {}),
  ...(scenario ? { scenario } : {})
})

console.log(`fake gateway listening on ${gateway.url} (auth: ${auth})`)
console.log(`  status     ${gateway.url}/api/status`)
console.log(`  websocket  ${gateway.wsUrl}`)

if (auth === 'token') {
  console.log(`  token      ${gateway.state.token}`)
}

const shutdown = () => {
  void gateway.close().then(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
