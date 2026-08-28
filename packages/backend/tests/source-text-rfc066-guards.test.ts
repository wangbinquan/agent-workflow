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
    // RFC-248 T26: 原来的结束锚点是 RFC-066 多仓分支的注释，那个分支已被删除
    // （多仓一律走 `materializeGroupSpace`）。守卫的意图不变——单仓分支不得传
    // `overrideWorktreePath`——只是结束锚点改成接替它的退役抛错注释。
    const singlePathSection = extractSection(
      TASK_SRC,
      'RFC-066: single-path byte-baseline branch',
      'RFC-248 T26',
    )
    expect(singlePathSection.length).toBeGreaterThan(0)
    expect(singlePathSection.includes('overrideWorktreePath')).toBe(false)

    // 组路径**是**合法的 override 消费方——确认它确实在用，否则上面的断言会
    // 因为「全仓库都没人传 override」而变成空守卫。
    const groupSection = extractSection(
      TASK_SRC,
      'async function materializeGroupSpace',
      'RFC-066: single-path byte-baseline branch',
    )
    expect(groupSection.includes('overrideWorktreePath')).toBe(true)
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

  test('G5 RFC-248 D9/D12：两条多仓禁令已解除，错误码不得复活', () => {
    // 这条守卫**翻转**了。RFC-066 当年在 startTask 里拦掉「多仓 + wrapper-git」
    // 与「多仓 + 上传」，原断言锁的是那两个错误码存在。RFC-248 解除了两条禁令：
    //   - wrapper-git 现在逐仓快照、逐仓 diff，路径按挂载路径前缀化后合并成
    //     `list<path>`。不解除的话仓库组永远用不了 Code → Audit → Fix 主链路。
    //   - 上传物落到任务根下的 `.agent-workflow/inputs/`，不属于任何成员仓。
    // 断言改成「这两个码在生产代码里彻底消失」——留一个就意味着某条路径上禁令
    // 还在，组任务会在那里撞墙。
    expect(TASK_SRC.includes("'multi-repo-wrapper-git-unsupported'")).toBe(false)
    expect(TASK_SRC.includes("'multi-repo-upload-unsupported'")).toBe(false)
    for (const rel of [
      'src/routes/tasks.ts',
      'src/services/agentLaunch.ts',
      'src/services/scheduler.ts',
      'src/modules/task-execution/composition/wrapperMechanics.ts',
    ]) {
      const src = readFileSync(resolve(import.meta.dir, '..', rel), 'utf8')
      expect(src.includes("'multi-repo-wrapper-git-unsupported'")).toBe(false)
      expect(src.includes("'multi-repo-upload-unsupported'")).toBe(false)
    }
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

// RFC-317 T14 —— 负 fixture：把伪造的输入喂给**上面扫描用的同一份判据**。
//
// 本文件的所有断言都建立在 `extractSection` 之上：先按 marker 切出一段，再在段内
// 断言某标识符在 / 不在。marker 一旦在生产代码里被改名，`extractSection` 会抛而不是
// 静默返回空——这是好事，但**切错边界**（结束 marker 提前命中）不会抛：段被截短，
// 段内断言「某标识符不在」于是永远成立。这里把切分语义本身钉住。
describe('RFC-317 T14 —— matcher 自证：段落切分必须切在正确的边界上', () => {
  const fabricated =
    '// head\n' +
    '// RFC-066: single-path byte-baseline branch\n' +
    'const inside = overrideWorktreePath(x)\n' +
    '// RFC-066: group branch\n' +
    'const outside = overrideWorktreePath(y)\n'

  test('只切出起止 marker 之间的内容，结束 marker 之后的不算', () => {
    const section = extractSection(
      fabricated,
      '// RFC-066: single-path byte-baseline branch',
      '// RFC-066: group branch',
    )
    expect(section.includes('const inside')).toBe(true)
    expect(section.includes('const outside')).toBe(false)
  })

  test('marker 找不到时抛错，而不是静默返回空段（空段会让段内「零出现」断言假绿）', () => {
    expect(() =>
      extractSection(fabricated, '// 不存在的 marker', '// RFC-066: group branch'),
    ).toThrow(/start marker not found/)
    expect(() =>
      extractSection(fabricated, '// RFC-066: single-path byte-baseline branch', '// 不存在的结束'),
    ).toThrow(/end marker not found/)
  })
})

// RFC-317 T13 —— 语料非空。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('迁移语料确实枚举得到（扫空即假绿）', () => {
    expect(
      readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length,
    ).toBeGreaterThanOrEqual(150)
  })
})
