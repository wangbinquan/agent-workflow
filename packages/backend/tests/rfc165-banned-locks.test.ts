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
  rejectRetiredStartTaskKeys,
} from '@agent-workflow/shared'

const ROOT = join(import.meta.dir, '..', '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1

/**
 * RFC-248: 前端源码守卫必须**精确**匹配「作为对象键出现」，不能用裸子串。
 * 新加入退役清单的 `repos` 是个太常见的子串——`cached-repos` / `repoSource` /
 * `useRepos` 都会误命中，把守卫变成永远红的噪声。负向 lookbehind 排掉前面接
 * 词字符或连字符的情况。
 */
/**
 * Comments stripped before matching.
 *
 * The ratchet bans these names as OBJECT KEYS in launch payloads. It does not
 * ban the words, and prose is where they legitimately appear — `repos:read` is
 * the name of a permission, and a doc comment mentioning it was reading as a
 * retired `repos:` key and turning main red (2026-08-17). Rewording the comment
 * would have been fixing the wrong thing: the sentence was accurate.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const mentionsAsKey = (src: string, key: string): boolean =>
  new RegExp(String.raw`(?<![\w-])${key}\s*:`).test(stripComments(src))

// RFC-165 的三个 path-mode 键 + RFC-248 退役的顶层 `repos` +
// RFC-320 收归服务端解析的 Git 提交身份键。
const STRIPPED_KEYS = ['repoPath', 'baseBranch', 'fetchBeforeLaunch', 'repos'] as const
const CLIENT_OWNED_IDENTITY_KEYS = ['gitUserName', 'gitUserEmail'] as const
const KEYS = [...STRIPPED_KEYS, ...CLIENT_OWNED_IDENTITY_KEYS] as const

describe('RFC-165 — retired-key registry', () => {
  test('RETIRED_START_TASK_KEYS 恰好包含 RFC-165、RFC-248 与 RFC-320 的退役键', () => {
    expect([...RETIRED_START_TASK_KEYS].sort()).toEqual([...KEYS].sort())
  })
})

describe('RFC-165 — public request schemas never emit the retired keys', () => {
  // Unknown keys are STRIPPED by the non-strict schemas (the raw-key reject
  // happens route-side); the invariant locked here is that the parsed output
  // a route hands to the service can never carry a retired key — i.e. nobody
  // quietly re-declared one of the three as an accepted field.
  for (const k of STRIPPED_KEYS) {
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

  for (const k of CLIENT_OWNED_IDENTITY_KEYS) {
    test(`StartTaskSchema fails closed for client-owned ${k}`, () => {
      const parsed = StartTaskSchema.safeParse({
        workflowId: 'wf',
        name: 'n',
        inputs: {},
        scratch: true,
        [k]: '/x',
      })
      expect(parsed.success).toBe(false)
    })
  }

  test('RFC-248: 顶层 repos 整个被硬拒（原「repos[i] 行内不得含退役键」）', () => {
    // RFC-248: 这条原本锁「`repos[]` 的行内不得含退役键」。顶层 `repos` 现在
    // 整个进了 RETIRED_START_TASK_KEYS 硬拒清单（非 strict zod 会静默剥除，
    // 不硬拒就会在错误工作区里成功启动），所以断言翻成「带 repos 的 body 直接
    // 被守卫拒掉」——比逐行检查行内键强得多。
    expect(rejectRetiredStartTaskKeys({ workflowId: 'w', name: 'n', repos: [] })).toBe('repos')
  })

  for (const k of STRIPPED_KEYS) {
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

  for (const k of CLIENT_OWNED_IDENTITY_KEYS) {
    test(`StartWorkgroupTaskSchema fails closed for client-owned ${k}`, () => {
      const parsed = StartWorkgroupTaskSchema.safeParse({
        name: 'run',
        goal: 'g',
        repoUrl: 'https://h/o/r.git',
        [k]: '/x',
      })
      expect(parsed.success).toBe(false)
    })
  }
})

describe('RFC-165 — raw-key guard wiring (source lock)', () => {
  test('JSON 与 multipart 两条启动臂都过 raw-key 门（multipart 臂随 RFC-284 T25 迁 service）', () => {
    // RFC-284 T25 改锚：multipart 编排主体迁 services/multipartTaskStart.ts，
    // 其 raw-key 门随体走——两臂各自文件内至少一处调用，意图不变。
    const routeSrc = read('packages/backend/src/routes/tasks.ts')
    expect(countOf(routeSrc, 'rejectRetiredStartTaskKeys(')).toBeGreaterThanOrEqual(1)
    const svcSrc = read('packages/backend/src/services/multipartTaskStart.ts')
    expect(countOf(svcSrc, 'rejectRetiredStartTaskKeys(')).toBeGreaterThanOrEqual(1)
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
    for (const k of KEYS) expect(mentionsAsKey(wg, k)).toBe(false)
  })

  test('the comment strip does not blunt the ratchet — a real key in CODE still fires', () => {
    // Guards the fix itself: stripping comments must not become "stripping
    // everything". A retired key in actual code is still caught, and one inside
    // prose is not.
    expect(mentionsAsKey('const x = { repoPath: "/tmp" }', 'repoPath')).toBe(true)
    expect(mentionsAsKey('/** repos:read protects the catalog */', 'repos')).toBe(false)
    expect(mentionsAsKey('// baseBranch: was retired by RFC-165', 'baseBranch')).toBe(false)
    // A key on the line AFTER a comment is code, and still caught.
    expect(mentionsAsKey('// note\nconst y = { baseBranch: "main" }', 'baseBranch')).toBe(true)
  })

  test('RepoSourceRow.tsx is URL-only (no retired keys, no recent-repos query)', () => {
    const row = read('packages/frontend/src/components/launch/RepoSourceRow.tsx')
    for (const k of KEYS) expect(mentionsAsKey(row, k)).toBe(false)
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
