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
    'public-host': { type: 'string' },
    scenario: { type: 'string' },
    'stream-delay': { type: 'string' },
    'history-rows': { type: 'string' },
    'no-plugin': { type: 'boolean', default: false },
    'profile-display-name': { type: 'string' },
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
      '  --auth none|token|native|cookie  authentication mode (default none)',
      '  --token <value>         session token for --auth token',
      '  --public-host <host>    enforce the Host/Origin guard against this host',
      '  --close-code <n>        close code used when a WS upgrade fails auth (default 4401)',
      '  --scenario <file.json>  scripted prompt replies',
      '  --stream-delay <ms>     delay between streamed frames (default 2, which is instant)',
      '  --history-rows <n>      extra back-history in front of every Bot Chat, in rows',
      '                          (mixed prose, code and tool calls; for measuring a long list)',
      '  --no-plugin             omit the `hermie-plugin` advert from ui_meta, staging a',
      '                          gateway with no Hermie plugin installed',
      '  --profile-display-name on|forbidden|absent  what the plugin’s display-name route does',
      '                          (default on). `absent` also drops the capability, staging a',
      '                          plugin older than the route; `forbidden` answers 403',
      '',
      'Prompts steer the built-in scenario: "approve" raises an approval request,',
      '"delegate" fans out subagent events, anything else streams a reply with a tool call.',
      '',
      'Control endpoints (not part of the gateway contract):',
      '  POST /__fake/inject  {profile, user, assistant}  inject a turn somebody else ran',
      '  POST /__fake/request {profile, method, params}   raise a server→client request,',
      '                                                   e.g. method "clarify"'
    ].join('\n')
  )
  process.exit(0)
}

const auth = values.auth as FakeAuthMode

if (!['none', 'token', 'native', 'cookie'].includes(auth)) {
  console.error(`--auth must be none, token, native or cookie (got ${values.auth}).`)
  process.exit(1)
}

const displayName = values['profile-display-name'] as 'on' | 'forbidden' | 'absent' | undefined

if (displayName && !['on', 'forbidden', 'absent'].includes(displayName)) {
  console.error(`--profile-display-name must be on, forbidden or absent (got ${displayName}).`)
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
  ...(values['public-host'] ? { publicHost: values['public-host'] } : {}),
  ...(values['stream-delay'] ? { streamDelayMs: Number.parseInt(values['stream-delay'], 10) } : {}),
  ...(values['history-rows'] ? { historyRows: Number.parseInt(values['history-rows'], 10) } : {}),
  ...(scenario ? { scenario } : {}),
  ...(values['no-plugin'] ? { plugin: false as const } : {}),
  ...(displayName ? { profileDisplayName: displayName } : {})
})

console.log(`fake gateway listening on ${gateway.url} (auth: ${auth})`)
console.log(`  status     ${gateway.url}/api/status`)
console.log(`  websocket  ${gateway.wsUrl}`)
console.log(`  inject     curl -XPOST ${gateway.url}/__fake/inject -d '{"profile":"researcher"}'`)

if (auth === 'token') {
  console.log(`  token      ${gateway.state.token}`)
}

if (auth === 'cookie') {
  console.log('  sign in    tester / hunter2 (POST /auth/password-login)')
}

const shutdown = () => {
  void gateway.close().then(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
