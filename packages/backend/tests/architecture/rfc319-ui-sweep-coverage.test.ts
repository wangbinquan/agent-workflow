// RFC-319 UX-19 / UX-45 / UX-46 / UX-47 —— 三套全站扫描的**覆盖面本身**的机器判据。
//
// 这四条能力问的不是「某一页有没有无障碍问题」，而是**扫描本身覆盖了多少、
// 谁在保证它跟得上路由表**。这类问题此前一条判据都没有：
//
//   * `e2e/focus-ring-clip.spec.ts` 的 `ROUTES` 是一张**手抄清单**（21 条）。
//     它扫得很认真——一条被裁掉的焦点环就是阻塞失败、没有豁免通道——但没有任何
//     东西保证这张清单跟得上路由表。新加一页，它默认不在清单里，于是**静默地**
//     不被扫；改名一页，那一条变成幽灵，也是**静默地**少扫一页。两种漂移都不会红。
//   * `e2e/a11y.spec.ts` 更隐蔽：它没有清单，扫哪几页是由**散落的 `page.goto`**
//     决定的。删掉一条 `test(...)` 就等于把那一页移出了无障碍门，而 diff 里看到的
//     只是「少了一个测试」。
//   * 视觉基线两个方向都会烂：磁盘上留着没人再引用的 `.png`（场景删了、基线忘删，
//     此后它永远不被比对，却让人以为"这一屏有基线"），或者 spec 里写了一个磁盘上
//     根本没有的基线名（那一格在 CI 上要么首跑就红、要么被当成"新基线"接受）。
//   * 视觉门的**触发条件**是 push 与 pull_request 两份**各自独立**的路径过滤清单，
//     各 20 条、手抄、彼此重复。两份一旦漂移，就出现最难查的那种形态：PR 绿、
//     合进 main 之后夜里红，或者反过来——PR 上根本没跑过这道门。
//
// 判据的分母全部来自活的来源：路由表用 R2 那套 `deriveFrontendRoutes`（router.tsx
// 路由树 + 各 route 文件的 `createRoute({ path })`），基线用磁盘上的实际文件，
// 触发条件用 workflow 原文。下面两张「未扫描」清单是**棘轮**，在
// `architecture/ledger-baselines.json` 里登记，只许缩不许涨：新增一页要么进扫描，
// 要么显式写进清单——两条路都会在 diff 里看得见，这正是此前缺的那一环。

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { deriveFrontendRoutes } from './frontendRouteCoverage'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

function repoFile(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}

/** 今天真实挂着的**无参**前端路由——有参路由需要具体实体，不属于「整页可扫」。 */
function staticRoutes(): string[] {
  return deriveFrontendRoutes(
    resolve(REPO_ROOT, 'packages', 'frontend', 'src', 'routes'),
    resolve(REPO_ROOT, 'packages', 'frontend', 'src', 'router.tsx'),
  )
    .map((r) => r.path)
    .filter((p) => !p.includes('$'))
    .sort()
}

