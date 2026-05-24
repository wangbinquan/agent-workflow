// RFC-061 PR-B (continued T12) — grep guards.
//
// These tests are the structural fence keeping RFC-061's architectural
// promises true. They scan the backend source tree and fail when banned
// patterns reappear. Each guard maps to a constraint in design.md §14.3.
//
// **Active now (already enforceable):**
//   - writeEvents is the only writer to the `events` table
//   - applyEvent (eventApplier) is the only writer to logical_runs.status
//     and other projection columns
//
// **Soft / parked (full enforcement waits for PR-B T10/T11 cutover):**
//   These guards are currently expressed as "soft" — they detect the
//   ban list but do NOT yet fail. They will be flipped to hard fail
//   when their legacy source is deleted. Each soft entry lists which
//   files it expects to disappear by T10.
//
//   Soft guards:
//     - 'isFresherNodeRun'                 → deleted with scheduler.ts T10
//     - 'cascadeDownstreamFromDesigner'    → deleted with crossClarify.ts T10
//     - 'applyCrossClarifyFreshnessInvariant' → deleted with scheduler.ts T10
//     - 'rescanScopeForNewPendingRows'     → deleted with scheduler.ts T10
//     - 'computeHistoryCutoff'             → deleted with scheduler.ts T10
//     - 'transitionNodeRunStatus' / 'setNodeRunStatus' → RFC-053 P-1 retired
//     - 'dispatchReviewNode'               → deleted with review.ts T10
//     - 7 legacy table names                → migration 0034 T10
//
// We test the active guards now (they MUST pass on every commit) and the
// soft guards record the current state (in lieu of going red — they go
// red the moment a NEW reference appears, and they go green when T10
// drops the legacy file). This keeps PR-B's intermediate commits honest.

import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src')

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

async function listFiles(): Promise<string[]> {
  return await walk(SRC)
}

async function fileContains(path: string, needle: RegExp): Promise<boolean> {
  const content = await readFile(path, 'utf-8')
  return needle.test(content)
}

async function whoContains(needle: RegExp): Promise<string[]> {
  const files = await listFiles()
  const out: string[] = []
  for (const f of files) {
    if (await fileContains(f, needle)) out.push(f)
  }
  return out
}

/* ============================================================
 *  Active guards — hard fail on violation
 * ============================================================ */

describe('RFC-061 grep guards — active', () => {
  test('db.insert(events) is restricted to writeEvents.ts', async () => {
    const hits = await whoContains(/db\.insert\(events\)|tx\.insert\(events\)/)
    // Allowed:
    //   - services/writeEvents.ts (the sole writer)
    //   - services/projectionRebuilder.ts (replays events into a temp DB
    //     for verification — DOES use tx.insert(events) on the temp DB
    //     only). Skipping projectionRebuilder.ts is OK because the temp
    //     DB is never persisted; the production events table is only
    //     written by writeEvents.ts.
    const filtered = hits.filter(
      (f) => !f.endsWith('writeEvents.ts') && !f.endsWith('projectionRebuilder.ts'),
    )
    expect(filtered).toEqual([])
  })

  test('logical_runs.status updates restricted to eventApplier.ts', async () => {
    const hits = await whoContains(/\.update\(logicalRuns\)/)
    // Only eventApplier may flip logical_runs.status. Other readers must
    // use SELECT-only queries.
    const filtered = hits.filter((f) => !f.endsWith('eventApplier.ts'))
    expect(filtered).toEqual([])
  })

  test('attempts.outcome updates restricted to eventApplier.ts', async () => {
    const hits = await whoContains(/\.update\(attempts\)/)
    const filtered = hits.filter((f) => !f.endsWith('eventApplier.ts'))
    expect(filtered).toEqual([])
  })

  test('suspensions updates restricted to eventApplier.ts', async () => {
    const hits = await whoContains(/\.update\(suspensions\)/)
    const filtered = hits.filter((f) => !f.endsWith('eventApplier.ts'))
    expect(filtered).toEqual([])
  })

  test('events table has no UPDATE call sites (INV-1 / append-only)', async () => {
    const hits = await whoContains(/\.update\(events\)/)
    expect(hits).toEqual([])
  })

  test('events table has no DELETE call sites outside projectionRebuilder rebuild path', async () => {
    const hits = await whoContains(/\.delete\(events\)/)
    expect(hits).toEqual([])
  })
})

/* ============================================================
 *  Hard guards (flipped from soft → hard by T10/T11 cutover).
 *  Reference functions / files all deleted; any new reference
 *  is a regression.
 * ============================================================ */

