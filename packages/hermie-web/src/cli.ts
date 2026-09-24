#!/usr/bin/env node
/**
 * The command line. Flags beat environment variables beat defaults; everything
 * it can be told is in `options.ts`, and this file only turns `--flags` into
 * that record, prints what it decided, and stops cleanly on a signal.
 */
import { parseArgs } from 'node:util'

import { HELP } from './help'
import { describeHost, resolveOptions } from './options'
import { login } from './push/login'
import { rollback } from './update'
import { startHermieWeb } from './server'

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
    console.warn(
      '  gateway    NOT SET — open /setup to choose one, or restart with --gateway <url>' +
        ' (env HERMIE_GATEWAY_URL). Push stays off until it is.'
    )
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
