// RFC-217 — architecture guard locks (table-driven, grows with each PR).
//
// T1 locks (G1 family): the module-init-cycle guard is only real if
//   (a) the dependency-cruiser rule exists,
//   (b) CI actually RUNS depcheck (design-gate finding: the script existed
//       for months while neither `lint` nor ci.yml ever invoked it), and
//   (c) services/workgroup/constants.ts stays a ZERO-IMPORT leaf — it was
//       extracted precisely to cut `launch → task → scheduler → runner →
//       rounds → launch` (RFC-079 class: top-level const evaluates to
//       undefined under an unlucky init order; only build:binary caught it).
//   (d) production code never re-grows the cycle edge by importing the
//       sentinel constants from workgroup/launch again.
//
// Every lock here has been mutation-verified (break it → this file reds).

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8')

describe('rfc217 G1 — no-circular guard is real', () => {
  test('dependency-cruiser config carries an error-severity no-circular rule', () => {
    const cfg = read('.dependency-cruiser.cjs')
    expect(cfg).toContain("name: 'no-circular'")
    expect(cfg).toContain('circular: true')
    // type-only edges vanish at emit — the rule must keep ignoring them,
    // otherwise the 5 outputKinds type-import cycles instantly red CI.
    expect(cfg).toContain("viaOnly: { dependencyTypesNot: ['type-only'] }")
  })

  test('CI wires depcheck (a rule nobody runs is not a lock)', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('bun run depcheck')
  })

  test('workgroup/constants.ts is a zero-import leaf module', () => {
    const src = read('packages/backend/src/services/workgroup/constants.ts')
    expect(src).not.toMatch(/^\s*import\b/m)
    expect(src).not.toMatch(/\brequire\s*\(/)
    // the sentinels themselves must stay here (wire-frozen values)
    expect(src).toContain("'__wg_leader__'")
    expect(src).toContain("'__wg_member__'")
    expect(src).toContain("'__wg_clarify__'")
  })

  test('production src never imports sentinel constants from workgroup/launch', () => {
    // the launch re-export exists for legacy TEST importers only; production
    // importing constants via launch re-opens the heavy-module cycle edge.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (e.name.endsWith('.ts')) {
          const src = read(rel)
          const re =
            /import\s*\{([^}]*)\}\s*from\s*'(?:@\/services\/workgroup\/launch|\.\/launch|\.\.\/workgroup\/launch)'/g
          for (const m of src.matchAll(re)) {
            if (/WG_|WORKGROUP_HOST/.test(m[1] ?? '')) offenders.push(rel)
          }
        }
      }
    }
    walk('packages/backend/src')
    expect(offenders).toEqual([])
  })
})

describe('rfc217 G2/G3 — retired runtime-state slots stay retired', () => {
  const SRC = 'packages/backend/src'
  const walkTs = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walkTs(rel, out)
      else if (e.name.endsWith('.ts')) out.push(rel)
    }
    return out
  }

  test('G3: no backend code touches the retired $.gate / $.dw / $.wgPause slots', () => {
    // migration SQL lives outside src/ and is implicitly allowlisted. Comments
    // may reference history; these patterns only match CODE shapes.
    const banned = [
      "'$.gate'",
      "'$.dw'",
      "'$.wgPause'",
      'raw.gate',
      'rawConfig.gate',
      'raw.dw',
      'rawConfig.dw',
      'raw.wgPause',
      'json_set(${tasks.workgroupConfigJson}',
    ]
    const offenders: string[] = []
    for (const f of walkTs(SRC)) {
      const src = read(f)
      for (const b of banned) if (src.includes(b)) offenders.push(`${f} ⇒ ${b}`)
    }
    expect(offenders).toEqual([])
  })

  test('G2: room-table writes live in services (routes are transport only)', () => {
    // RFC-217 T4 终态：workgroupConfigJson 唯一 UPDATE 写点在 taskActions
    //（config PUT 编排）；routes/ 里任何房间表裸写（messages/assignments/
    // configJson）都是回归。
    const allow = new Set(['packages/backend/src/services/workgroup/taskActions.ts'])
    const offenders: string[] = []
    for (const f of walkTs(SRC)) {
      const src = read(f)
      if (
        src.includes('workgroupConfigJson:') &&
        src.includes('.update(tasks)') &&
        f.startsWith('packages/backend/src/routes/')
      )
        offenders.push(`${f} ⇒ config write`)
      if (src.includes('.set({ workgroupConfigJson') && !allow.has(f)) offenders.push(f)
      if (f.startsWith('packages/backend/src/routes/')) {
        for (const b of ['insert(workgroupMessages)', 'insert(workgroupAssignments)']) {
          if (src.includes(b)) offenders.push(`${f} ⇒ ${b}`)
        }
      }
    }
    expect(offenders).toEqual([])
    const puts =
      read('packages/backend/src/services/workgroup/taskActions.ts').split(
        '.set({ workgroupConfigJson',
      ).length - 1
    expect(puts).toBe(1)
  })
})