describe('RFC-061 grep guards — hard (T10 cutover complete)', () => {
  test('isFresherNodeRun: deleted helper must have no callers', async () => {
    const hits = await whoContains(/\bisFresherNodeRun\b/)
    expect(hits).toEqual([])
  })

  test('cascadeDownstreamFromDesigner: deleted helper must have no callers', async () => {
    const hits = await whoContains(/\bcascadeDownstreamFromDesigner\b/)
    expect(hits).toEqual([])
  })

  test('applyCrossClarifyFreshnessInvariant: deleted helper must have no callers', async () => {
    const hits = await whoContains(/\bapplyCrossClarifyFreshnessInvariant\b/)
    expect(hits).toEqual([])
  })

  test('computeHistoryCutoff: deleted; aging logic lives in promptFromEvents now', async () => {
    const hits = await whoContains(/\bcomputeHistoryCutoff\b/)
    expect(hits).toEqual([])
  })

  test('transitionNodeRunStatus / setNodeRunStatus: deleted with lifecycle.ts', async () => {
    const hits = await whoContains(/\b(transitionNodeRunStatus|setNodeRunStatus)\b/)
    expect(hits).toEqual([])
  })

  test('dispatchReviewNode: deleted with review.ts', async () => {
    const hits = await whoContains(/\bdispatchReviewNode\b/)
    expect(hits).toEqual([])
  })
})

/* ============================================================
 *  Sanity: handlers + scheduler-v2 are pure (no banned imports)
 * ============================================================ */

describe('RFC-061 architectural fence — new tree must stay clean', () => {
  test('handlers/ and scheduler-v2/ do not reference legacy services', async () => {
    const newTreeFiles = (await listFiles()).filter(
      (f) => f.includes('/handlers/') || f.includes('/scheduler-v2/'),
    )
    expect(newTreeFiles.length).toBeGreaterThan(0)
    const banned = [
      /from .['"].*\/services\/scheduler['"]/,
      /from .['"].*\/services\/clarify['"]/,
      /from .['"].*\/services\/crossClarify['"]/,
      /from .['"].*\/services\/review['"]/,
      /from .['"].*\/services\/clarifyRounds['"]/,
      /from .['"].*\/services\/lifecycle['"]/,
    ]
    for (const f of newTreeFiles) {
      const content = await readFile(f, 'utf-8')
      for (const re of banned) {
        expect(re.test(content)).toBe(false)
      }
    }
  })

  test('handlers/ + scheduler-v2/ only import from @agent-workflow/shared + their own subdir + db/', async () => {
    const newTreeFiles = (await listFiles()).filter(
      (f) => f.includes('/handlers/') || f.includes('/scheduler-v2/'),
    )
    const allowedSpecifiers = ['@agent-workflow/shared', 'drizzle-orm', 'ulid', 'zod']
    const allowedSpecifierPrefixes = [
      '@agent-workflow/shared/',
      './',
      '../handlers',
      '../db/',
      '../services/writeEvents',
      '../services/eventApplier',
      '../services/projectionRebuilder',
      // runner-v2 deliberately reuses runner.ts utility helpers
      // (buildInlineConfig, prepareSkills, etc.) until T10 deletes
      // runner.ts. Allowed by design per the cutover playbook §Step 1.
      '../services/runner',
      // services/envelope is pre-existing utility (parseEnvelope /
      // extractLastEnvelope / detectEnvelopeKind etc.); not deleted at
      // T10 — stays a shared service for runner-v2 + REST routes.
      '../services/envelope',
      // ProductionRunnerAdapter needs these foundational services to
      // resolve agent / MCPs / plugins on each spawn — all of which
      // survive T10 (they're owned by their own service files, not by
      // the legacy scheduler).
      '../services/agent',
      '../services/mcp',
      '../services/plugin',
      // util/log is the standard logger; survives all cutovers.
      '@/util/log',
      'node:',
    ]
    // Match `from '...'` across the whole file content (handles multi-line imports).
    const fromRe = /from\s+['"]([^'"]+)['"]/g
    for (const f of newTreeFiles) {
      const content = await readFile(f, 'utf-8')
      const matches = content.matchAll(fromRe)
      for (const m of matches) {
        const spec = m[1]!
        const allowed =
          allowedSpecifiers.includes(spec) ||
          allowedSpecifierPrefixes.some((p) => spec.startsWith(p))
        if (!allowed) {
          throw new Error(`forbidden import in ${f}: ${spec}`)
        }
      }
    }
  })
})
