/**
 * First run: the one moment an OPERATOR is asked something, and the only path
 * by which a Hermie Web that has no gateway acquires one.
 *
 * [ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md) is the
 * decision this file implements. A reader of the browser build should see a
 * sign-in and nothing else; the gateway address, the probe and the service
 * login are an operator's work and they happen once. `hermie-web login` already
 * did the last of those from a terminal — this is the same flow with the
 * loopback listener replaced by a route on this server, for the operator who
 * has a browser and not a shell on the machine.
 *
 * ## What is NOT relaxed here
 *
 * `options.ts` says the gateway is fixed at process start, and it still is.
 * There is exactly ONE transition — unconfigured to configured — it happens at
 * most once in a process's life, and there is no route back. A configured
 * Hermie Web answers 404 on every path in this file, so a browser can no more
 * steer it than it could before. That the window exists at all is the cost
 * ADR-0025 writes down: while nothing is configured, whoever reaches the port
 * first can point the proxy somewhere, which is why the default bind is still
 * `127.0.0.1` and why an operator who passes `--gateway` never opens the window
 * at all.
 *
 * ## Why the probe is written again here
 *
 * `packages/gateway-client/src/probe.ts` is the specification for
 * `/api/status` and `/api/auth/providers`, and this file deliberately mirrors
 * it rather than importing it, for the same packaging reason `link.ts` and
 * `credentials.ts` give: the released artefact is a self-contained CommonJS
 * `dist/server` with no `node_modules` beside it. Where the two disagree, that
 * package is right and this one is the bug.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import path from 'node:path'

/** The file inside the state directory that makes the next start a configured one. */
export const SETUP_FILE = 'setup.json'

/** Bumped when a reader could not safely take an older file. */
export const SETUP_VERSION = 1

export interface SavedSetup {
  gatewayUrl: string
  /** The gateway's own `dashboard.public_url`; empty means "derive it from the gateway". */
  publicUrl: string
  /** Unix seconds, so a log line can say when this deployment was set up. */
  savedAt: number
}

export interface SetupProvider {
  name: string
  displayName: string
  supportsPassword: boolean
}

/**
 * What one probe of a candidate gateway answers.
 *
 * `authFlows` is the field the browser build actually needs: it is what lets
 * the wizard skip its own probe and open on the sign-in step knowing whether
 * this gateway takes a cookie, a password or nothing at all.
 */
