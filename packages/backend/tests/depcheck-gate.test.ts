// 依赖分层门禁（scripts/depcheck.ts）。
//
// 为什么这条测试存在（2026-08-03 架构审视 A1 / WP-0，
// design/task-execution-architecture-audit-2026-08-03.md）：
//
// 原门禁 `depcruise --config .dependency-cruiser.cjs <三个 src>` 把
// `tsConfig.fileName` 指向 `tsconfig.base.json`，而 base 里 `paths` 出现 **0 次**
// ——`@/*` 只定义在各 package 自己的 tsconfig。于是每条 `@/...` import 都
// couldNotResolve 被静默丢出依赖图：实测 **3365 / 5384 = 62.5%** 的依赖边门禁
// 根本看不见，CI 两年一直报 0 违规。换成正确 tsconfig 后立刻暴露 **19 条**真实
// 违规（18 个 runtime 环 + 1 条 services→routes）。绕环最常用的
// `await import('@/services/…')` 恰好 100% 落在这个盲区里，于是 RFC-217 声称的
// 「工具 + 约定双保险」实际退化成了纯人肉约定。
//
// 下面锁住四件事：
//   ① **门禁看得见图** —— 第一方边零未解析是硬判据（evaluateCruises 的
//      unresolvedFirstParty）。这是本文件最重要的一条：它让「静默失明」无法
//      以任何形式重来（换 tsconfig / 改 alias / 加新 package 都会红）。
//   ② **允许列表只能缩** —— stale 条目（不再触发的 known 违规）必须让门禁红。
//   ③ **新违规必须红** —— 不在 KNOWN_VIOLATIONS 里的一律阻塞。
//   ④ **接线与反悔防护** —— package.json / CI 调的是新门禁；配置文件不得再
//      指回 tsconfig.base.json，也不得退回按文件排除的 `from.pathNot` 允许列表
//      （那种粒度会连带放过未来经过同一文件的新环）。
//
// 每条 lock 都做过变异验证（把生产侧改坏 → 本文件红）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  evaluateCruises,
  formatVerdict,
  isBlocking,
  isFirstPartySpecifier,
  violationKey,
  KNOWN_VIOLATIONS,
  PACKAGES,
  type CruiseResult,
  type KnownViolation,
} from '../../../scripts/depcheck'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8')

function cruise(
  over: {
    modules?: CruiseResult['modules']
    summary?: Partial<CruiseResult['summary']>
  } = {},
): CruiseResult {
  return {
    modules: over.modules ?? [],
    summary: {
      violations: over.summary?.violations ?? [],
      totalCruised: over.summary?.totalCruised ?? 0,
    },
  }
}

const CYCLE = {
  rule: { name: 'no-circular' },
  from: 'packages/backend/src/services/scheduler.ts',
  to: 'packages/backend/src/services/task.ts',
}

const KNOWN_CYCLE: KnownViolation = {
  rule: 'no-circular',
  from: CYCLE.from,
  to: CYCLE.to,
  why: 'test fixture',
  removeWhen: 'test fixture',
}

describe('depcheck — 违规身份', () => {
  test('身份是 (规则, 起点, 终点) 三元组', () => {
    expect(violationKey(CYCLE)).toBe(
      'no-circular|packages/backend/src/services/scheduler.ts|packages/backend/src/services/task.ts',
    )
  })

  test('同一起点、不同环下一跳算两条违规', () => {
    // execution/executor.ts 同时参与两个环族，靠 `to` 区分——身份少了 `to`
    // 就会把其中一条静默吞掉。
    const a = violationKey({ ...CYCLE, to: 'packages/backend/src/services/task.ts' })
    const b = violationKey({ ...CYCLE, to: 'packages/backend/src/services/workgroup/launch.ts' })
    expect(a).not.toBe(b)
  })
})

describe('depcheck — 第一方判定（棘轮的判据面）', () => {
  test.each([
    ['./runner', true],
    ['../util/git', true],
    ['@/services/task', true],
    ['@agent-workflow/shared', true],
    ['bun', false],
    ['vite/client', false],
    ['@modelcontextprotocol/sdk/client/stdio.js', false],
    ['hono/utils/http-status', false],
  ])('%s → 第一方=%s', (specifier, expected) => {
    expect(isFirstPartySpecifier(specifier as string)).toBe(expected)
  })
})

