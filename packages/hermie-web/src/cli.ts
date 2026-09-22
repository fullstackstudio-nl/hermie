#!/usr/bin/env node
/**
 * The command line. Flags beat environment variables beat defaults; everything
 * it can be told is in `options.ts`, and this file only turns `--flags` into
 * that record, prints what it decided, and stops cleanly on a signal.
 */
import { parseArgs } from 'node:util'

import { DEFAULT_CACHE_MAX_MB } from './cache'
import { DEFAULT_GATEWAY_URL, DEFAULT_HOST, DEFAULT_PORT, describeHost, resolveOptions } from './options'
import { login } from './push/login'
import { rollback } from './update'
import { startHermieWeb } from './server'

const HELP = [
  '@hermie/web — serves Hermie in a browser and proxies one Hermes gateway',
  '',
  `  --gateway <url>      the gateway to proxy to (default ${DEFAULT_GATEWAY_URL}, env HERMIE_GATEWAY_URL)`,
  `  --port <n>           listen port (default ${DEFAULT_PORT}, env HERMIE_PORT)`,
  `  --host <addr>        bind address (default ${DEFAULT_HOST}, env HERMIE_HOST)`,
  '  --public-url <url>   the gateway’s own dashboard.public_url; written into Host and Origin',
  '                       on every proxied request (default: derived from --gateway)',
  '  --static <dir>       the exported web build (default: the bundled dist/web)',
  '  --login-return <p>   where the gateway sends the browser after a sign-in (default /,',
  '                       env HERMIE_LOGIN_RETURN). Only needed when Hermie Web and the',
  '                       gateway’s public_url differ in PORT: the callback is fixed to',
  '                       public_url, so the round trip has to be pointed back here.',
  '  --install-root <dir> where releases are unpacked and the `current` link lives',
  '  --no-self-update     refuse the self-update endpoints (env HERMIE_SELF_UPDATE=0)',
  '  --rollback           switch `current` back to the previous release and exit',
  `  --cache-max-mb <n>   disk the message cache may take (default ${String(DEFAULT_CACHE_MAX_MB)}, env HERMIE_CACHE_MAX_MB).`,
  '                       0 turns it off. The cache holds Bot Chat TAILS on this',
  '                       machine, which is what makes a chat paint the moment it',
  '                       opens on a device that has never seen it. ADR-0025.',
  '  --help',
  '',
  'Push (ADR-0017 \u2014 docs/web.md has the whole of it):',
  '',
  '  --push               also watch every Bot Chat and notify registered devices',
  '  --gateway-token <t>  the session token an ungated gateway takes (env HERMIE_GATEWAY_TOKEN)',
  '  --state-dir <dir>    watch state, VAPID keys and any stored sign-in (env HERMIE_STATE_DIR)',
  '  --vapid-subject <u>  mailto: or https: contact in the VAPID token (env HERMIE_VAPID_SUBJECT)',
  '  --push-server-requests',
  '                       ask the gateway to route approval/clarify requests to the daemon.',
  '                       ONLY if your gateway fans server requests out to every peer: on one',
  '                       that picks a single peer, the daemon receiving a question and holding',
  '                       it open takes it away from you. Off by default; open questions are',
  '                       read from the resume snapshot and an approval.pending poll instead.',
  '',
  'Built-in identity provider (ADR-0025 — off unless /admin turns it on):',
  '',
  '  --allow-insecure-oidc',
  '                       let it be enabled on an origin that is not https. The gateway',
  '                       REFUSES an issuer that is not https — loopback http it allows by',
  '                       name, so that needs no flag — which makes this useful only for',
  '                       reproducing that refusal deliberately. Not for a deployment.',
  '',
  '  hermie-web login [--provider <name>] [--redirect-port <n>]',
  '                       sign in to an OIDC-gated gateway once, for --push. Prints the',
  '                       authorisation URL and listens on a loopback redirect port.',
  '',
  'Binding to anything but a loopback address puts an unauthenticated port on the',
  'network. Put TLS in front of it — Caddy, nginx or Tailscale Serve; deploy/web/README.md',
  'has the configurations.'
].join('\n')

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    options: {
      gateway: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      'public-url': { type: 'string' },
      static: { type: 'string' },
      'login-return': { type: 'string' },
      'install-root': { type: 'string' },
      'no-self-update': { type: 'boolean', default: false },
      rollback: { type: 'boolean', default: false },
      push: { type: 'boolean', default: false },
      'gateway-token': { type: 'string' },
      'state-dir': { type: 'string' },
      'cache-max-mb': { type: 'string' },
      'vapid-subject': { type: 'string' },
      'push-server-requests': { type: 'boolean', default: false },
      'allow-insecure-oidc': { type: 'boolean', default: false },
      provider: { type: 'string' },
      'redirect-port': { type: 'string' },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: true
  })

  if (values.help) {
    console.warn(HELP)

    return
  }

  const options = resolveOptions({
    gatewayUrl: values.gateway,
    port: values.port,
    host: values.host,
    publicUrl: values['public-url'],
    staticDir: values.static,
    loginReturn: values['login-return'],
    installRoot: values['install-root'],
    gatewayToken: values['gateway-token'],
    stateDir: values['state-dir'],
    cacheMaxMb: values['cache-max-mb'],
    vapidSubject: values['vapid-subject'],
    ...(values.push ? { push: true } : {}),
    ...(values['push-server-requests'] ? { pushServerRequests: true } : {}),
    ...(values['allow-insecure-oidc'] ? { allowInsecureOidc: true } : {}),
    ...(values['no-self-update'] ? { selfUpdate: false } : {})
  })

  // A subcommand, not a flag: it is interactive, it exits when it is done, and
  // it is the one thing here that never starts a server.
  if (positionals[0] === 'login') {
    const port = values['redirect-port'] ? Number.parseInt(values['redirect-port'], 10) : undefined

    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
      throw new Error(`--redirect-port must be a number between 1 and 65535 (got ${values['redirect-port']}).`)
    }

    await login({
      gatewayUrl: options.gatewayUrl,
      stateDir: options.stateDir,
      provider: values.provider,
      ...(port === undefined ? {} : { port })
    })

    return
  }

  if (values.rollback) {
    const version = await rollback(options.installRoot)
    console.warn(`hermie-web: rolled back to ${version}. Restart the service to run it.`)

    return
  }

  const server = await startHermieWeb({
    gatewayUrl: options.gatewayUrl,
    port: options.port,
    host: options.host,
    publicUrl: options.publicUrl,
    staticDir: options.staticDir,
    loginReturn: options.loginReturn,
    installRoot: options.installRoot,
    selfUpdate: options.selfUpdate,
    push: options.push,
    gatewayToken: options.gatewayToken,
    stateDir: options.stateDir,
    cacheMaxMb: options.cacheMaxMb,
    vapidSubject: options.vapidSubject,
    pushServerRequests: options.pushServerRequests,
    allowInsecureOidc: options.allowInsecureOidc
  })

  console.warn(`hermie-web ${options.version} on http://${describeHost(options.host)}:${server.port}`)

  // ADR-0025: a process nobody has given a gateway to serves the operator setup
  // page instead of the app, and says so here rather than printing a default
  // address as though it were a decision.
  if (!server.options.gatewayConfigured) {
    console.warn('  gateway    NOT SET — open /setup to choose one. Push stays off until it is.')
  }

  console.warn(`  gateway    ${server.options.gatewayUrl}${server.options.gatewayConfigured ? '' : ' (default)'}`)
  console.warn(`  public url ${options.publicUrl} (sent as Host and Origin)`)
  console.warn(`  static     ${options.staticDir}`)
  console.warn(`  login ret  ${options.loginReturn} (the app’s next= on /auth/login)`)
  console.warn(
    options.cacheMaxMb > 0
      ? `  cache      ${String(options.cacheMaxMb)} MB in ${options.stateDir}`
      : '  cache      off (--cache-max-mb 0)'
  )

  if (options.push) {
    console.warn(`  push       on, state in ${options.stateDir}`)
    console.warn(
      options.pushServerRequests
        ? '             server requests routed here (--push-server-requests)'
        : '             open questions read from resume snapshots and approval.pending'
    )
  }

  const stop = () => {
    void server.close().then(() => process.exit(0))
  }

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((error: unknown) => {
  console.error(`hermie-web: ${String(error)}`)
  process.exit(1)
})
