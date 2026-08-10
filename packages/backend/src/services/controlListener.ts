// RFC-254 T7 — the shutdown control listener.
//
// WHY IT EXISTS
// -------------
// `agent-workflow stop` asks the daemon to drain: finish or park in-flight
// work, then exit. On POSIX that request is a SIGTERM, and `cli/start.ts`
// handles it by running `gracefulShutdown(db, 30_000)`.
//
// Windows has no SIGTERM. Node accepts the NAME — `process.kill(pid,
// 'SIGTERM')` does not throw — but it maps to `TerminateProcess`, the same
// hard kill as SIGKILL. So on Windows the old `stop` looked like it worked
// while actually killing the daemon mid-write: no drain, no task bookkeeping,
// and the next start finds `interrupted` rows it has to reap. The failure is
// silent in exactly the way that matters — the command prints "stopped".
//
// So the graceful request needs a transport the platform does have. This is it:
// one loopback listener, one operation.
//
// WHAT IT IS NOT
// --------------
// It is deliberately NOT a route on the business app. That app is reachable
// from `bindHost` (which an operator may set to a LAN address) and carries the
// whole authenticated API surface; adding "kill the daemon" to it would put a
// denial-of-service verb behind whatever that surface's weakest path is. This
// listener binds 127.0.0.1 only, on an ephemeral port, and answers exactly one
// route.
//
// AUTHENTICATION
// --------------
// A nonce minted at startup, written to a private control file, and never
// reused. Possession of the file is the authorization — which is the same
// property the lock file already relies on, and the file is written with the
// same private-mode discipline as `token` / `secret.key` (POSIX 0600; on
// Windows the inherited ACL of a per-user directory, asserted through the
// RFC-254 file-trust primitive rather than assumed).
//
// The nonce is a NEW at-rest secret. It is registered in the secret inventory
// alongside the others; it dies with the process, and a stale file is refused
// by the listener that no longer exists rather than by an expiry check.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { platformSpawnOptions } from '@/util/platformExec'
import { timeoutSignal } from '@/util/timeoutSignal'

/** What the control file carries. Written by `start`, read by `stop`. */
export interface ControlEndpoint {
  /** Loopback URL of the control listener, e.g. `http://127.0.0.1:53124`. */
  url: string
  /** Single-use-per-process shutdown authorization. */
  nonce: string
  /** The daemon's pid, so `stop` can fall back without re-reading the lock. */
  pid: number
  /** Whether another Bun dev-watch generation may request a graceful handoff. */
  devWatch?: true
}

export interface ControlListener {
  /** The endpoint written to the control file. */
  endpoint: ControlEndpoint
  /** Stop listening and remove the control file. Idempotent. */
  close: () => void
}

/**
 * Serve the control endpoint and publish it.
 *
 * `onShutdown` is invoked at most once, after the response has been handed
 * back — the caller gets an acknowledgement rather than a connection reset
 * halfway through the drain.
 */
export function startControlListener(options: {
  controlFilePath: string
  onShutdown: () => void
  /** Advertise that this daemon belongs to the package's Bun dev watcher. */
  devWatch?: boolean
  /** Injected for tests; defaults to the real platform. */
  platform?: NodeJS.Platform
}): ControlListener {
  const platform = options.platform ?? process.platform
  const nonce = randomBytes(32).toString('hex')
  let fired = false

  const server = Bun.serve({
    // Loopback ONLY, and an ephemeral port: this endpoint is addressed through
    // the control file, never discovered.
    hostname: '127.0.0.1',
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url)
      if (request.method !== 'POST' || url.pathname !== '/shutdown') {
        return new Response('not found\n', { status: 404 })
      }
      // Constant-time compare: the nonce is the whole authorization, and a
      // length-or-prefix leak is a real one on a loopback socket an unprivileged
      // local process can also reach.
      const presented = request.headers.get('x-agent-workflow-control') ?? ''
      if (!constantTimeEquals(presented, nonce)) {
        return new Response('unauthorized\n', { status: 401 })
      }
      if (!fired) {
        fired = true
        // AFTER the response is constructed, so `stop` sees an acknowledgement
        // rather than a reset mid-drain.
        queueMicrotask(options.onShutdown)
      }
      return new Response('draining\n', { status: 202 })
    },
  })

  // Derived from what the server ACTUALLY bound, not from the constant above.
  // Hardcoding `127.0.0.1` here made the published URL a claim rather than an
  // observation: changing `hostname` to `0.0.0.0` left the endpoint still
  // saying loopback, and nothing could tell.
  const endpoint: ControlEndpoint = {
    url: `http://${server.hostname}:${server.port}`,
    nonce,
    pid: process.pid,
    ...(options.devWatch === true ? { devWatch: true as const } : {}),
  }
  writeControlFile(options.controlFilePath, endpoint, platform)

  return {
    endpoint,
    close: () => {
      try {
        server.stop(true)
      } catch {
        /* already stopped */
      }
      removeControlFile(options.controlFilePath)
    },
  }
}

