// LOCKS: RFC-057 — grep guards for lifecycleRepair source.
// Mirrors design/RFC-057-diagnose-repair-actions/design.md §6.4.
// Locks in:
//   - no naked `db.update(nodeRuns).set({ status:`  → must go through
//     transitionNodeRunStatus / setNodeRunStatus (RFC-053 state machine)
//   - no `db.delete(` in the engine or option modules (audit is append-only;
//     repair never deletes rows — even cancel goes through cancel-by-supersede
//     which UPDATEs status, doesn't DELETE)
//   - shared `REPAIR_OPTION_IDS` keys exactly cover `LifecycleAlertRule`
//   - every backend `REPAIR_OPTIONS[rule].id` is listed in shared
//     `REPAIR_OPTION_IDS[rule]` (PR-A pairs the compile-time satisfies with
//     this runtime check so empty PR-A arrays don't silently drift)

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  LIFECYCLE_ALERT_RULES,
  REPAIR_OPTION_IDS,
  type LifecycleAlertRule,
} from '@agent-workflow/shared'

import { REPAIR_OPTIONS } from '../src/services/lifecycleRepair'

const SQLITE_PERSISTENCE_DIR = resolve(
  import.meta.dir,
  '..',
  'src',
  'platform',
  'persistence',
  'sqlite',
)
const ENGINE_FILE = resolve(SQLITE_PERSISTENCE_DIR, 'taskLifecycleRepair.ts')
const OPTIONS_DIR = resolve(SQLITE_PERSISTENCE_DIR, 'taskLifecycleRepair')

function loadEngineSources(): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = []
  files.push({ path: ENGINE_FILE, content: readFileSync(ENGINE_FILE, 'utf8') })
  for (const entry of readdirSync(OPTIONS_DIR)) {
    if (!entry.endsWith('.ts')) continue
    const p = resolve(OPTIONS_DIR, entry)
    files.push({ path: p, content: readFileSync(p, 'utf8') })
  }
  return files
}

// RFC-317 T14 —— 两条判据提到模块顶层：扫描与「matcher 自证」必须走**同一份**
// 实现。各留一份拷贝的话，fixture 证明的只是拷贝还活着，而不是真扫描还咬得动。
const NAKED_STATUS_WRITE =
  /\.update\(\s*nodeRuns\s*\)[\s\S]{0,400}\.set\(\s*\{\s*[\s\S]{0,80}status\s*:/

function stripCommentsForDeleteScan(content: string): string {
  return content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('RFC-057 grep guards', () => {
  test('no naked `db.update(nodeRuns).set({ status:` — must use state machine', () => {
    for (const { path, content } of loadEngineSources()) {
      expect({ path, ok: !NAKED_STATUS_WRITE.test(content) }).toEqual({ path, ok: true })
    }
  })

  test('no `db.delete(` — audit append-only, repair never deletes', () => {
    for (const { path, content } of loadEngineSources()) {
      // Allow comments mentioning the rule. Strip line comments, then check.
      const stripped = stripCommentsForDeleteScan(content)
      expect({
        path,
        ok: !stripped.includes('db.delete(') && !stripped.includes('.delete('),
      }).toEqual({
        path,
        ok: true,
      })
    }
  })

  test('engine uses transitionNodeRunStatus or setNodeRunStatus at least once', () => {
    // At least one of the option modules must call one of these helpers.
    let total = 0
    for (const { content } of loadEngineSources()) {
      const m1 = (content.match(/transitionNodeRunStatus\s*\(/g) ?? []).length
      const m2 = (content.match(/setNodeRunStatus\s*\(/g) ?? []).length
      total += m1 + m2
    }
    expect(total).toBeGreaterThanOrEqual(4) // PR-A: S3.resurrect-x ×2, T1.resurrect, R1.approve, U1.cancel ×2 — well over 4
  })

  test('shared REPAIR_OPTION_IDS keys exactly cover LifecycleAlertRule union', () => {
    const sharedKeys = new Set(Object.keys(REPAIR_OPTION_IDS))
    const ruleSet = new Set<string>(LIFECYCLE_ALERT_RULES)
    expect(sharedKeys.size).toBe(ruleSet.size)
    for (const r of ruleSet) expect(sharedKeys.has(r)).toBe(true)
  })

  test('backend REPAIR_OPTIONS option ids appear in shared REPAIR_OPTION_IDS', () => {
    for (const rule of Object.keys(REPAIR_OPTIONS) as LifecycleAlertRule[]) {
      const sharedIds = new Set(REPAIR_OPTION_IDS[rule] as readonly string[])
      for (const def of REPAIR_OPTIONS[rule]) {
        expect({ rule, optionId: def.id, knownInShared: sharedIds.has(def.id) }).toEqual({
          rule,
          optionId: def.id,
          knownInShared: true,
        })
      }
    }
  })

  test('every LifecycleAlertRule has ≥ 1 RepairOptionDef (PR-B exhaustiveness)', () => {
    // PR-B narrowed the central `satisfies` to a tuple form so empty arrays
    // fail compilation. This is a runtime backstop for the same guarantee.
    for (const rule of Object.keys(REPAIR_OPTIONS) as LifecycleAlertRule[]) {
      expect({ rule, count: REPAIR_OPTIONS[rule].length }).toEqual({
        rule,
        count: expect.any(Number),
      })
      expect(REPAIR_OPTIONS[rule].length).toBeGreaterThan(0)
    }
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的违规喂给**上面扫描用的同一份判据**。
//
// 这两条判据都靠宽松跨行匹配（`[\s\S]{0,400}`）。最容易的静默失效是有人收紧跨度
// 或改锚点后，真实的多行写法不再命中——扫描照跑、永远零违规，与「合规」同形。
describe('RFC-317 T14 —— matcher 自证：伪造的违规必须被抓到', () => {
  test('裸写 status 的单行与跨行形态都命中', () => {
    for (const fabricated of [
      'await db.update(nodeRuns).set({ status: "failed" }).where(eq(nodeRuns.id, id))',
      'await db\n  .update(nodeRuns)\n  .set({\n    finishedAt: now,\n    status: "done",\n  })\n',
    ]) {
      expect(NAKED_STATUS_WRITE.test(fabricated), `没抓到：${fabricated}`).toBe(true)
    }
  })

  test('不碰 status 的更新放行（规则不能宽到误伤合法写法）', () => {
    expect(NAKED_STATUS_WRITE.test('await db.update(nodeRuns).set({ finishedAt: now })')).toBe(
      false,
    )
  })

  test('删除扫描的注释剥离两向都对', () => {
    const withRealDelete = 'await db.delete(nodeRuns)\n// db.delete(x) 只在注释里\n'
    expect(stripCommentsForDeleteScan(withRealDelete).includes('db.delete(')).toBe(true)
    const commentOnly = '// db.delete(x)\n/* .delete( */\nconst y = 1\n'
    expect(stripCommentsForDeleteScan(commentOnly).includes('.delete(')).toBe(false)
  })
})
