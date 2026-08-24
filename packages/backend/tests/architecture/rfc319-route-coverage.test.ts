// RFC-319 R2 —— 「哪些前端路由从未被 e2e 真实加载过」的账本守卫。
//
// 分母派生自 `router.tsx` 路由树与各 route 文件的 `createRoute({ path })`；
// 分子是同一份 route journal 里的非 `/api` 文档请求。判据与 R1 同构，也分两档：
// 没有 journal 时只做结构检查，有 journal 时逐条对账。
//
// 这条守卫多一件 R1 没有的事：**新加页面的即时拦截**。新增一条路由却在 `e2e/**`
// 里连字面量都没出现过，说明这个页面从未进过任何人的视野——这件事不必等到当晚的
// 全量腿，`gate:local` 就该红。所以下面有一条纯静态的 `mentionedSomewhere` 检查。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  buildRouteCoverage,
  deriveFrontendRoutes,
  staticallyMentioned,
  type FrontendRoute,
} from './frontendRouteCoverage'
import { readJournalDir, buildHitReport } from './routeHitLedger'
import { allRouteMeta } from '@/routes/registry'
import { buildContractHarness } from '../contracts/harness'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const E2E_DIR = resolve(REPO_ROOT, 'e2e')
const LEDGER_PATH = resolve(REPO_ROOT, 'architecture', 'e2e-route-coverage.json')

interface RouteLedger {
  readonly schemaVersion: number
  readonly uncovered: readonly string[]
  readonly mentionedButNeverLoaded: readonly string[]
}
const LEDGER = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as RouteLedger

const JOURNAL_DIR = process.env.AW_E2E_ROUTE_JOURNAL ?? null

function routes(): FrontendRoute[] {
  return deriveFrontendRoutes(
    resolve(REPO_ROOT, 'packages', 'frontend', 'src', 'routes'),
    resolve(REPO_ROOT, 'packages', 'frontend', 'src', 'router.tsx'),
  )
}

describe('RFC-319 R2 —— 前端路由账本的结构', () => {
  test('语料非空：路由树确实解析出了东西', () => {
    expect(
      routes().length,
      '一条路由都派生不出来 ⇒ 解析器瞎了（路由声明换了写法？）。' +
        '此时「未覆盖集合」为空，是最典型的空转绿',
    ).toBeGreaterThan(40)
  })

  test('账本升序去重', () => {
    expect(LEDGER.uncovered).toEqual([...LEDGER.uncovered].sort())
    expect(new Set(LEDGER.uncovered).size).toBe(LEDGER.uncovered.length)
  })

  test('账本里的每条路由今天确实存在（页面删了要同批销账）', () => {
    const known = new Set(routes().map((r) => r.path))
    const phantom = LEDGER.uncovered.filter((p) => !known.has(p))
    expect(phantom, '账本里有已经不存在的路由——它占着一个永远不会被销的坑').toEqual([])
  })

  test('诊断栏是主栏的子集（两栏之间不能各说各话）', () => {
    const main = new Set(LEDGER.uncovered)
    expect(LEDGER.mentionedButNeverLoaded.filter((p) => !main.has(p))).toEqual([])
  })

  test('**新页面必须留下痕迹**：不在账本里的路由，e2e 源码里至少要提到它', () => {
    const ledgered = new Set(LEDGER.uncovered)
    const invisible = routes()
      .filter((r) => !ledgered.has(r.path))
      // 根路由没有任何字面量段可查——`staticallyMentioned('/')` 结构上无法给出
      // 有意义的答案。它的证据只能来自运行期文档加载（今天的 journal 里确实有
      // `GET /`），由下面那个 describe 的逐条对账负责。这里显式跳过而不是让
      // helper 对它返回 true：helper 一旦有「恒真」分支，下一个人就会拿它当挡箭牌。
      .filter((r) => r.path !== '/')
      .filter((r) => !staticallyMentioned(E2E_DIR, r.path))
      .map((r) => `${r.path}（${r.source}）`)
    expect(
      invisible,
      '新增了页面但整个 e2e/ 里连它的路径字面量都没有。' +
        '要么补一条 spec，要么把它加进 architecture/e2e-route-coverage.json 并说明为什么欠着——' +
        '账本条目数由 rfc317-ledger-highwater 管着，加进去这件事本身会被记账',
    ).toEqual([])
  })
})

describe.skipIf(JOURNAL_DIR === null)('RFC-319 R2 —— 全量跑后的逐条对账', () => {
  test('未被文档加载过的路由与账本逐条相等', async () => {
    await buildContractHarness()
    const declared = allRouteMeta().map((m) => ({ method: m.method, path: m.path }))
    const journal = readJournalDir(JOURNAL_DIR!)
    expect(journal.files, 'journal 为空时这条对账毫无意义，必须先红').toBeGreaterThan(0)
    const hit = buildHitReport(declared, journal)
    const documentLoads = hit.unresolved
      .filter((k) => k.startsWith('GET /') && !k.includes(' /api/') && !k.startsWith('GET /assets/'))
      .map((k) => k.slice(4).split('?')[0]!)
    expect(
      documentLoads.length,
      '一个文档请求都没有 ⇒ 这次跑根本没打开过页面，账本对账无效',
    ).toBeGreaterThan(20)
    const cov = buildRouteCoverage({ routes: routes(), e2eDir: E2E_DIR, documentLoads })
    expect(
      cov.uncovered,
      '新增了页面却没有任何 spec 真正加载它，或者补了 spec 却没把账本一起改小',
    ).toEqual([...LEDGER.uncovered])
  })
})