describe('depcheck — 判定逻辑', () => {
  test('允许列表内的违规被接受，门禁不阻塞', () => {
    const v = evaluateCruises([cruise({ summary: { violations: [CYCLE] } })], [KNOWN_CYCLE])
    expect(v.accepted).toHaveLength(1)
    expect(v.unknown).toHaveLength(0)
    expect(v.stale).toHaveLength(0)
    expect(isBlocking(v)).toBe(false)
  })

  test('允许列表外的违规阻塞门禁', () => {
    const fresh = { ...CYCLE, from: 'packages/backend/src/services/brand-new.ts' }
    const v = evaluateCruises([cruise({ summary: { violations: [fresh] } })], [KNOWN_CYCLE])
    expect(v.unknown).toHaveLength(1)
    expect(isBlocking(v)).toBe(true)
  })

  test('允许列表条目不再触发 → stale → 阻塞（允许列表只能缩）', () => {
    const v = evaluateCruises([cruise()], [KNOWN_CYCLE])
    expect(v.stale).toEqual([KNOWN_CYCLE])
    expect(isBlocking(v)).toBe(true)
  })

  test('跨 package 重复报告的同一条违规只算一次、且不会被判 stale', () => {
    // shared 的 outputKinds 环在 backend / frontend / shared 三次 cruise 里
    // 都会被报告；按 package 分别判定会让它在其中两次里显得「不存在」。
    const r = cruise({ summary: { violations: [CYCLE] } })
    const v = evaluateCruises([r, r, r], [KNOWN_CYCLE])
    expect(v.accepted).toHaveLength(1)
    expect(v.stale).toHaveLength(0)
  })

  test('第一方边解析不了 → 阻塞（这就是 A1 那个失明形态）', () => {
    const v = evaluateCruises(
      [
        cruise({
          modules: [
            {
              source: 'packages/backend/src/services/scheduler.ts',
              dependencies: [{ module: '@/services/task', couldNotResolve: true }],
            },
          ],
        }),
      ],
      [],
    )
    expect(v.unresolvedFirstParty).toEqual([
      { from: 'packages/backend/src/services/scheduler.ts', specifier: '@/services/task' },
    ])
    expect(isBlocking(v)).toBe(true)
  })

  test('外部包解析不了只计数、不阻塞（否则每次依赖升级都随机变红）', () => {
    const v = evaluateCruises(
      [
        cruise({
          modules: [
            {
              source: 'packages/backend/src/mcp/server.ts',
              dependencies: [
                { module: '@modelcontextprotocol/sdk/server/mcp.js', couldNotResolve: true },
                { module: 'bun', couldNotResolve: true },
              ],
            },
          ],
        }),
      ],
      [],
    )
    expect(v.unresolvedExternal).toBe(2)
    expect(v.unresolvedFirstParty).toHaveLength(0)
    expect(isBlocking(v)).toBe(false)
  })

  test('通过时的输出说明「看见了多少」，不是一句空绿', () => {
    const lines = formatVerdict(evaluateCruises([cruise({ summary: { totalCruised: 1223 } })], []))
    expect(lines.join('\n')).toContain('1223 个模块')
  })

  test('失明时的输出直接点名 A1，不让人靠放宽判据来「修」', () => {
    const v = evaluateCruises(
      [
        cruise({
          modules: [{ source: 'a.ts', dependencies: [{ module: '@/b', couldNotResolve: true }] }],
        }),
      ],
      [],
    )
    const text = formatVerdict(v).join('\n')
    expect(text).toContain('门禁看不见这部分图')
    expect(text).toContain('不要')
  })
})

