// RFC-165 C6 — banned-key locks for the three retired path-mode launch keys
// (`repoPath` / `baseBranch` / `fetchBeforeLaunch`).
//
// WHY THIS FILE EXISTS: RFC-165 removed the local-path launch mode from the
// entire public wire (design §4 契约 v2). The keys were dropped from the
// request schemas AND actively rejected raw at every legacy entrance
// (`rejectRetiredStartTaskKeys`), because zod's default strip() would
// otherwise silently degrade a legacy body into a source-less launch. A
// refactor that re-adds one key, or unwires one guard, re-opens exactly that
// silent-degrade hole — these locks make it a visible red instead.
//
// ALLOWLIST (files that legitimately keep the symbols; deliberately NOT
// asserted here):
//   * services/scheduledTasks.ts healScheduledLaunchPayloads — reads legacy
//     `repoPath`/`baseBranch`/`fetchBeforeLaunch` to migrate stored payloads
//     (path → file:// URL) at boot; guarded by rfc165-scheduled-heal tests.
//   * services/task.ts internal launch face (RepoSourceSpec / internalSource:
//     kind 'local-path') — daemon-internal (fusion/tests), never on the wire.
//   * persisted DTOs + db/schema.ts — `tasks.repo_path`/`base_branch` columns
//     and the Task response DTO keep historical rows readable.
//   * gc.ts / util/git.ts — operate on materialized workspace paths.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RETIRED_START_TASK_KEYS,
  StartTaskSchema,
  StartWorkgroupTaskSchema,
} from '@agent-workflow/shared'