describe('rfc217 G6 — the protocol-error reprompt has ONE definition site', () => {
  test('`## Protocol errors in your previous reply` lives only in turnExecution.ts', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (
          e.name.endsWith('.ts') &&
          read(rel).includes('## Protocol errors in your previous reply')
        )
          offenders.push(rel)
      }
    }
    walk('packages/backend/src')
    expect(offenders).toEqual(['packages/backend/src/services/workgroup/turnExecution.ts'])
  })
})

describe('rfc217 G5/G7 — mode branches ratcheted, shardKey goes through codecs', () => {
  const WG = 'packages/backend/src/services/workgroup'

  test("G5 ratchet: per-file `mode === '` count may only shrink", () => {
    // T3b 收形后的快照（原 runner 单文件 15 处+全仓 40+ 散射）。新增比较必须
    // 落在 strategies/（或先收掉别处一处）；数字只许降不许升。
    const SNAPSHOT: Record<string, number> = {
      'memberTurns.ts': 6,
      'engine.ts': 4,
      'rounds.ts': 4,
      'prompts.ts': 3,
      'wake.ts': 2,
      'strategies/leaderWorker.ts': 1,
      'lifecycle.ts': 1,
      'launch.ts': 1,
      // T4：config PUT 编排随迁带入一处 dynamic_workflow 免疫判断（原 route 同款）
      'taskActions.ts': 1,
    }
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (e.isDirectory()) walk(`${dir}/${e.name}`)
        else if (e.name.endsWith('.ts')) files.push(`${dir}/${e.name}`)
      }
    }
    walk(WG)
    for (const f of files) {
      const rel = f.slice(WG.length + 1)
      const count = read(f).split("mode === '").length - 1
      const cap = SNAPSHOT[rel] ?? (rel.startsWith('strategies/') ? Infinity : 0)
      expect(count, `${rel} 的 mode=== 计数 ${count} 超过棘轮上限 ${cap}`).toBeLessThanOrEqual(cap)
    }
  })

  test('G7: no hand-rolled shardKey split/startsWith outside the shared codecs', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (e.name.endsWith('.ts')) {
          const src = read(rel)
          if (
            src.includes("startsWith('msg:") ||
            src.includes("startsWith('batch:") ||
            /shardKey[^\n]*\.split\(':'\)/.test(src)
          )
            offenders.push(rel)
        }
      }
    }
    walk(WG)
    expect(offenders).toEqual([])
  })
})

describe('rfc217 G4 — the workgroup discriminator has ONE oracle', () => {
  test('raw workgroupId null-checks are banned outside the shared oracle', () => {
    // taskExecutionKind / isWorkgroupTask (packages/shared/src/schemas/task.ts)
    // are the ONLY places allowed to read the raw discriminator; every other
    // site (backend + frontend) goes through them (flag-audit kind-scatter).
    const roots = ['packages/backend/src', 'packages/frontend/src']
    const banned = [
      'workgroupId !== null',
      'workgroupId != null',
      'workgroupId === null',
      'workgroupId == null',
      'workgroupId !== undefined',
    ]
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (/\.(ts|tsx)$/.test(e.name)) {
          const src = read(rel)
          for (const b of banned) if (src.includes(b)) offenders.push(`${rel} ⇒ ${b}`)
        }
      }
    }
    for (const r of roots) walk(r)
    expect(offenders).toEqual([])
  })
})
