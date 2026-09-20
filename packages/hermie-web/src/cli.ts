#!/usr/bin/env node
/**
 * The command line. Flags beat environment variables beat defaults; everything
 * it can be told is in `options.ts`, and this file only turns `--flags` into
 * that record, prints what it decided, and stops cleanly on a signal.
 */
import { parseArgs } from 'node:util'

import { DEFAULT_GATEWAY_URL, DEFAULT_HOST, DEFAULT_PORT, describeHost, resolveOptions } from './options'
import { rollback } from './update'
import { startHermieWeb } from './server'

const HELP = [
  'hermie-web — serves Hermie in a browser and proxies one Hermes gateway',
  '',
  `  --gateway <url>      the gateway to proxy to (default ${DEFAULT_GATEWAY_URL}, env HERMIE_GATEWAY_URL)`,
  `  --port <n>           listen port (default ${DEFAULT_PORT}, env HERMIE_PORT)`,
  `  --host <addr>        bind address (default ${DEFAULT_HOST}, env HERMIE_HOST)`,
  '  --public-url <url>   the gateway’s own dashboard.public_url; written into Host and Origin',
  '                       on every proxied request (default: derived from --gateway)',
  '  --static <dir>       the exported web build (default: the bundled dist/web)',
  '  --install-root <dir> where releases are unpacked and the `current` link lives',
  '  --no-self-update     refuse the self-update endpoints (env HERMIE_SELF_UPDATE=0)',
  '  --rollback           switch `current` back to the previous release and exit',
  '  --help',
  '',
  'Binding to anything but a loopback address puts an unauthenticated port on the',
  'network. Put TLS in front of it — Caddy, nginx or Tailscale Serve; deploy/web/README.md',
  'has the configurations.'
].join('\n')

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      gateway: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      'public-url': { type: 'string' },
      static: { type: 'string' },
      'install-root': { type: 'string' },
      'no-self-update': { type: 'boolean', default: false },
      rollback: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
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
    installRoot: values['install-root'],
    ...(values['no-self-update'] ? { selfUpdate: false } : {})
  })

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
    installRoot: options.installRoot,
    selfUpdate: options.selfUpdate
  })

  console.warn(`hermie-web ${options.version} on http://${describeHost(options.host)}:${server.port}`)
  console.warn(`  gateway    ${options.gatewayUrl}`)
  console.warn(`  public url ${options.publicUrl} (sent as Host and Origin)`)
  console.warn(`  static     ${options.staticDir}`)

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