/**
 * Write the control file privately.
 *
 * `mode` is honoured on POSIX and ignored on Windows, where confidentiality
 * comes from the ACL the per-user app home already carries. That difference is
 * stated rather than silently relied on: `doctor` reports which protection is
 * in force (RFC-254 D19), and the file-trust primitive is what verifies it.
 */
export function writeControlFile(
  path: string,
  endpoint: ControlEndpoint,
  platform: NodeJS.Platform,
): void {
  const payload = `${JSON.stringify(endpoint, null, 2)}\n`
  if (platform === 'win32') {
    writeFileSync(path, payload, { encoding: 'utf-8' })
    return
  }
  writeFileSync(path, payload, { encoding: 'utf-8', mode: 0o600 })
}

/** Read the control file, or null when it is absent or unreadable. */
export function readControlFile(path: string, contents?: string): ControlEndpoint | null {
  try {
    // `readFileSync`, not `Bun.file().text()`: the latter returns a PROMISE and
    // this function is synchronous, so the parse silently saw a non-string and
    // every read came back null. `stop` would then have reported "no control
    // endpoint" against a perfectly good file.
    const raw = contents ?? (existsSync(path) ? readFileSync(path, 'utf8') : null)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const candidate = parsed as Partial<ControlEndpoint>
    if (typeof candidate.url !== 'string' || candidate.url.length === 0) return null
    if (typeof candidate.nonce !== 'string' || candidate.nonce.length === 0) return null
    if (typeof candidate.pid !== 'number' || !Number.isInteger(candidate.pid)) return null
    // Loopback only, always — a control file naming any other host is either
    // corrupt or planted, and either way must not be POSTed to.
    if (!candidate.url.startsWith('http://127.0.0.1:')) return null
    if (candidate.devWatch !== undefined && candidate.devWatch !== true) return null
    return {
      url: candidate.url,
      nonce: candidate.nonce,
      pid: candidate.pid,
      ...(candidate.devWatch === true ? { devWatch: true as const } : {}),
    }
  } catch {
    return null
  }
}

export function removeControlFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* already gone */
  }
}

/**
 * Ask a running daemon to drain.
 *
 * Returns `'accepted'` when the daemon acknowledged, `'unauthorized'` when the
 * nonce was refused (a stale control file whose daemon has been replaced), and
 * `'unreachable'` when nothing answered.
 */
export async function requestShutdown(
  endpoint: ControlEndpoint,
  timeoutMs = 5_000,
): Promise<'accepted' | 'unauthorized' | 'unreachable'> {
  // RFC-254: ref'd timeout — the platform timeout signal never fires on Windows Bun
  // when the loop is otherwise idle (see util/timeoutSignal.ts). This is the
  // `stop` CLI's channel, exactly the process most likely to have an idle loop.
  const deadline = timeoutSignal(timeoutMs)
  try {
    const response = await fetch(`${endpoint.url}/shutdown`, {
      method: 'POST',
      headers: { 'x-agent-workflow-control': endpoint.nonce },
      signal: deadline.signal,
    })
    if (response.status === 202) return 'accepted'
    if (response.status === 401) return 'unauthorized'
    return 'unreachable'
  } catch {
    return 'unreachable'
  } finally {
    deadline.cancel()
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  // Compare over a fixed width so the loop count does not depend on the input.
  const width = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < width; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

/**
 * The last-resort kill for `stop` when the graceful request did not land.
 *
 * Separated so the caller can say plainly that what happened was NOT a graceful
 * shutdown — the old code path could not tell the difference, and on Windows it
 * silently only ever did this.
 */
export function hardKillCommand(pid: number, platform: NodeJS.Platform): string[] | null {
  if (platform !== 'win32') return null
  return ['taskkill', '/PID', String(pid), '/T', '/F']
}

/** Run the hard kill. Returns whether the command reported success. */
export function hardKill(pid: number, platform: NodeJS.Platform): boolean {
  const cmd = hardKillCommand(pid, platform)
  if (cmd === null) return false
  try {
    const result = Bun.spawnSync(cmd, {
      ...platformSpawnOptions(platform),
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return result.exitCode === 0
  } catch {
    return false
  }
}
