// RFC-319 R1 —— 「哪些端点一次都没被 e2e 打到」的账本守卫。
//
// 判据的两端都必须是活的：
//   分母 = `allRouteMeta()`（框架在 createApp 之后实际持有的声明表，计算路径与
//          `src/routes/` 之外的挂载都逃不掉——这正是 RFC-317 T52 用它替换正则
//          扫描器的原因）。
//   分子 = 运行期实测（`e2e/route-journal.ts` 从 daemon 请求日志捞的 `req` 行）。
//
// **两档运行**：
//   ① 没有 journal（`gate:local`、PR 的 backend 分片）——只做结构检查：账本里的
//      每一条今天确实挂着、排序去重、语料上下界。这些是纯静态的，秒级。
//   ② 有 journal（`e2e-full-nightly` 设 `AW_E2E_ROUTE_JOURNAL`）——做完整对账。
//
// 为什么完整对账**只**在全量腿上成立：PR 腿只跑 PR 档（`--grep-invert @nightly`），
// 它的命中集合天然小于全量，拿它比账本会得到一份错误的、过大的未命中集合，
// 于是账本会被「修」成一个更宽松的值。判据必须和它的语料同档。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { EXEMPT_MOUNTS, allRouteMeta } from '@/routes/registry'

import { buildContractHarness } from '../contracts/harness'
import { buildHitReport, parseLedger, readJournalDir } from './routeHitLedger'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const LEDGER_PATH = resolve(REPO_ROOT, 'architecture', 'e2e-endpoint-coverage.json')
const LEDGER = parseLedger(readFileSync(LEDGER_PATH, 'utf8'))

/** 只有显式给了 journal 目录才做完整对账——见文件头「两档运行」。 */
const JOURNAL_DIR = process.env.AW_E2E_ROUTE_JOURNAL ?? null

function declaredRoutes(): Array<{ method: string; path: string }> {
  return allRouteMeta().map((m) => ({ method: m.method, path: m.path }))
}

describe('RFC-319 R1 —— 端点命中账本的结构（无 journal 也必须成立）', () => {
  test('语料非空：声明表本身取到了东西（取空即假绿）', async () => {
    await buildContractHarness()
    expect(
      declaredRoutes().length,
      '`allRouteMeta()` 取空说明 createApp 没挂上路由——此时任何「未覆盖集合」都是垃圾',
    ).toBeGreaterThan(400)
  })

  test('账本升序去重（顺序不稳会让 diff 噪声淹没真实变化）', () => {
    const sorted = [...LEDGER.uncovered].sort()
    expect(LEDGER.uncovered).toEqual(sorted)
    expect(new Set(LEDGER.uncovered).size).toBe(LEDGER.uncovered.length)
  })

  test('账本里的每一条**今天确实挂着**（写错的条目会永久占坑）', async () => {
    await buildContractHarness()
    const mounted = new Set(declaredRoutes().map((r) => `${r.method} ${r.path}`))
    const phantom = LEDGER.uncovered.filter((entry) => !mounted.has(entry))
    expect(
      phantom,
      '账本里有已经不存在的端点。端点被删时账本必须同批缩小——' +
        '否则那一条会永远躺在那里，把「债还了多少」这个数字变成假的',
    ).toEqual([])
  })

  test('账本既不为空也没吞下整张表（两个方向的空转都要红）', async () => {
    await buildContractHarness()
    const total = declaredRoutes().length
    expect(
      LEDGER.uncovered.length,
      '账本清零意味着「每个端点都被 e2e 打过」。真到那天，把这条下界一起改掉——' +
        '在那之前，0 更可能是聚合器坏了',
    ).toBeGreaterThan(0)
    expect(
      LEDGER.uncovered.length,
      '未覆盖数不该超过声明总数——超了说明归一器把注册形态也算成了未覆盖',
    ).toBeLessThanOrEqual(total)
  })
})

describe.skipIf(JOURNAL_DIR === null)('RFC-319 R1 —— 全量跑后的逐条对账', () => {
  test('journal 非空（采集失效时必须红，不能静默当成「全都没覆盖」）', () => {
    const journal = readJournalDir(JOURNAL_DIR!)
    expect(
      journal.files,
      `${JOURNAL_DIR} 下没有 journal 文件。设了 AW_E2E_ROUTE_JOURNAL 却采不到东西，` +
        '说明 harness 的采集钩子没跑（或跑在了 rmSync 之后）——这不是「零覆盖」',
    ).toBeGreaterThan(0)
    expect(
      journal.entries.length,
      'journal 文件在但一条都没解析出来——多半是日志格式变了，去看 e2e/route-journal.ts 的解析器',
    ).toBeGreaterThan(100)
  })

  test('未命中集合与账本逐条相等', async () => {
    await buildContractHarness()
    const report = buildHitReport(declaredRoutes(), readJournalDir(JOURNAL_DIR!))
    expect(
      report.uncovered,
      '新挂了端点却没有任何 e2e 打它（把它加进账本并说明原因），' +
        '或者补了 e2e 却没把账本一起改小（差额会变成下一个人的免费槽位）',
    ).toEqual([...LEDGER.uncovered])
  })

  test('反方向：日志里不该出现注册表没有的 /api 路径', async () => {
    await buildContractHarness()
    const report = buildHitReport(declaredRoutes(), readJournalDir(JOURNAL_DIR!))
    const apiZombies = report.unresolved.filter((key) => {
      const path = key.slice(key.indexOf(' ') + 1).split('?')[0]!
      // `/api/mcp` is deliberately mounted as an ALL transport rather than a
      // REST RouteMeta; authorization is per tool. Keep this reverse check on
      // the same explicit exemption set as the forward mount gate.
      return path.startsWith('/api/') && !EXEMPT_MOUNTS.has(path)
    })
    expect(
      apiZombies,
      '有 /api 请求对不上任何注册路由：要么归一器写错了，要么有路径绕过了 allRouteMeta()。' +
        '两种都不能静默——这条与 api-contract-coverage 的「e2e 打了已删端点」形成闭环',
    ).toEqual([])
  })
})
