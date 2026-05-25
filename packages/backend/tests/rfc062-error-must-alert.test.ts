// RFC-062 PR-C — grep guard: every backend `log.error(...)` call must
// either route into a user-visible alert path or carry an explicit
// `// log-only: <reason>` annotation declaring the intent.
//
// Motivation (proposal.md §AC-6): the 2026-05-25 incident sat in
// daemon.log with `ERROR [lifecycle.invariants] open=29 errorCount=29`
// for 8 hours; no UI surface ever raised an alert. That happened
// because some `log.error` paths were intended as alert producers
// while others were "we already handled this, just record it";
// nothing distinguished the two visually, so silent ERROR-only paths
// hid in plain sight.
//
// This guard makes the distinction explicit: any `log.error(` call
// site without a co-located safe-helper (`reconcileLifecycleAlerts`
// / `tasksListBroadcaster.broadcast` / `broadcastAlert`) OR an
// adjacent `// log-only: <reason>` annotation fails the test.
// Re-routing existing ERROR-only sites is incremental — the WHITELIST
// below captures the pre-RFC-062 baseline so PR-C can land green;
// future commits should chip away at the whitelist by either wiring
// the missing alert or annotating the line.
//
// Adding a new `log.error` site to a backend src file without
// thinking about it: this guard fails immediately, forcing the
// author to choose alert path or `// log-only: …` annotation.

import { describe, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SCAN_ROOT = resolve(REPO_ROOT, 'packages', 'backend', 'src')

/** Tokens whose presence within ~8 lines of a log.error proves the
 *  error feeds a user-visible alert path. */
const ALERT_NEIGHBOR_RE =
  /reconcileLifecycleAlerts|tasksListBroadcaster\.broadcast|broadcastAlert|writeEvents\(|invariant-alert-detected/

/** Inline annotation marker accepted within ~8 lines of the call. */
const LOG_ONLY_RE = /\/\/\s*log-only:/

/** Whitelist of files we know contain pre-RFC-062 log.error sites
 *  that pre-date the alert contract and are scheduled for follow-up
 *  triage. Adding to this list requires a comment in the file or a
 *  short PR note; the guard intentionally treats whitelist growth as
 *  visible technical debt.
 *
 *  Trim this list as alert routes are wired up. Goal: empty. */
const WHITELIST_BASENAMES = new Set<string>([
  // Daemon bootstrap paths run before any alert subsystem exists; the
  // log line IS the user-visible channel for those failures.
  'start.ts',
  'stop.ts',
  'status.ts',
  // Migration / DB setup errors abort startup; the daemon log is the
  // only useful output before the HTTP server even binds.
  'client.ts',
  // Plugin / MCP / runtime probe paths log per-probe failures that
  // aggregate elsewhere; individual log.error sites are noise, not
  // alerts. Worth a follow-up pass to consolidate.
  'mcpProbe.ts',
  'plugin.ts',
  'plugin-installer.ts',
  'pluginClosure.ts',
  'runner-v2.ts',
  'runtime.ts',
  'gitRepoCache.ts',
  'gitSubmodule.ts',
  // Long-running background loops (memory distillation, GC) record
  // per-iteration failures to log; their alerts surface via separate
  // job-status routes. Coverage follow-up.
  'memoryDistiller.ts',
  'memoryDistillScheduler.ts',
  'memoryDistillJobDetail.ts',
  'memoryInject.ts',
  'gc.ts',
  'limits.ts',
  'backup.ts',
  'eventsArchive.ts',
  // Worker-side errors in the scheduler-v2 actor loop already route
  // through the events table as `attempt-finished-crash` etc.; the
  // log.error is supplementary diagnostic detail.
  'taskActor.ts',
  'taskActorTick.ts',
  'launcher.ts',
  'runnerAdapterProduction.ts',
  'task.ts',
  // Lifecycle invariants entry points already emit alerts via
  // reconcileLifecycleAlerts; the log.error is the legacy operator
  // hint. Not a violation of the contract.
  'lifecycleInvariants.ts',
])

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

describe('RFC-062 grep guard — log.error must route to alert or annotate', () => {
  test('every backend log.error site is alert-routed, annotated, or whitelisted', async () => {
    const violations: string[] = []
    const files = await walk(SCAN_ROOT)
    for (const f of files) {
      const base = f.split('/').pop() ?? ''
      if (WHITELIST_BASENAMES.has(base)) continue
      const content = await readFile(f, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (!/\blog\.error\s*\(/.test(line)) continue
        // Comment lines aren't real calls.
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

        const windowStart = Math.max(0, i - 8)
        const windowEnd = Math.min(lines.length, i + 9)
        const window = lines.slice(windowStart, windowEnd).join('\n')
        const ok = ALERT_NEIGHBOR_RE.test(window) || LOG_ONLY_RE.test(window)
        if (!ok) {
          violations.push(`${relative(REPO_ROOT, f)}:${i + 1}  ${trimmed}`)
        }
      }
    }
    if (violations.length > 0) {
      const msg =
        `RFC-062 §AC-6 grep guard violation: ${violations.length} unannotated log.error site(s).\n\n` +
        violations.join('\n') +
        `\n\nFix: either route this error into reconcileLifecycleAlerts ` +
        `/ tasksListBroadcaster.broadcast / broadcastAlert (so a user-visible alert ` +
        `lands in the UI), or add a "// log-only: <reason>" comment within 8 lines ` +
        `to document the explicit choice. If the file genuinely has no alert ` +
        `surface (daemon bootstrap, background jobs), add it to the WHITELIST_BASENAMES ` +
        `set in this file with a comment explaining why — but prefer the in-line ` +
        `annotation over expanding the whitelist.`
      throw new Error(msg)
    }
  })
})
