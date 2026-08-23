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
//   (e) **the gate can actually SEE the graph** — added 2026-08-03 (架构审视
//       A1 / WP-0). (a)-(d) were all green while `tsConfig.fileName` pointed
//       at `tsconfig.base.json`, which has no `paths`: every `@/…` import
//       resolved to nothing and 62.5% of the dependency edges were silently
//       dropped, so `depcheck` reported 0 violations against a graph missing
//       most of itself (19 real violations appeared the moment it was fixed).
//       The resolution ratchet + the known-violation allowlist live in
//       `depcheck-gate.test.ts`; this file only asserts the wiring below so
//       the two cannot drift apart.
//
// Every lock here has been mutation-verified (break it → this file reds).

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8')

// RFC-317 T14 —— 判据提到模块顶层：扫描与「matcher 自证」共用同一份实现。
// 这条正则是「生产代码不得从 workgroup/launch 取哨兵常量」的全部判据；三种
// 导入路径写法少认一种，重开重模块环的那条边就能悄悄回来。
const WG_CONSTANT_IMPORT =
  /import\s*\{([^}]*)\}\s*from\s*'(?:@\/services\/workgroup\/launch|\.\/launch|\.\.\/workgroup\/launch)'/g

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

  test('depcheck resolves per-package tsconfig (a rule that sees nothing is not a lock)', () => {
    // (e) — 2026-08-03. `depcheck` must go through scripts/depcheck.ts, which
    // feeds depcruise a per-package tsconfig carrying `@/*`. Point it back at
    // a paths-less tsconfig and the whole graph collapses to unresolved edges
    // while every assertion above stays green — that is exactly what happened
    // for two years. Judgment lives in depcheck-gate.test.ts.
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts.depcheck).toContain('scripts/depcheck.ts')
    expect(read('.dependency-cruiser.cjs')).toContain('DEPCRUISE_TSCONFIG')
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
          for (const m of src.matchAll(WG_CONSTANT_IMPORT)) {
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
    const allow = new Set(['packages/backend/src/services/workgroup/configActions.ts'])
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
      read('packages/backend/src/services/workgroup/configActions.ts').split(
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
      // RFC-243 §6.3 +2：startWorkgroupTaskFromFrozen（冻结启动面）在同文件内
      // 复刻 readiness 的 leader 判定与 dw 快照选择——与 fresh 启动同语义、
      // 不新增 mode 分支散射面（strategies/ 之外唯一属主仍是 launch.ts）。
      'launch.ts': 3,
      // T4：config PUT 编排（含 dynamic_workflow 免疫判断）落 configActions
      'configActions.ts': 1,
      'dwActions.ts': 2,
      'room.ts': 1,
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

describe('rfc217 T6 — assignment writes have ONE owning module', () => {
  test('update(workgroupAssignments) lives only in workgroup/lifecycle.ts', () => {
    // 状态迁移走 casAssignmentStatus（转换表 CAS），run 指针刷新走
    // repointAssignmentRun——第二个 update 站点=有人绕开了 D4 写侧收口。
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (e.name.endsWith('.ts') && read(rel).includes('update(workgroupAssignments)'))
          offenders.push(rel)
      }
    }
    walk('packages/backend/src')
    expect(offenders).toEqual(['packages/backend/src/services/workgroup/lifecycle.ts'])
  })
})

describe('rfc217 G8 — clarify 单地层（遗留标识符归零）', () => {
  test('backend src 不再出现 clarify_sessions / cross_clarify_sessions / clarifyMigration', () => {
    const banned = [
      "'clarify_sessions'",
      "'cross_clarify_sessions'",
      'clarifyMigration',
      'insert(clarifySessions',
      'from(clarifySessions',
      'update(clarifySessions',
      'insert(crossClarifySessions',
      'from(crossClarifySessions',
      'update(crossClarifySessions',
    ]
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (e.name.endsWith('.ts')) {
          const src = read(rel)
          for (const b of banned) if (src.includes(b)) offenders.push(`${rel} ⇒ ${b}`)
        }
      }
    }
    walk('packages/backend/src')
    expect(offenders).toEqual([])
  })
})

describe('rfc217 G9 — 房间 query 单 owner', () => {
  test('workgroupRoomKey 作为 queryKey 的 useQuery 声明全前端只有 tasks.detail.tsx 一处', () => {
    // T10 数据流：tasks.detail.tsx 持有唯一房间聚合 query，WorkgroupRoom /
    // DynamicWorkflowPanel 经 props 接 data+refetch。此前 3 处各自声明
    // （轮询策略随之分叉）正是本锁要钉死的回归形态。invalidateQueries 引用
    // key 不受限（写端失效必须到处可用）。
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
          const src = read(rel)
          // 声明形态锚点：useQuery<WorkgroupRoomResponse> —— 失效端
          // invalidateQueries({ queryKey: workgroupRoomKey(...) }) 不受限
          // （写端失效必须到处可用），只有 query 声明本身被钉死单点。
          if (src.includes('useQuery<WorkgroupRoomResponse>')) offenders.push(rel)
        }
      }
    }
    walk('packages/frontend/src')
    expect(offenders).toEqual(['packages/frontend/src/routes/tasks.detail.tsx'])
  })
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 本文件的扫描器都是各 test 内部的局部 walk，共享同一个前提：`ROOT` 指向仓库根、
// 其下 `packages/backend/src` 是一棵有内容的 TS 树。这个前提一旦破（目录改名、
// 相对层级算错），每个局部 walk 都会安静地扫出 0 个文件，而所有 `toEqual([])` 照绿。
// 这里用同一形态的 walk 把该前提变成可断言事实。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    const walkTs = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walkTs(rel, out)
        else if (e.name.endsWith('.ts')) out.push(rel)
      }
      return out
    }
    expect(walkTs('packages/backend/src').length).toBeGreaterThanOrEqual(300)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的违规喂给**扫描用的同一份判据**。
//
// 这条锁的判据是一条带三个可选前缀的正则。少认一种导入路径写法，「生产代码从
// workgroup/launch 取哨兵常量」这条重开重模块环的边就能悄悄回来，而扫描仍报零。
describe('RFC-317 T14 —— matcher 自证：伪造的哨兵常量导入必须被抓到', () => {
  const smuggled = (source: string): boolean => {
    WG_CONSTANT_IMPORT.lastIndex = 0
    for (const match of source.matchAll(WG_CONSTANT_IMPORT)) {
      if (/WG_|WORKGROUP_HOST/.test(match[1] ?? '')) return true
    }
    return false
  }

  test('三种导入路径写法都命中', () => {
    for (const fabricated of [
      "import { WG_CLARIFY } from '@/services/workgroup/launch'",
      "import { WORKGROUP_HOST_ID } from './launch'",
      "import { WG_A, WG_B } from '../workgroup/launch'",
    ]) {
      expect(smuggled(fabricated), `没抓到：${fabricated}`).toBe(true)
    }
  })

  test('从 launch 取非哨兵符号放行（锁的是常量，不是整个模块）', () => {
    expect(smuggled("import { launchWorkgroup } from '@/services/workgroup/launch'")).toBe(false)
  })

  test('从别的模块取同名常量不算（判据锁的是来源）', () => {
    expect(smuggled("import { WG_CLARIFY } from '@/services/workgroup/constants'")).toBe(false)
  })
})