/** `focus-ring-clip.spec.ts` 里那张手抄清单。 */
function focusRingSweptRoutes(): string[] {
  const source = repoFile('e2e/focus-ring-clip.spec.ts')
  const at = source.indexOf('const ROUTES = [')
  expect(at, 'focus-ring spec 里找不到 `const ROUTES = [` ⇒ 这条守卫失去了锚点，改锚点而不是删断言').toBeGreaterThan(0)
  const block = source.slice(at)
  return [...block.slice(0, block.indexOf(']')).matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

/**
 * `a11y.spec.ts` 实际扫到的无参页面。
 *
 * 它没有清单，只有散落的 `page.goto(`${daemon.baseUrl}...`)`，所以这里就照它实际
 * 的样子解析——判据必须描述**现状**，不是描述我们希望它长成的样子。
 */
function axeSweptRoutes(): string[] {
  const source = repoFile('e2e/a11y.spec.ts')
  const hits = [...source.matchAll(/page\.goto\(`\$\{daemon\.baseUrl\}([^`]*)`\)/g)]
    .map((m) => m[1]!.split('?')[0]!)
    .filter((p) => !p.includes('${'))
  return [...new Set(hits)].sort()
}

// ------------------------------------------------------------- 判据（纯函数）
//
// 这三条判据被**扫描用例与负 fixture 共用**。判据留在 test 体里的话，fixture 就只能
// 喂给一份拷贝，证明的是拷贝还活着——扫描那份停止工作照样不会红（RFC-317 T14 记的
// 就是这个失效形态）。

/** 清单里今天已经不存在的条目。 */
export function phantomEntries(live: readonly string[], listed: readonly string[]): string[] {
  const alive = new Set(live)
  return listed.filter((entry) => !alive.has(entry))
}

/** 存在、但不在扫描清单里的条目。 */
export function unsweptEntries(live: readonly string[], swept: readonly string[]): string[] {
  const covered = new Set(swept)
  return live.filter((entry) => !covered.has(entry))
}

/**
 * spec 已经不再引用的孤儿基线。
 *
 * 基线按平台分文件（`-chromium-linux` / `-darwin` / `-win32`），spec 里写的是去掉
 * 平台后缀的场景名，所以三种后缀都要剥——只剥 linux 会把另外两个平台的基线全判成孤儿。
 */
export function orphanBaselines(files: readonly string[], specSource: string): string[] {
  return files.filter(
    (f) => !specSource.includes(f.replace(/-chromium-(?:linux|darwin|win32)\.png$/, '')),
  )
}

// ---------------------------------------------------------------- 棘轮清单

/**
 * 存在、无参、但**不在焦点环扫描里**的页面。只许缩。
 *
 * 每一条都意味着：这一页上任何一个被祖先容器裁掉的焦点环，键盘用户看不见，
 * 而 CI 不会告诉任何人。
 */
const FOCUS_RING_UNSWEPT = [
  '/auth',
  '/code',
  '/code/assignments',
  '/code/executors',
  '/code/missions',
  '/code/missions/new',
  '/code/outcomes',
  '/code/policies',
  '/digital-employees',
  '/docs/api',
  '/events',
  '/intent',
  '/onboarding',
  '/outcomes',
  '/setup/admin',
  '/webhooks',
  '/workflows/new',
  '/workgroups/launch',
]

/**
 * 存在、无参、但**不在 axe 整页扫描里**的页面。只许缩。
 *
 * axe 的语料比焦点环还小（10 页 / 39 页）：`/tasks`、`/users`、`/scheduled`、
 * `/reviews` 这些每天都在用的主屏，从来没有被 wcag2a/2aa 扫过。
 */
const AXE_UNSWEPT = [
  '/account',
  '/clarify',
  '/code',
  '/code/assignments',
  '/code/executors',
  '/code/missions',
  '/code/missions/new',
  '/code/outcomes',
  '/code/policies',
  '/digital-employees',
  '/docs/api',
  '/events',
  '/intent',
  '/mcps',
  '/mcps/new',
  '/outcomes',
  '/plugins',
  '/plugins/new',
  '/reviews',
  '/scheduled',
  '/setup/admin',
  '/skills',
  '/tasks',
  '/tasks/new',
  '/users',
  '/webhooks',
  '/workflows/new',
  '/workgroups',
  '/workgroups/launch',
]

describe('RFC-319 UX-47 —— 两套全站扫描的清单必须跟得上路由表', () => {
  test('语料非空：路由表本身取到了东西（取空即假绿）', () => {
    // 没有这条，下面每一条「未扫描集合逐条相等」在解析器坏掉时都会变成
    // 「空 === 空」的空转，而那正是覆盖面判据最典型的失效形态。
    expect(
      staticRoutes().length,
      '派生不出前端无参路由 ⇒ 本文件所有覆盖面断言都在拿空集合互相印证',
    ).toBeGreaterThan(30)
    expect(focusRingSweptRoutes().length).toBeGreaterThan(15)
    expect(axeSweptRoutes().length).toBeGreaterThan(5)
  })

  test('focus-ring 的手抄清单里没有幽灵（改名的路由会静默少扫一页）', () => {
    expect(
      phantomEntries(staticRoutes(), focusRingSweptRoutes()),
      '清单里有今天已经不存在的路由。它不会报错——`page.goto` 一个不存在的路由只会' +
        '渲染 404 壳子，扫出 0 个控件、0 个违规，看起来和「干净」一模一样',
    ).toEqual([])
  })

  test('axe 扫到的每一页也都是真实路由', () => {
    expect(
      phantomEntries(staticRoutes(), axeSweptRoutes()),
      'a11y spec 在扫一个不存在的路径 ⇒ 那一格永远绿，因为它什么也没扫到',
    ).toEqual([])
  })

  test('未被 focus-ring 扫的页面集合与声明清单逐条相等', () => {
    expect(
      unsweptEntries(staticRoutes(), focusRingSweptRoutes()),
      '新加了页面却既没进焦点环扫描、也没写进 FOCUS_RING_UNSWEPT ⇒ 它被静默地漏掉了；' +
        '或者补了扫描却没把清单一起改小，那个差额会变成下一个人的免费槽位',
    ).toEqual(FOCUS_RING_UNSWEPT)
  })

  test('未被 axe 扫的页面集合与声明清单逐条相等', () => {
    expect(
      unsweptEntries(staticRoutes(), axeSweptRoutes()),
      '新加了页面却既没进 axe 扫描、也没写进 AXE_UNSWEPT ⇒ 它从未被无障碍门看过一眼',
    ).toEqual(AXE_UNSWEPT)
  })

  test('两张清单都升序去重（顺序不稳会让 diff 噪声淹没真实变化）', () => {
    for (const [name, list] of [
      ['FOCUS_RING_UNSWEPT', FOCUS_RING_UNSWEPT],
      ['AXE_UNSWEPT', AXE_UNSWEPT],
    ] as const) {
      expect([...list].sort(), `${name} 没有升序`).toEqual([...list])
      expect(new Set(list).size, `${name} 有重复条目`).toBe(list.length)
    }
  })
})

describe('RFC-319 UX-19 —— axe 整页扫描的覆盖面下界', () => {
  test('扫描页数既有下界也不为全量（两个方向的空转都要红）', () => {
    const swept = axeSweptRoutes()
    const total = staticRoutes().length
    expect(
      swept.length,
      'axe 扫描页数跌破下界 ⇒ 有人删掉了整页扫描用例，而 diff 里看起来只是「少了一个测试」',
    ).toBeGreaterThanOrEqual(10)
    expect(
      swept.length,
      '扫描页数等于路由总数说明解析器把所有路由都当成扫过了——真到那天，' +
        '把 AXE_UNSWEPT 清空并改掉这条上界',
    ).toBeLessThan(total)
  })

  test('未授权落地页 /auth 始终在扫描面内（它是唯一一个所有人都会看到的页面）', () => {
    expect(
      axeSweptRoutes(),
      '/auth 掉出了无障碍扫描 ⇒ 连还没登录的人都读不了的页面，没有任何门在看',
    ).toContain('/auth')
  })
})

describe('RFC-319 UX-45 —— 视觉基线的覆盖面（磁盘与 spec 双向对账）', () => {
  const CANON_DIR = 'e2e/visual-regression.spec.ts-snapshots'
  const RFC250_DIR = 'e2e/rfc250-visual-states.spec.ts-snapshots'

  function baselines(dir: string): string[] {
    return readdirSync(resolve(REPO_ROOT, dir)).filter((f) => f.endsWith('.png'))
  }

  test('canonical 视觉套件的基线数不低于下界', () => {
    // 下界是语料规模断言：扫描根一旦失效（目录改名、后缀改了），下面的孤儿对账会
    // 退化成「空 === 空」的假绿，而那正是覆盖面判据最典型的失效形态。
    // `readdirSync` 直接写在这里而不是走 `baselines()`：census 的 `corpusFloor`
    // 要沿着**本作用域**把被断言的量追回枚举调用，隔一层局部 helper 就追不回来，
    // 这条下界会被记成「没有下界」（RFC-317 T13 因此变红）。
    const files = readdirSync(resolve(REPO_ROOT, CANON_DIR)).filter((f) => f.endsWith('.png'))
    expect(
      files.length,
      `${CANON_DIR} 的基线掉到下界以下 ⇒ 有人删了基线却没删场景，` +
        '那些场景此后要么首跑就红、要么被当成「新基线」照单全收',
    ).toBeGreaterThanOrEqual(100)
  })

  test('RFC-250 高危交互态的基线数不低于下界', () => {
    const files = readdirSync(resolve(REPO_ROOT, RFC250_DIR)).filter((f) => f.endsWith('.png'))
    expect(files.length).toBeGreaterThanOrEqual(20)
  })

  test('两个快照目录里都没有 spec 已经不再引用的孤儿基线', () => {
    // 孤儿基线是「有基线」这件事的假象：它躺在磁盘上，谁看目录都以为这一屏有人在守，
    // 实际上再也没有任何一格会去比对它。
    for (const [spec, dir] of [
      ['e2e/visual-regression.spec.ts', CANON_DIR],
      ['e2e/rfc250-visual-states.spec.ts', RFC250_DIR],
    ] as const) {
      expect(
        orphanBaselines(baselines(dir), repoFile(spec)),
        `${dir} 下有 ${spec} 已经不再引用的基线 ⇒ 场景删了、基线忘删，` +
          '目录看起来覆盖面很宽，实际那几张再也不会被比对',
      ).toEqual([])
    }
  })
})

describe('RFC-319 UX-46 —— 视觉门的触发条件本身', () => {
  const WORKFLOW = '.github/workflows/visual-regression-nightly.yml'

  /** 取 `push:` / `pull_request:` 各自那张手抄的 `paths:` 清单。 */
  function pathFilters(kind: 'push' | 'pull_request'): string[] {
    const lines = repoFile(WORKFLOW).split('\n')
    const start = lines.findIndex((l) => l === `  ${kind}:`)
    expect(start, `workflow 里找不到 ${kind} 触发器`).toBeGreaterThan(0)
    const out: string[] = []
    let seenPaths = false
    for (const line of lines.slice(start + 1)) {
      if (/^ {2}\S/.test(line)) break // 下一个顶层触发器
      if (line.trim() === 'paths:') {
        seenPaths = true
        continue
      }
      if (!seenPaths) continue
      const m = /^ {6}- '(.+)'$/.exec(line)
      if (m === null) break
      out.push(m[1]!)
    }
    return out
  }

  test('夜跑是定时触发的，且留着手动补基线的按钮', () => {
    const workflow = repoFile(WORKFLOW)
    expect(
      workflow,
      '视觉门不再定时跑 ⇒ 它退化成一道只在改前端时才跑的门，' +
        '而基线漂移恰恰是由环境（浏览器、字体、系统）引起的，与前端 diff 无关',
    ).toContain("- cron: '0 9 * * *'")
    expect(
      workflow,
      '没有 workflow_dispatch ⇒ 刷新 ubuntu 基线的唯一途径（README 的方案 A）没了',
    ).toContain('workflow_dispatch:')
  })

  test('push 与 pull_request 的路径过滤逐条相等', () => {
    // 这是本节最重要的一条：两份清单各 20 行、手抄、彼此重复，漂移之后会出现
    // 最难查的那种形态——PR 上绿的东西合进 main 之后夜里红，或者反过来，
    // 这道门在 PR 上根本没跑过。
    const push = pathFilters('push')
    const pr = pathFilters('pull_request')
    expect(push.length, 'push 的路径过滤解析成空 ⇒ 下面那条相等断言会变成空转').toBeGreaterThan(10)
    expect(
      pr,
      'PR 门与 push 门的路径过滤漂移了 ⇒ 同一份改动在两条腿上会被区别对待，' +
        '而「PR 绿、合进去夜里红」是最难归因的一种红',
    ).toEqual(push)
  })

  test('过滤清单盖住了视觉结果真正依赖的那几处', () => {
    // 只列 `packages/frontend/**` 是不够的：基线、夹具、system-mocks、
    // 甚至 playwright 版本本身都会改变渲染结果，改了它们却不跑门，
    // 下一次夜跑才发现，而那时已经分不清是谁改的。
    const push = pathFilters('push')
    for (const required of [
      'packages/frontend/**',
      'e2e/visual-regression.spec.ts',
      'e2e/visual-regression.spec.ts-snapshots/**',
      'e2e/rfc250-visual-states.spec.ts',
      'e2e/rfc250-visual-states.spec.ts-snapshots/**',
      'e2e/harness.ts',
      'packages/system-mocks/**',
      'playwright.config.ts',
      'bun.lock',
      '.github/workflows/visual-regression-nightly.yml',
    ]) {
      expect(push, `路径过滤漏了 ${required}——改它会改变渲染结果，却不会触发这道门`).toContain(
        required,
      )
    }
  })
})

// ---------------------------------------------------------------- 负 fixture

describe('RFC-319 UX 覆盖面守卫的判据本身还咬得动（RFC-317 T14）', () => {
  // 上面每一条「逐条相等 / 为空」都建立在这三个判据之上。判据一旦停止工作，
  // 它们会全体静默变绿——这三条 fixture 就是为了让那件事红。

  test('phantomEntries 认得出清单里已经不存在的条目', () => {
    expect(phantomEntries(['/a', '/b'], ['/a', '/ghost'])).toEqual(['/ghost'])
    expect(phantomEntries(['/a', '/b'], ['/a', '/b'])).toEqual([])
  })

  test('unsweptEntries 认得出没被扫到的页面', () => {
    expect(unsweptEntries(['/a', '/b', '/c'], ['/a'])).toEqual(['/b', '/c'])
    expect(unsweptEntries(['/a'], ['/a'])).toEqual([])
  })

  test('orphanBaselines 三种平台后缀都剥得掉，且认得出真孤儿', () => {
    const spec = "await expect(page).toHaveScreenshot('kept-scene.png')"
    for (const platform of ['linux', 'darwin', 'win32']) {
      expect(
        orphanBaselines([`kept-scene-chromium-${platform}.png`], spec),
        `${platform} 的基线被误判成孤儿 ⇒ 平台后缀没剥干净，孤儿对账会把好基线全报成孤儿`,
      ).toEqual([])
    }
    expect(orphanBaselines(['dropped-scene-chromium-linux.png'], spec)).toEqual([
      'dropped-scene-chromium-linux.png',
    ])
  })
})
