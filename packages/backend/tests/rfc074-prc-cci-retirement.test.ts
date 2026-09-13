// RFC-074 PR-C — cci retirement C-group (design §11.3 C1-C12).
//
// This suite locks the structural invariants of the clarifyIteration retirement:
//   C1-C4  — isFresherNodeRun pure-id ordering is equivalent to the retired
//            comparator on causal-order rows (cross-checked against the PR-A
//            baseline file `isfresher-noderun-baseline.test.ts`).
//   C9-C10 — migration 0041 dropped node_runs.clarify_iteration; the schema
//            round-trips without it.
//   C11-C12 — grep guards: no LIVE clarifyIteration usage anywhere in
//            src/shared/frontend, and the three deleted functions have no
//            definition or call site.
//
// Note on the grep guard: the design's "0 命中" target is enforced against the
// FUNCTIONAL shapes that could reintroduce the counter — property access
// (`.clarifyIteration`), object-key assignment (`clarifyIteration:`), and the
// drizzle column declaration (`integer('clarify_iteration')`). Prose comments
// that explain the retirement (e.g. "the retired clarifyIteration counter")
// are intentionally allowed — they document intent and cannot resurrect the
// column. The `__clarify_iteration__` prompt PLACEHOLDER is a public agent
// protocol token, unrelated to the node_runs column, and is also allowed.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createInMemoryDb } from '../src/db/client'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { isFresherNodeRun } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC_ROOTS = [
  resolve(import.meta.dir, '..', 'src'),
  resolve(import.meta.dir, '..', '..', 'shared', 'src'),
  resolve(import.meta.dir, '..', '..', 'frontend', 'src'),
]

type Row = typeof nodeRuns.$inferSelect
function row(id: string): Row {
  return { id } as unknown as Row
}

function walkSourceFiles(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        stack.push(full)
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push(full)
      }
    }
  }
  return out
}

describe('RFC-074 PR-C — isFresherNodeRun pure-id ordering (C1-C4)', () => {
  test('C1: undefined incumbent → fresher', () => {
    expect(isFresherNodeRun(row('01A'), undefined)).toBe(true)
  })

  test('C2: larger id wins; smaller loses; equal is not strictly fresher', () => {
    expect(isFresherNodeRun(row('02B'), row('01A'))).toBe(true)
    expect(isFresherNodeRun(row('01A'), row('02B'))).toBe(false)
    expect(isFresherNodeRun(row('01A'), row('01A'))).toBe(false)
  })

  test('C3: comparator ignores everything but id (no clarifyIteration/retryIndex axis)', () => {
    // Even a row that would have had a higher cci/retry loses if its id is
    // smaller — there is no longer any axis above id.
    const earlierButHigherCounters = {
      id: '01A',
      clarifyIteration: 9,
      retryIndex: 9,
    } as unknown as Row
    const laterFreshRerun = { id: '02B', clarifyIteration: 0, retryIndex: 0 } as unknown as Row
    expect(isFresherNodeRun(laterFreshRerun, earlierButHigherCounters)).toBe(true)
  })

  test('C4: fold over a causal-order set picks the max-id row', () => {
    const set = [row('01'), row('02'), row('03'), row('04')]
    let winner: Row | undefined
    for (const r of set) if (isFresherNodeRun(r, winner)) winner = r
    expect(winner?.id).toBe('04')
  })
})

// C9 判的是 **SQLite 迁移链跑完后的实时 schema**（`PRAGMA table_info`），按定义只对 SQLite 成立：
// PostgreSQL 的 schema 来自 drizzle 声明，两侧的对账由
// `tests/architecture/rfc359-w5-t19g-schema-contract-reconciliation.test.ts` 独立负责。
// C10 判的是**行为**（插入 / 取回不带那一列），与引擎无关，按 RFC-359 AC-6 迁进双引擎块。
describe('RFC-074 PR-C — migration 0041 drops node_runs.clarify_iteration (C9)', () => {
  test('C9: the dropped column is absent from the live schema', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = db.all(sql`PRAGMA table_info(node_runs)`) as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    expect(names).not.toContain('clarify_iteration')
    // Provenance + other columns survive the rebuild.
    expect(names).toContain('consumed_upstream_runs_json')
    expect(names).toContain('commit_push_json')
    expect(names).toContain('review_iteration')
  })
})

describeEachProvider(
  'RFC-074 PR-C — node_run round-trips without the cci column (C10)',
  (harness) => {
    async function seedWorkflowTask(db: ProviderNeutralDatabase): Promise<string> {
      await db.insert(workflows).values({
        id: 'wf1',
        name: 'w',
        description: '',
        definition: '{}',
        version: 1,
      })
      await db.insert(tasks).values({
        id: 'task1',
        name: 't',
        workflowId: 'wf1',
        workflowSnapshot: '{}',
        repoPath: '/tmp',
        worktreePath: '',
        baseBranch: 'main',
        branch: 'agent-workflow/t',
        status: 'running',
        inputs: '{}',
        startedAt: Date.now(),
      })
      return 'task1'
    }

    test('C10: a node_run round-trips insert/select without the cci column', async () => {
      const db = harness.db
      const taskId = await seedWorkflowTask(db)
      await db.insert(nodeRuns).values({
        id: '01ROW',
        taskId,
        nodeId: 'n',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        reviewIteration: 0,
        consumedUpstreamRunsJson: JSON.stringify({ up: '01UP' }),
      })
      const got = (await db.select().from(nodeRuns).limit(1))[0]
      expect(got?.id).toBe('01ROW')
      expect(got?.consumedUpstreamRunsJson).toBe(JSON.stringify({ up: '01UP' }))
      expect('clarifyIteration' in (got as object)).toBe(false)
    })
  },
)

describe('RFC-074 PR-C — grep guards (C11-C12)', () => {
  const allSrc = SRC_ROOTS.flatMap(walkSourceFiles)

  test('C11: no LIVE clarifyIteration usage (property access / object key / column decl)', () => {
    const offenders: string[] = []
    for (const file of allSrc) {
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        const stripped = line.replace(/__clarify_iteration__/g, '')
        if (
          /\.clarifyIteration\b/.test(stripped) ||
          /\bclarifyIteration\s*:/.test(stripped) ||
          /integer\(\s*['"]clarify_iteration['"]\s*\)/.test(stripped)
        ) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  test('C12: the three retired functions have no definition or call site', () => {
    const dead = [
      'cascadeDownstreamFromDesigner',
      'applyClarifyFreshnessInvariant',
      'isReviewClarifyAlignedWithUpstream',
      'loadDefinitionForTask',
    ]
    const offenders: string[] = []
    for (const file of allSrc) {
      const text = readFileSync(file, 'utf8')
      for (const fn of dead) {
        // Definition (`function fn(` / `const fn =`) or call (`fn(`).
        const re = new RegExp(`(function\\s+${fn}\\b|\\b${fn}\\s*\\()`)
        if (re.test(text)) offenders.push(`${file}: ${fn}`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
