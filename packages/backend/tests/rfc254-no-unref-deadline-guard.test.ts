// RFC-254 T32 — a deadline timer that an `await` depends on must never be
// unref'd.
//
// THE FAILURE THIS GUARDS AGAINST (measured, not theorized)
// ---------------------------------------------------------
// `unref()` tells the event loop "do not stay alive on my account". That is
// right for periodic GC ticks — and self-defeating for a deadline: when the
// timer's callback is the only thing that can settle a promise the code is
// `await`ing, unref'ing it means "if nothing else is ref'd, my own bound never
// fires". On POSIX Bun something usually keeps the loop ref'd and the hazard
// stays invisible. On Windows Bun it is fully live — this 15-line probe wedges
// `bun test` forever there (measured on Windows 11 ARM64, Bun 1.3.14, while
// the same file passes on macOS in 22ms):
//
//   test('unrefd timer still fires under bun test', async () => {
//     const won = await Promise.race([
//       new Promise<string>(() => {}),
//       new Promise<string>((resolve) => {
//         const t = setTimeout(() => resolve('timer'), 5)
//         t.unref?.()
//       }),
//     ])
//     expect(won).toBe('timer')
//   })
//
// (Deliberately NOT committed as a test — on Windows it does not fail, it
// hangs the runner.) This exact shape, via `settlesDistillerWithin`, is what
// made `memory-distiller.test.ts` freeze `bun test` mid-suite on Windows —
// twice recorded in docs/audit-backlog.md as "the whole backend suite wedges
// at 181/1033 files" before the file was isolated. A sibling escalation chain
// in runtimeSmoke.ts wedged `rfc208-boot-and-external-timeouts.test.ts` the
// same way. Worse than the hang itself: the unref'd SIGKILL escalation timers
// meant the kill a wedged child DEPENDED on silently never fired.
//
// WHAT IS AND IS NOT BANNED
// -------------------------
// Banned: `.unref` on a timer whose callback resolves/rejects a promise
// (the `setTimeout(... resolve ...)` + `.unref` pairing, at any distance the
// scanner window covers).
// Fine and untouched: unref'ing periodic housekeeping timers (GC intervals,
// reconcile ticks) and unref'ing CHILD PROCESS handles — those exist so the
// daemon can exit promptly, and nothing awaits them.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = resolve(fileURLToPath(new URL('../src', import.meta.url)))
const SKIP_DIRS = new Set(['node_modules'])

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
}

/**
 * Window scanner rather than a single-line regex: the pairing spans lines
 * (`timer = setTimeout(() => resolve(false), ms)` … `timer.unref?.()`), and in
 * the escalation-chain form the resolve sits inside a nested callback several
 * lines above the unref. A 12-line lookback window covers every real site this
 * repo has had while staying too small to bridge two unrelated constructs.
 */
function offendingLines(source: string): number[] {
  const lines = source.split(/\r?\n/)
  const hits: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/\.unref\b/.test(lines[i]!)) continue
    const from = Math.max(0, i - 12)
    const window = lines.slice(from, i + 1).join('\n')
    if (/setTimeout\(/.test(window) && /\bresolve\w*\(/.test(window)) hits.push(i + 1)
  }
  return hits
}

describe('RFC-254 — no unref on deadline timers', () => {
  const files: string[] = []
  walk(SRC_ROOT, files)

  test('the scan reaches the source tree', () => {
    expect(files.length).toBeGreaterThan(200)
    expect(files.some((f) => f.endsWith(join('services', 'memoryDistiller.ts')))).toBe(true)
  })

  test('no src file pairs setTimeout(...resolve...) with .unref', () => {
    const offenders: string[] = []
    for (const f of files) {
      for (const line of offendingLines(readFileSync(f, 'utf-8'))) {
        offenders.push(`${f.slice(SRC_ROOT.length + 1)}:${line}`)
      }
    }
    // If this fires: the timer's callback settles a promise something awaits.
    // Remove the unref and clear the timer on the settle path instead — see
    // this file's header for why the unref is not an optimization but a hang.
    expect(offenders).toEqual([])
  })

  test('no src file uses AbortSignal.timeout (second face of the same bug)', () => {
    // `AbortSignal.timeout()`'s internal timer carries unref semantics, so the
    // whole hazard above applies with no handle to keep ref'd — measured: a
    // test awaiting only its abort wedges bun test on Windows exactly like the
    // unref'd race. `util/timeoutSignal.ts` is the ref'd replacement; it also
    // fixes production ("a fetch against a black-holed host never times out on
    // an idle daemon"), which is the pinning these timeouts exist to prevent.
    const offenders: string[] = []
    for (const f of files) {
      if (f.endsWith(join('util', 'timeoutSignal.ts'))) continue
      const src = readFileSync(f, 'utf-8')
      for (const [i, line] of src.split(/\r?\n/).entries()) {
        if (line.includes('AbortSignal.timeout')) {
          offenders.push(`${f.slice(SRC_ROOT.length + 1)}:${i + 1}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('the scanner recognizes the shape it bans (self-check)', () => {
    const wedge = [
      'const p = new Promise<false>((resolve) => {',
      '  handle = setTimeout(() => resolve(false), ms)',
      '  handle.unref?.()',
      '})',
    ].join('\n')
    expect(offendingLines(wedge)).toEqual([3])

    const chain = [
      'a = setTimeout(() => {',
      '  b = setTimeout(() => {',
      '    resolveRace({ kind: "unreaped" })',
      '  }, REAP_MS)',
      '  b.unref?.()',
      '}, GRACE_MS)',
      'a.unref?.()',
    ].join('\n')
    expect(offendingLines(chain)).toEqual([5, 7])

    // A GC interval with no resolve in reach stays allowed.
    const gc = ['const t = setInterval(() => runGc(), 3_600_000)', 't.unref?.()'].join('\n')
    expect(offendingLines(gc)).toEqual([])

    // Unref'ing a child process handle stays allowed.
    const child = ['if (!reaped) {', '  input.child.unref?.()', '  return false', '}'].join('\n')
    expect(offendingLines(child)).toEqual([])
  })
})