describe('depcheck — 允许列表纪律', () => {
  test('每条都写了 why 与 removeWhen', () => {
    for (const k of KNOWN_VIOLATIONS) {
      expect(k.why.trim().length, `${k.from} → ${k.to} 缺 why`).toBeGreaterThan(0)
      expect(k.removeWhen.trim().length, `${k.from} → ${k.to} 缺 removeWhen`).toBeGreaterThan(0)
    }
  })

  test('removeWhen 不允许写成「以后再说」', () => {
    // 判据是**禁空泛**而不是「必须命中某几个词」——后者只会逼人凑关键词。
    const VAGUE = /以后|将来|有空|再说|待定|看情况|TODO|不确定|尽快/
    for (const k of KNOWN_VIOLATIONS) {
      expect(k.removeWhen, `${k.from} → ${k.to} 的 removeWhen 太空泛`).not.toMatch(VAGUE)
      expect(k.removeWhen.trim().length, `${k.from} → ${k.to} 的 removeWhen 太短`).toBeGreaterThan(
        10,
      )
    }
  })

  test('每条要么排进工作包 / RFC，要么显式声明为独立切片', () => {
    // 「已排期」和「明知未排期」都可以，**没表态**不行——后者正是允许列表
    // 悄悄长成永久豁免的方式。
    for (const k of KNOWN_VIOLATIONS) {
      expect(k.removeWhen, `${k.from} → ${k.to} 既没排期也没声明为独立切片`).toMatch(
        /WP-\d|RFC-\d{3}|独立切片/,
      )
    }
  })

  test('没有重复条目（重复会让 stale 检测永远抓不到其中一条）', () => {
    const keys = KNOWN_VIOLATIONS.map((k) => violationKey({ ...k, rule: { name: k.rule } }))
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('引用的规则名都在 dependency-cruiser 配置里真实存在', () => {
    const cfg = read('.dependency-cruiser.cjs')
    for (const rule of new Set(KNOWN_VIOLATIONS.map((k) => k.rule))) {
      expect(cfg, `配置里没有规则 ${rule}`).toContain(`name: '${rule}'`)
    }
  })

  test('路径都是仓库相对的 packages/<pkg>/src 形状', () => {
    for (const k of KNOWN_VIOLATIONS) {
      for (const p of [k.from, k.to]) {
        expect(p, `${p} 不是仓库相对路径`).toMatch(/^packages\/(backend|frontend|shared)\/src\//)
      }
    }
  })
})

describe('depcheck — 接线与反悔防护', () => {
  test('package.json 的 depcheck 调本脚本，而不是裸 depcruise', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts.depcheck).toBe('bun run scripts/depcheck.ts')
  })

  test('CI 仍然跑 depcheck（没人跑的规则不是锁）', () => {
    expect(read('.github/workflows/ci.yml')).toContain('bun run depcheck')
  })

  test('配置不得再把 tsConfig 指回 tsconfig.base.json', () => {
    // 这正是 A1 的成因：base 没有 paths，@/ 全部解析失败被静默丢弃。
    // 只看代码，不看注释——文件头就在复述那条旧配置作为病历。
    const code = read('.dependency-cruiser.cjs')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n')
    expect(code).not.toMatch(/fileName:\s*'tsconfig\.base\.json'/)
    expect(code).toContain('DEPCRUISE_TSCONFIG')
  })

  test('tsconfig.base.json 确实没有 paths —— 上一条不是空防', () => {
    // 若哪天 base 补上了 paths，上面那条 lock 的理由就变了，这里会红，逼人
    // 回来重新判断而不是照抄。
    expect(read('tsconfig.base.json')).not.toContain('"paths"')
  })

  test('每个 package 的 tsconfig 都定义了 @/* —— per-package 跑法的前提', () => {
    for (const pkg of PACKAGES) {
      const ts = read(`packages/${pkg}/tsconfig.json`)
      if (pkg === 'shared') continue // shared 不用 @/ 别名
      expect(ts, `packages/${pkg}/tsconfig.json 缺 @/* paths`).toContain('"@/*"')
    }
  })

  test('配置在拿不到 per-package tsconfig 时 fail-closed（不静默失明）', () => {
    const cfg = read('.dependency-cruiser.cjs')
    expect(cfg).toContain('throw new Error')
    // 静态断言不够——真的 require 一次，确认它抛而不是退回某个默认值。
    const prev = process.env.DEPCRUISE_TSCONFIG
    delete process.env.DEPCRUISE_TSCONFIG
    try {
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require(resolve(REPO_ROOT, '.dependency-cruiser.cjs'))
      }).toThrow(/DEPCRUISE_TSCONFIG/)
    } finally {
      if (prev !== undefined) process.env.DEPCRUISE_TSCONFIG = prev
    }
  })

  test('no-circular 不得退回按文件排除的 from.pathNot 允许列表', () => {
    // 旧写法排除的是**文件**，等于连带放过未来经过 scheduler.ts / task.ts 的
    // 每一个新环——而新环恰恰最爱从这两个文件长出来。
    const cfg = read('.dependency-cruiser.cjs')
    const rule = cfg.slice(cfg.indexOf("name: 'no-circular'"))
    expect(rule.slice(0, rule.indexOf('},\n  ],'))).not.toContain('pathNot')
  })
})