const ROOT = join(import.meta.dir, '..', '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1

const KEYS = ['repoPath', 'baseBranch', 'fetchBeforeLaunch'] as const

describe('RFC-165 — retired-key registry', () => {
  test('RETIRED_START_TASK_KEYS is exactly the three path-mode keys', () => {
    expect([...RETIRED_START_TASK_KEYS].sort()).toEqual([...KEYS].sort())
  })
})

describe('RFC-165 — public request schemas never emit the retired keys', () => {
  // Unknown keys are STRIPPED by the non-strict schemas (the raw-key reject
  // happens route-side); the invariant locked here is that the parsed output
  // a route hands to the service can never carry a retired key — i.e. nobody
  // quietly re-declared one of the three as an accepted field.
  for (const k of KEYS) {
    test(`StartTaskSchema output never carries ${k}`, () => {
      const parsed = StartTaskSchema.safeParse({
        workflowId: 'wf',
        name: 'n',
        inputs: {},
        scratch: true,
        [k]: k === 'fetchBeforeLaunch' ? true : '/x',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success) expect(k in parsed.data).toBe(false)
    })
  }

  test('StartTaskSchema repos[i] entries never carry repoPath/baseBranch', () => {
    const parsed = StartTaskSchema.safeParse({
      workflowId: 'wf',
      name: 'n',
      inputs: {},
      repos: [
        { repoUrl: 'https://h/o/a.git', repoPath: '/x', baseBranch: 'main' },
        { repoUrl: 'https://h/o/b.git', ref: 'dev' },
      ],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      for (const entry of parsed.data.repos ?? []) {
        expect('repoPath' in entry).toBe(false)
        expect('baseBranch' in entry).toBe(false)
      }
    }
  })

  for (const k of KEYS) {
    test(`StartWorkgroupTaskSchema output never carries ${k}`, () => {
      const parsed = StartWorkgroupTaskSchema.safeParse({
        name: 'run',
        goal: 'g',
        repoUrl: 'https://h/o/r.git',
        [k]: k === 'fetchBeforeLaunch' ? true : '/x',
      })
      expect(parsed.success).toBe(true)
      if (parsed.success) expect(k in parsed.data).toBe(false)
    })
  }
})

describe('RFC-165 — raw-key guard wiring (source lock)', () => {
  test('routes/tasks.ts gates BOTH the JSON and multipart entrances', () => {
    const src = read('packages/backend/src/routes/tasks.ts')
    expect(countOf(src, 'rejectRetiredStartTaskKeys(')).toBeGreaterThanOrEqual(2)
  })

  test('routes/scheduledTasks.ts gates create + update payloads', () => {
    const src = read('packages/backend/src/routes/scheduledTasks.ts')
    expect(countOf(src, 'rejectRetiredStartTaskKeys(')).toBeGreaterThanOrEqual(2)
  })

  test('routes/workgroups.ts launch gates raw keys too (exemption revoked)', () => {
    // Implementation-gate P2 (PR-2 review): the original exemption reasoning
    // ("schema never declared the keys") missed the F1 silent-degrade shape —
    // a {scratch:true, repoPath} body strips to a scratch launch. All four
    // launch entrances now carry the raw-key gate uniformly.
    const src = read('packages/backend/src/routes/workgroups.ts')
    expect(countOf(src, 'rejectRetiredStartTaskKeys(')).toBeGreaterThanOrEqual(1)
  })

  test('routes/agents.ts launch gates raw keys (same F1 shape)', () => {
    const src = read('packages/backend/src/routes/agents.ts')
    expect(countOf(src, 'rejectRetiredStartTaskKeys(')).toBeGreaterThanOrEqual(1)
  })

  test('services/scheduledTasks.ts repair guard uses the shared reject helper', () => {
    const src = read('packages/backend/src/services/scheduledTasks.ts')
    expect(countOf(src, 'rejectRetiredStartTaskKeys(')).toBeGreaterThanOrEqual(1)
  })
})

describe('RFC-165 — frontend launch builders emit no retired keys', () => {
  test('lib/launch-repo-source.ts: no fetchBeforeLaunch, no repoPath/baseBranch key stamps', () => {
    const lib = read('packages/frontend/src/lib/launch-repo-source.ts')
    expect(lib.includes('fetchBeforeLaunch')).toBe(false)
    // Key-stamp form only (`repoPath:`): the resolveUrlRepoPath helper NAME
    // and its docs legitimately mention the word.
    expect(/\brepoPath\s*:/.test(lib)).toBe(false)
    expect(/\bbaseBranch\s*:/.test(lib)).toBe(false)
  })

  test('lib/task-wizard.ts (the wizard builders) carries none of the three keys and delegates to the shared builders', () => {
    // RFC-165 PR-3: the body builders moved from lib/workgroup-launch.ts into
    // lib/task-wizard.ts (the /tasks/new wizard's builder module); the old
    // module keeps only the 422→copy mapping.
    //
    // RFC-175: taskToLaunchPayload REVERSE-builds a launch payload FROM a
    // persisted Task DTO, so it legitimately READS the DTO's `baseBranch`
    // column (an allowlisted persisted field — see header) and maps it to the
    // v2 `ref` key; it never STAMPS a retired key onto the wire. Mirror the
    // launch-repo-source.ts assertion above: the silent-degrade hole re-opens
    // only if a builder STAMPS `repoPath:` / `baseBranch:` (or mentions
    // `fetchBeforeLaunch` at all), not from a `.baseBranch` read. Key-stamp
    // form only.
    const wiz = read('packages/frontend/src/lib/task-wizard.ts')
    expect(wiz.includes('fetchBeforeLaunch')).toBe(false)
    expect(/\brepoPath\s*:/.test(wiz)).toBe(false)
    expect(/\bbaseBranch\s*:/.test(wiz)).toBe(false)
    expect(wiz.includes("from './launch-repo-source'")).toBe(true)
    const wg = read('packages/frontend/src/lib/workgroup-launch.ts')
    for (const k of KEYS) expect(wg.includes(k)).toBe(false)
  })

  test('RepoSourceRow.tsx is URL-only (no retired keys, no recent-repos query)', () => {
    const row = read('packages/frontend/src/components/launch/RepoSourceRow.tsx')
    for (const k of KEYS) expect(row.includes(k)).toBe(false)
    expect(row.includes('repos/recent')).toBe(false)
  })

  test('the retired path-mode launch files stay deleted', () => {
    expect(
      existsSync(join(ROOT, 'packages/frontend/src/components/launch/RepoSourceTabs.tsx')),
    ).toBe(false)
    expect(
      existsSync(join(ROOT, 'packages/frontend/src/components/launch/buildLaunchFormData.ts')),
    ).toBe(false)
  })
})