export interface SetupProbe {
  version: string
  authRequired: boolean
  authFlows: string[]
  providers: SetupProvider[]
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** How long a probe waits for one answer. The same ten seconds the app's probe allows. */
export const PROBE_TIMEOUT_MS = 10_000

/**
 * Read the saved setup, or `null`.
 *
 * Every failure is the same answer — no setup — because the consequence is a
 * setup page an operator can fill in again, and the alternative is a process
 * that refuses to start over a file it could have ignored.
 */
export async function readSetup(stateDir: string): Promise<SavedSetup | null> {
  let parsed: Record<string, unknown>

  try {
    parsed = JSON.parse(await readFile(path.join(stateDir, SETUP_FILE), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }

  if (typeof parsed?.v !== 'number' || parsed.v !== SETUP_VERSION) {
    return null
  }

  const gatewayUrl = str(parsed.gatewayUrl)

  if (!gatewayUrl) {
    return null
  }

  return {
    gatewayUrl,
    publicUrl: str(parsed.publicUrl),
    savedAt: typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0
  }
}

/**
 * Write the setup atomically, `0600` inside a `0700` directory.
 *
 * It sits beside the push state and is held to the same standard: it is not a
 * credential, but it decides where every credential in that directory will be
 * spent, and a half-written file would leave a process pointing at a truncated
 * URL.
 */
export async function writeSetup(stateDir: string, setup: SavedSetup): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700).catch(() => undefined)

  const target = path.join(stateDir, SETUP_FILE)
  const temporary = `${target}.${process.pid}.tmp`

  await writeFile(temporary, `${JSON.stringify({ v: SETUP_VERSION, ...setup }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  await chmod(temporary, 0o600).catch(() => undefined)
  await rename(temporary, target)
}

/**
 * Coerce what an operator typed into a gateway URL, or throw with a name on it.
 *
 * A bare host is read as `http://` rather than `https://`, which is the
 * opposite of what the app's own address step does — and deliberately: this
 * page is filled in on the machine the gateway runs on, where the answer is
 * nearly always a loopback address that has no certificate
 * ([ADR-0014](../../../docs/adr/0014-plain-http-on-private-networks.md)). An
 * operator who means TLS types the scheme, and the probe that follows tells
 * them within a second if they were wrong either way.
 */
export function normalizeGatewayInput(raw: string): string {
  const trimmed = raw.trim()

  if (!trimmed) {
    throw new Error('Enter the gateway address.')
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL

  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`${raw} is not an address.`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${raw} is not an http or https address.`)
  }

  // A trailing slash is kept when the gateway is served under a path prefix,
  // because `gatewayApiUrl` appends to it; a bare origin keeps none.
  return url.pathname === '/' ? url.origin : `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>

  return { status: response.status, body }
}

/**
 * Read a candidate gateway's public surface: `/api/status`, and the provider
 * list when it says it is gated.
 *
 * Unauthenticated by definition — this runs before anybody has signed in to
 * anything — and every failure is phrased for somebody standing at a setup
 * page, not for a log.
 */
export async function probeGateway(gatewayUrl: string, fetchImpl: typeof fetch = fetch): Promise<SetupProbe> {
  const base = gatewayUrl.replace(/\/+$/, '')
  let status: { status: number; body: Record<string, unknown> }

  try {
    status = await getJson(`${base}/api/status`, fetchImpl)
  } catch (error) {
    throw new Error(`${base} did not answer: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (status.status === 404) {
    throw new Error(`${base}/api/status does not exist — that address is not a Hermes gateway.`)
  }

  if (status.status === 401 || status.status === 403) {
    throw new Error(
      `${base}/api/status is behind an access proxy (HTTP ${status.status}). Hermie Web cannot carry that ` +
        'proxy’s credential; put Hermie Web inside the perimeter instead.'
    )
  }

  if (status.status !== 200) {
    throw new Error(`${base}/api/status answered HTTP ${status.status}.`)
  }

  if (typeof status.body.auth_required !== 'boolean') {
    throw new Error(`${base}/api/status answered JSON without "auth_required" — not a Hermes gateway.`)
  }

  const authFlows = Array.isArray(status.body.auth_flows)
    ? status.body.auth_flows.filter((entry): entry is string => typeof entry === 'string')
    : []
  const probe: SetupProbe = {
    version: str(status.body.version),
    authRequired: status.body.auth_required,
    authFlows,
    providers: []
  }

  if (!probe.authRequired) {
    return probe
  }

  return { ...probe, providers: await probeProviders(base, fetchImpl) }
}

async function probeProviders(base: string, fetchImpl: typeof fetch): Promise<SetupProvider[]> {
  let answer: { status: number; body: Record<string, unknown> }

  try {
    answer = await getJson(`${base}/api/auth/providers`, fetchImpl)
  } catch {
    // A gated gateway whose provider list is unreachable is still a gateway.
    // The sign-in step says "no providers" rather than the setup failing.
    return []
  }

  // 503 is what the gateway answers when its provider scan finds nothing
  // usable — a configuration story, not a transport failure.
  if (answer.status !== 200) {
    return []
  }

  const rows = Array.isArray(answer.body.providers) ? answer.body.providers : []

  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map(row => ({
      name: str(row.name),
      displayName: str(row.display_name) || str(row.name),
      supportsPassword: row.supports_password === true
    }))
    .filter(provider => provider.name.length > 0)
}

/**
 * The absolute address a browser reached THIS server on.
 *
 * It has to be built from the request rather than from `--host`/`--port`,
 * because the operator may well be on the other side of a reverse proxy or a
 * tailnet name, and the redirect URI handed to an identity provider must be the
 * one the browser can actually come back to. `X-Forwarded-Proto` and
 * `X-Forwarded-Host` are read first for exactly that reason, the same way
 * `proxy.ts` reads the former.
 */
export function ownOrigin(request: IncomingMessage): string {
  const header = (name: string): string => {
    const raw = request.headers[name]
    const first = Array.isArray(raw) ? raw[0] : raw

    return (first ?? '').split(',')[0]?.trim() ?? ''
  }

  const socket = request.socket as { encrypted?: boolean }
  const proto = header('x-forwarded-proto') || (socket.encrypted === true ? 'https' : 'http')
  const host = header('x-forwarded-host') || String(request.headers.host ?? '127.0.0.1')

  return `${proto}://${host}`
}

/** Where the gateway sends the operator's browser back at the end of the service login. */
export const SETUP_CALLBACK_PATH = '/hermie/setup/callback'

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    character =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? /* c8 ignore next */ ''
  )

/**
 * A small standalone page, with its script inline.
 *
 * Inline because this page is served BEFORE anything is configured, which is
 * also before the static build is guaranteed to be on disk — a release zip is
 * unpacked with it, but a `--static` pointed at nothing is exactly the state an
 * operator is in when they most need this page to work. It carries no external
 * request of any kind.
 */
export function setupPage(options: { version: string; defaultGateway: string }): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up Hermie Web</title>
<style>
  :root { color-scheme: light dark; --ink: #16181d; --muted: #5d636e; --line: #d9dce2; --bg: #f6f7f9; --card: #fff; --accent: #2f6df6; --bad: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --ink: #eceef2; --muted: #9aa1ad; --line: #2c3038; --bg: #101216; --card: #181b21; } }
  * { box-sizing: border-box }
  body { font: 16px/1.55 system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--ink) }
  main { max-width: 36rem; margin: 0 auto; padding: 2.5rem 1rem 4rem }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem }
  h2 { font-size: 1rem; margin: 0 0 .5rem }
  p { color: var(--muted); margin: .25rem 0 1rem }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem; margin: 1.25rem 0 }
  label { display: block; font-size: .85rem; color: var(--muted); margin-bottom: .35rem }
  input { width: 100%; font: inherit; padding: .6rem .7rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: inherit }
  button { font: inherit; padding: .6rem 1rem; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer }
  button[disabled] { opacity: .5; cursor: default }
  .row { display: flex; gap: .6rem; align-items: flex-end; margin-bottom: .75rem }
  .row > div { flex: 1 }
  .note { font-size: .85rem }
  .bad { color: var(--bad) }
  code { font-family: ui-monospace, monospace; font-size: .9em }
  ol { color: var(--muted); padding-left: 1.2rem }
</style>
<main>
  <h1>Set up Hermie Web</h1>
  <p>This page exists once. When the gateway is saved it answers 404, and everybody else only ever sees a sign-in.</p>

  <section>
    <h2>1. The gateway</h2>
    <p>The Hermes gateway this server proxies. It is fixed once it is saved.</p>
    <div class="row">
      <div>
        <label for="gateway">Address</label>
        <input id="gateway" value="${escapeHtml(options.defaultGateway)}" spellcheck="false" autocapitalize="off">
      </div>
      <button id="probe" type="button">Probe</button>
    </div>
    <p class="note" id="probe-result"></p>
  </section>

  <section id="login-card" hidden>
    <h2>2. The service login</h2>
    <p>
      One sign-in that belongs to this <em>server</em>, not to you. Hermie Web spends it on a gateway
      connection of its own, and uses that connection for two things: push notifications, and the message
      cache that makes a chat paint the moment it opens. It is not the sign-in the app will ask you for.
    </p>
    <p class="note">
      Optional here. Without it the app still works; push and the cache do not. You can also do it from a
      terminal with <code>hermie-web login</code>, which is the route to take if your provider will not
      accept this server's own address as a redirect.
    </p>
    <div class="row">
      <div>
        <label for="provider">Provider</label>
        <input id="provider" placeholder="leave empty for the gateway's default" spellcheck="false">
      </div>
      <button id="login" type="button">Sign in</button>
    </div>
    <p class="note" id="login-result"></p>
  </section>

  <section id="save-card" hidden>
    <h2>3. Save</h2>
    <p>Saving writes the gateway to this server's state directory and closes this page for good.</p>
    <button id="save" type="button">Save and finish</button>
    <p class="note" id="save-result"></p>
  </section>

  <p class="note">Hermie Web ${escapeHtml(options.version)}</p>
</main>
<script>
(function () {
  var probed = null;
  var $ = function (id) { return document.getElementById(id) };
  var say = function (id, text, bad) { var el = $(id); el.textContent = text; el.className = bad ? 'note bad' : 'note' };

  var post = function (path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j } }) });
  };

  $('probe').addEventListener('click', function () {
    var address = $('gateway').value;
    say('probe-result', 'Probing ' + address + ' …');
    $('probe').disabled = true;
    post('/hermie/setup/probe', { gateway: address }).then(function (answer) {
      $('probe').disabled = false;
      if (!answer.ok) { probed = null; say('probe-result', answer.body.detail || 'That did not work.', true); return }
      probed = answer.body.gateway;
      $('gateway').value = probed;
      var p = answer.body.probe;
      var flows = p.authRequired ? p.authFlows.join(', ') : 'no sign-in required';
      say('probe-result', 'Hermes ' + (p.version || '?') + ' — ' + flows + '.');
      $('login-card').hidden = !p.authRequired;
      $('save-card').hidden = false;
    }, function (error) {
      $('probe').disabled = false;
      say('probe-result', String(error), true);
    });
  });

  $('login').addEventListener('click', function () {
    if (!probed) { return }
    say('login-result', 'Asking the gateway for a sign-in address …');
    post('/hermie/setup/login', { gateway: probed, provider: $('provider').value }).then(function (answer) {
      if (!answer.ok) { say('login-result', answer.body.detail || 'That did not work.', true); return }
      window.location.assign(answer.body.authorizeUrl);
    }, function (error) { say('login-result', String(error), true) });
  });

  $('save').addEventListener('click', function () {
    if (!probed) { return }
    $('save').disabled = true;
    say('save-result', 'Saving …');
    post('/hermie/setup/save', { gateway: probed }).then(function (answer) {
      if (!answer.ok) { $('save').disabled = false; say('save-result', answer.body.detail || 'That did not work.', true); return }
      say('save-result', 'Saved. Opening Hermie …');
      window.location.assign('/');
    }, function (error) { $('save').disabled = false; say('save-result', String(error), true) });
  });

  if (new URLSearchParams(window.location.search).get('signedin') === '1') {
    $('probe').click();
    say('login-result', 'The service login was stored.');
  }
})();
</script>
</html>
`
}

/** The small page the gateway's redirect lands on at the end of the service login. */
export function setupCallbackPage(title: string, detail: string): string {
  return (
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font:16px/1.55 system-ui,sans-serif;margin:4rem auto;max-width:34rem;padding:0 1rem">` +
    `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>` +
    `<p><a href="/setup?signedin=1">Back to setup</a></p></body></html>`
  )
}
