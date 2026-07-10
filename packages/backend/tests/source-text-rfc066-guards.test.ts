// RFC-066 PR-A — source-layer guards locking the multi-repo wiring against
// silent regressions:
//   G1: services/task.ts must keep the explicit "single-path byte-baseline
//       branch" marker comment. A future multi-repo refactor cannot quietly
//       delete the single-repo code path; the marker tags the surface area
//       reviewers must double-check before any rewrite.
//   G3: callers of `materializeWorktree` must NOT pass `overrideWorktreePath`
//       when launching a single-repo task — that override is exclusively
//       reserved for the multi-repo materialize loop. The legacy
//       `{repoSlug}/{taskId}` path layout stays byte-baseline for single-repo
//       callers.
//   G4: the migration filename for RFC-066 must be `0034_rfc066_task_repos.sql`
//       (RFC-067 already occupies 0033). Locks the migration journal idx.
//
// G2 (frontend `RepoSourceList` separation from `RepoSourceTabs`) belongs to
// PR-C; this file only covers backend / migration concerns.

import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const TASK_SRC = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf-8')
const ROUTES_TASKS_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'routes', 'tasks.ts'),
  'utf-8',
)
const MIGRATIONS_DIR = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-066 PR-A — source guards', () => {
  test('G1 services/task.ts retains the single-path byte-baseline branch marker', () => {
    // The marker comment is the canonical anchor that tags the single-repo
    // code path inside startTask. Removing or renaming it without a paired
    // RFC-066 design.md amendment is a regression.
    expect(TASK_SRC.includes('RFC-066: single-path byte-baseline branch')).toBe(true)
  })

  test('G3 single-repo materializeWorktree callers do NOT pass overrideWorktreePath', () => {
    // Two single-repo materialize call sites today: the multipart upload
    // route (`routes/tasks.ts`) and the `else if (repoSpecs.length === 1)`
    // branch in `services/task.ts`. Both must thread the legacy layout —
    // i.e. they must NOT pass `overrideWorktreePath`. The multi-path branch
    // is the only legitimate consumer of the override (verified by the
    // companion behavior tests in start-task-multi-repo-materialize.test.ts).

    // RFC-165 (F3): the multipart route no longer calls materializeWorktree
    // directly — it goes through services/task.ts `materializeSpace`, whose
    // single-path branch is pinned below. Any call that DOES reappear in the
    // route must still omit overrideWorktreePath.
    const routesCalls = ROUTES_TASKS_SRC.match(/materializeWorktree\(\{[^}]*\}\)/gms) ?? []
    for (const call of routesCalls) {
      expect(call.includes('overrideWorktreePath')).toBe(false)
    }

    // In services/task.ts the multi-path branch (length > 1) is the only
    // call site allowed to pass overrideWorktreePath. The single-path branch
    // (length === 1) must omit it. We grep by anchoring on the surrounding
    // comments.
    const singlePathSection = extractSection(
      TASK_SRC,
      'RFC-066: single-path byte-baseline branch',
      // End anchor: the next `} else {` opens the multi-repo branch.
      'RFC-066: multi-repo materialize branch',
    )
    expect(singlePathSection.length).toBeGreaterThan(0)
    expect(singlePathSection.includes('overrideWorktreePath')).toBe(false)
  })

  test('G4 migration 0034 file exists with the expected RFC-066 tag', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    const rfc066 = files.find((f) => f.startsWith('0034_'))
    expect(rfc066).toBeDefined()
    expect(rfc066).toBe('0034_rfc066_task_repos.sql')
    // Also verify the journal includes an entry pointing at it. After
    // RFC-064 added migration 0035, the journal's last entry is no longer
    // RFC-066; we look up by tag instead.
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf-8'),
    ) as { entries: Array<{ idx: number; tag: string }> }
    const rfc066Entry = journal.entries.find((e) => e.tag === '0034_rfc066_task_repos')
    expect(rfc066Entry).toBeDefined()
    expect(rfc066Entry!.idx).toBe(33)
  })

  test('G5 services/task.ts multi-repo gate emits the canonical error codes', () => {
    // Locks the exact code strings used in the multi-repo gate so frontend
    // i18n / route 422 handlers can rely on them.
    expect(TASK_SRC.includes("'multi-repo-wrapper-git-unsupported'")).toBe(true)
    expect(TASK_SRC.includes("'multi-repo-upload-unsupported'")).toBe(true)
  })
})

/**
 * Extract the substring between `startMarker` (inclusive) and the first
 * occurrence of `endMarker` after it. Throws if either marker is missing —
 * forces the test to fail loudly when the source structure changes.
 */
function extractSection(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker)
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`)
  const end = src.indexOf(endMarker, start + startMarker.length)
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`)
  return src.slice(start, end)
}
