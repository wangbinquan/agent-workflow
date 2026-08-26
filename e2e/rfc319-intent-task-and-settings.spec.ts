// RFC-319 —— 意图会话 / 守护进程配置两簇的用户面 e2e。
//
// 覆盖能力账本行：INTENT-02 / INTENT-10 / INTENT-46 / INTENT-X6 /
// CFG-06 / CFG-24 / CFG-28 / CFG-45 / CFG-X2。
//
// 挑这九条的判据只有一个：**这条能力有没有一个「真的被消费 / 真的流转」的硬事实
// 可断言**。纯展示行、纯元数据行一律不收；账本里已经被别的 spec 覆盖到的行也不收
// （见文件末尾「与既有用例的分工」）。
//
// 各条失效形态（这些断言红掉时，用户会遭遇什么）：
//
//   * 【INTENT-10】资源详情页的「修改」是产品把一个**已有资源**送进意图会话的唯一
//     入口。它若只是跳到 /intent 而不把资源带过去，用户会得到一个空手起步的会话，
//     然后 agent 从零重写他本来只想改两行的那个代理。
//   * 【INTENT-02】提示卡是用户唯一能约束「要造什么」的旋钮。它若不进创建负载，
//     选哪张卡都一样，用户点了半天等于没点；反过来若 auto 也硬塞一个 hint，
//     那就是替用户做了他没做的决定。
//   * 【INTENT-46】意图会话的轮次是**后台**跑的，页面上没有任何轮询兜底
//     （query-client.ts:47-54 明写 refetchOnWindowFocus 关、无 refetchInterval）。
//     WS 失效 = 用户盯着一张永远停在旧状态的列表，只能靠自己按 F5 才知道跑完没。
//   * 【INTENT-X6】提交是这条产品线上唯一**不可撤销**的动作：它会真的把资源落地。
//     请求在飞的那几秒里，向导若能被 ESC / 遮罩 / 取消关掉，或者用户能直接切走，
//     他就失去了「服务端到底改没改」的唯一现场——既看不到结果，也无从判断该不该重试。
//   * 【CFG-06】bindHost / bindPort 是全仓仅有的两个「重启才生效」的键
//     （settings.tsx:3214-3217）。保存后不提示，用户会以为端口已经换了，
//     去改反代、改书签，然后发现全连不上；反过来若每次保存都提示重启，
//     用户就会学会无视这条横幅，真需要重启那次也被忽略。
//   * 【CFG-24】日志级别的字段提示逐字承诺「Applies to the running daemon
//     immediately after save.」。它若只落库不生效，运维在排查一个正在发生的故障时
//     调到 debug 却什么都拿不到——而唯一的补救是重启守护进程，那正是他不能做的事。
//   * 【CFG-28】body 保留期长于整行保留期是**自相矛盾**的意图：行先删了，body 段
//     的保留窗口永远空转。这条闸在保存门上（config.ts:79-90），前端没有对应的
//     跨字段校验，所以它是用户唯一会撞到的那道门。它若失守，用户会存下一份自己
//     以为「留 120 天正文」而实际 90 天就整行删干净的配置。
//   * 【CFG-45】默认运行时决定「新任务拉起哪个模型 / 哪套参数」。改完不生效，
//     用户看到的是一个改过的下拉框和一批仍然按旧配置烧钱的任务。
//   * 【CFG-X2】子模块四个旋钮里有一个是**嵌套对象**（submoduleAutoRefresh）。
//     嵌套对象在保存时被拆散，等于「我关了后台刷新，它照样按默认间隔刷」；
//     分区白名单漏一个键，等于「我在 Git 分区点一次保存，把同事刚在别处改的值
//     冲回旧值」。
//
// 判据全部取自源码单一事实源（纯文本引用，禁 GitHub 外链）：
//   * 修改入口的 search 参数：packages/frontend/src/components/IntentEntryButton.tsx:38-50
//   * 弹窗把 mount 交给 composer：packages/frontend/src/routes/intent.tsx:220-223、263-272
//   * mount 时 hint 让位 + 负载形状：
//     packages/frontend/src/components/intent/IntentCreateComposer.tsx:76-84
//   * 提示卡 / 挂载说明二选一：
//     packages/frontend/src/components/intent/IntentCreateComposer.tsx:236-258
//   * 会话的挂载清单渲染：packages/frontend/src/routes/intent.detail.tsx:363-382
//   * WS 失效规则（列表 + 详情）：packages/frontend/src/hooks/useIntentSessionsWs.ts:33-56
//   * 列表卡片的阶段 chip：packages/frontend/src/components/intent/IntentSessionList.tsx:52-58
//   * 无轮询兜底：packages/frontend/src/lib/query-client.ts:47-54
//   * 提交进行中的守卫与不可关闭：packages/frontend/src/routes/intent.detail.tsx:1348-1381
//   * 守卫对话框的「留下」语义：packages/frontend/src/components/split/UnsavedChangesGuard.tsx:1-12
//   * 「重启才生效」的键集合与横幅：packages/frontend/src/routes/settings.tsx:3214-3232、3357-3366
//   * 日志级别热应用：packages/backend/src/routes/config.ts:110-113
//   * 逐请求 debug 日志：packages/backend/src/server.ts:349
//   * 日志级别与 logFile 的关系：packages/backend/src/util/log.ts:57-65、100-110
//   * webhook 保留期保存门：packages/backend/src/routes/config.ts:79-90
//   * 默认运行时 → 运行时行 → 冻结进 node_run：
//     packages/backend/src/services/runtimeRegistry.ts:429-459、
//     packages/backend/src/services/scheduler.ts:1221-1223
//   * Git 分区四个旋钮：packages/frontend/src/routes/settings.tsx:841-931
//   * 分区最小写入白名单：packages/frontend/src/lib/settings-drafts.ts:110-121
//
// 与既有用例的分工（起草时逐条 grep 过，务必不要重复）：
//   * e2e/rfc319-settings-sections.spec.ts —— CFG-27 是同族的「嵌套对象 + 白名单」，
//     但对的是 GC 分区；本文件 CFG-X2 对的是 Git 分区自己的四个键。
//   * e2e/rfc319-settings-runtimes.spec.ts —— CFG-14 只到「写进 config.defaultRuntime」
//     为止；本文件 CFG-45 接着往下走一步，证明**新任务真的按它派发**。
//   * e2e/settings-save-receipt.spec.ts —— CFG-04 用 webhook body 保留期当载体证明
//     「回执对应真落库」，没有碰 body > row 这道拒绝门。
//   * e2e/rfc319-ops-settings-panels.spec.ts —— OPS-032 覆盖「网络分区念的是有效端口」
//     与「Pin current port 不写服务端」；本文件 CFG-06 接着断言**保存之后**的重启横幅。
//   * e2e/rfc319-intent-draft-and-commit.spec.ts —— INTENT-40 覆盖的是提交**响应丢失
//     之后**的重试与幂等，INTENT-42 覆盖的是底层草稿换修订时的自动关闭；本文件
//     INTENT-X6 覆盖的是它们之前的那个窗口：请求还在飞的时候关不掉、走不开。
//   * e2e/rfc319-intent-create-and-list.spec.ts —— INTENT-05 守的是**创建**进行中的
//     同一族守卫；X6 守的是**提交**进行中的那一份（两处各有自己的 pending 判据）。

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { querySqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(150_000)

// ---------------------------------------------------------------------------
// 通用夹具
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

function apiFetch(d: DaemonHandle, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${d.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${d.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  })
}

async function apiJson<T>(
  d: DaemonHandle,
  path: string,
  init: RequestInit,
  what: string,
): Promise<T> {
  const res = await apiFetch(d, path, init)
  const text = await res.text()
  expect(res.ok, `${what}: HTTP ${res.status} ${text}`).toBe(true)
  return JSON.parse(text) as T
}

async function primeToken(page: Page, d: DaemonHandle): Promise<void> {
  await page.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      // 固定英文：下面所有选择器对的是 en-US 文案。
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: d.baseUrl, tok: d.token },
  )
}

function saveButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Save', exact: true })
}

function receipt(page: Page): Locator {
  return page.locator('.form-actions__ok')
}

function saveError(page: Page): Locator {
  return page.locator('.form-actions__error')
}

function restartBanner(page: Page): Locator {
  return page.locator('.notice-banner', { hasText: 'Daemon restart required' })
}

function readConfigFile(d: DaemonHandle): Json {
  return JSON.parse(readFileSync(join(d.home, 'config.json'), 'utf-8')) as Json
}

function dbPath(d: DaemonHandle): string {
  return join(d.home, 'db.sqlite')
}

/** 一次保存到底改动了哪些顶层键——分区白名单的唯一可核对形态。 */
function changedTopLevelKeys(before: Json, after: Json): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort()
}

// ===========================================================================
// 配置分区（CFG-06 / CFG-24 / CFG-28 / CFG-45 / CFG-X2）
// ===========================================================================

test.describe('RFC-319 settings', () => {
  let daemon: DaemonHandle

  test.beforeAll(async () => {
    daemon = await startDaemon()
  })

  test.afterAll(async () => {
    if (daemon !== undefined) await daemon.stop()
  })

  async function readConfig(): Promise<Json> {
    return apiJson<Json>(daemon, '/api/config', {}, 'read config')
  }

  async function seedConfig(patch: Json): Promise<void> {
    await apiJson<Json>(
      daemon,
      '/api/config',
      { method: 'PUT', body: JSON.stringify(patch) },
      `seed config ${Object.keys(patch).join(',')}`,
    )
  }

  async function openSettings(page: Page, tab: string): Promise<void> {
    await primeToken(page, daemon)
    await page.goto(`${daemon.baseUrl}/settings?tab=${tab}`)
    await expect(
      saveButton(page),
      `/settings?tab=${tab} 没有渲染出分区表单 ⇒ 后面每一条断言都只是在断言一张白屏`,
    ).toBeVisible({ timeout: 30_000 })
  }

  async function pickSelectOption(page: Page, label: string, option: string): Promise<void> {
    await page.getByRole('combobox', { name: label, exact: true }).click()
    const listbox = page.locator('ul[role="listbox"].select__listbox--portal')
    await expect(listbox, `「${label}」的下拉没有打开`).toBeVisible()
    await listbox.getByRole('option', { name: option, exact: true }).click()
    await expect(listbox, `选了「${option}」之后下拉没有收起`).toHaveCount(0)
  }

  // -------------------------------------------------------------------------
  // CFG-24 P3 —— 日志级别保存后当场作用到运行中的守护进程
  // -------------------------------------------------------------------------

  /** `daemon.log` 与它轮转出来的兄弟（log.ts 到 10 MiB 轮转、保留 5 份）。 */
  function daemonLogText(): string {
    const dir = join(daemon.home, 'logs')
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return ''
    }
    return names
      .filter((name) => name === 'daemon.log' || /^daemon\.log\.\d+$/.test(name))
      .map((name) => {
        try {
          return readFileSync(join(dir, name), 'utf-8')
        } catch {
          return ''
        }
      })
      .join('\n')
  }

  /**
   * 打一条**路径里带唯一标记**的请求。server.ts:349 的逐请求中间件在
   * `await next()` 之后才打日志，而响应要等中间件栈返回才发出去——所以这个
   * await 一旦 resolve，该记的那行已经落盘了，不需要任何等待。
   */
  async function pingWithMarker(marker: string): Promise<void> {
    const res = await apiFetch(daemon, `/api/agents/${marker}`)
    await res.text()
    expect(res.status, `标记请求 ${marker} 没有走到路由上`).toBe(404)
  }

  test('RFC-319 CFG-24: 日志级别保存后当场作用到运行中的守护进程——调到 debug 逐请求日志立刻出现，调到 error 立刻停写 @nightly', async ({
    page,
  }) => {
    await seedConfig({ logLevel: 'info' })
    await openSettings(page, 'limits')

    const marker = (tag: string): string => `rfc319cfg24${tag}${Date.now().toString(36)}`
    const quiet = marker('quiet')

    // ① 前置：info 档下逐请求日志本来就不该出现。这一步不是断言产品，
    //    而是证明后面「debug 之后出现了」不是因为它一直都在。
    await pingWithMarker(quiet)
    expect(
      daemonLogText(),
      'info 档下就已经有逐请求 debug 日志 ⇒ 这条用例的对照组不成立',
    ).not.toContain(`path=/api/agents/${quiet}`)

    // ② 调到 debug 并保存。
    await pickSelectOption(page, 'Log level', 'debug')
    await saveButton(page).click()
    await expect(receipt(page), '日志级别保存没有回执').toBeVisible({ timeout: 20_000 })
    expect((await readConfig())['logLevel'], '保存了却没落库').toBe('debug')

    const loud = marker('loud')
    await pingWithMarker(loud)
    expect(
      daemonLogText(),
      '调到 debug 并保存之后，新请求仍然不进日志 ⇒ 字段提示承诺的「立刻作用于运行中的守护进程」' +
        '没有兑现；运维只能重启守护进程才拿得到 debug，而排查正在发生的故障时那正是他不能做的事',
    ).toContain(`path=/api/agents/${loud}`)

    // ③ 反向：调到 error，逐请求日志必须立刻停写。只有正向那一半的话，
    //    「配置一律被无视、日志永远开着」也能让 ② 变绿。
    await pickSelectOption(page, 'Log level', 'error')
    await saveButton(page).click()
    await expect(receipt(page), '第二次保存没有回执').toBeVisible({ timeout: 20_000 })
    const muted = marker('muted')
    await pingWithMarker(muted)
    expect(
      daemonLogText(),
      '调到 error 之后逐请求日志还在写 ⇒ 级别只是个装饰，长跑实例的磁盘会被 debug 日志吃满',
    ).not.toContain(`path=/api/agents/${muted}`)

    // ④ 再调回 debug 并确认新标记又进得去——排除「日志文件在 ③ 之前就整个写不动了」
    //    这种会让 ③ 无条件为真的退化情形。
    await pickSelectOption(page, 'Log level', 'debug')
    await saveButton(page).click()
    await expect(receipt(page), '第三次保存没有回执').toBeVisible({ timeout: 20_000 })
    const again = marker('again')
    await pingWithMarker(again)
    const finalLog = daemonLogText()
    expect(
      finalLog,
      '调回 debug 之后日志不再写入 ⇒ 上一条「error 时不写」其实是日志整个坏掉了，' +
        '整条用例失去判别力',
    ).toContain(`path=/api/agents/${again}`)
    expect(
      finalLog,
      'error 档期间那条请求补写进了日志 ⇒ 级别切换不是即时的，而是延迟/回放的',
    ).not.toContain(`path=/api/agents/${muted}`)

    await seedConfig({ logLevel: 'info' })
  })

  // -------------------------------------------------------------------------
  // CFG-28 P3 —— webhook 投递保留天数的自相矛盾校验
  // -------------------------------------------------------------------------

  test('RFC-319 CFG-28: webhook 正文保留期长于整行保留期时保存被服务端当场拒绝，草稿原样保住、一个字段都不落库 @nightly', async ({
    page,
  }) => {
    await seedConfig({ webhookDeliveryBodyRetentionDays: 30, webhookDeliveryRowRetentionDays: 90 })
    const before = await readConfig()
    await openSettings(page, 'gc')

    const body = page.getByTestId('settings-webhook-body-retention')
    const row = page.getByTestId('settings-webhook-row-retention')
    await expect(body, 'GC 分区没有渲染出 webhook 保留期字段').toBeVisible({ timeout: 30_000 })

    // ① 把正文保留期抬到整行之上：这是最直白的自相矛盾。
    await body.fill('120')
    await saveButton(page).click()
    await expect(
      saveError(page),
      '正文保留期长于整行保留期却存下去了 ⇒ 用户以为「正文留 120 天」，实际第 90 天整行就被删光',
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      saveError(page),
      '拒绝了却没说清是哪两个值打架 ⇒ 用户不知道该改哪一个',
    ).toContainText('must not exceed')

    // 拒绝必须是「什么都没写」，不是「写了一半」。
    const afterReject = await readConfig()
    expect(
      [
        afterReject['webhookDeliveryBodyRetentionDays'],
        afterReject['webhookDeliveryRowRetentionDays'],
      ],
      '被拒绝的保存仍然改动了保留期 ⇒ 保存门挡在校验之后，库里留下了它自己判定为非法的组合',
    ).toEqual([30, 90])
    expect(
      changedTopLevelKeys(before, afterReject),
      '被拒绝的保存顺手写进了本分区的其它键 ⇒ 一次失败的保存做了半截',
    ).toEqual([])

    // 草稿要原样留在页面上——被打回来还要用户重新输一遍，等于惩罚他做对的那一半。
    await expect(body, '被拒绝之后输入框被回滚成服务端旧值 ⇒ 用户刚填的东西被吞了').toHaveValue(
      '120',
    )

    // ② 合并校验：这一次只 PUT 整行保留期（正文保留期不在本次改动里），
    //    服务端仍须按**合并后**的完整配置判定。
    await body.fill('30')
    await row.fill('10')
    await saveButton(page).click()
    await expect(
      saveError(page),
      '只调低整行保留期就绕过了这道门 ⇒ 校验只看本次 PUT 带来的键，' +
        '用户可以分两步存出一份服务端自己判定为非法的配置',
    ).toBeVisible({ timeout: 20_000 })
    expect((await readConfig())['webhookDeliveryRowRetentionDays'], '被拒绝却落库了').toBe(90)

    // ③ 边界：两个值**相等**必须放行。判据是「正文期 > 整行期才拒」，等号那一格是合法的
    //    ——正文与整行同期到期，没有「正文还在、整行已删」的矛盾。这一格不锁的话，把闸从
    //    `>` 放宽/收紧成 `>=` 用例照样绿（2026-08-26 变异实测：上面两段用的都不是等值对）。
    await row.fill('30')
    await saveButton(page).click()
    await expect(
      receipt(page),
      '正文期与整行期相等被当成非法 ⇒ 这道门把边界上的合法输入也挡了',
    ).toBeVisible({ timeout: 20_000 })
    const eq = await readConfig()
    expect([eq['webhookDeliveryBodyRetentionDays'], eq['webhookDeliveryRowRetentionDays']]).toEqual(
      [30, 30],
    )

    // ④ 改成自洽的一组：必须真的存得下去，两个值一起落到磁盘。
    await row.fill('200')
    await saveButton(page).click()
    await expect(receipt(page), '自洽的一组保留期存不下去 ⇒ 这道门把合法输入也挡了').toBeVisible({
      timeout: 20_000,
    })
    const ok = await readConfig()
    expect([ok['webhookDeliveryBodyRetentionDays'], ok['webhookDeliveryRowRetentionDays']]).toEqual(
      [30, 200],
    )
    const disk = readConfigFile(daemon)
    expect(
      disk['webhookDeliveryRowRetentionDays'],
      '只写进了内存没落盘 ⇒ 重启后保留期又变回旧值，用户毫不知情',
    ).toBe(200)
  })

  // -------------------------------------------------------------------------
  // CFG-06 P3 —— 「重启才生效」的横幅
  // -------------------------------------------------------------------------

  test('RFC-319 CFG-06: 只有改动「重启才生效」的键才弹重启横幅——同一分区里改别的键保存后不弹 @nightly', async ({
    page,
  }) => {
    await seedConfig({ bindPort: 0, mcpSurfaceEnabled: true })
    await openSettings(page, 'network')

    const mcp = page.getByTestId('settings-mcp-surface')
    await expect(mcp, '网络分区没有渲染出 MCP 开关').toBeVisible({ timeout: 30_000 })

    // ① 同一个分区里的非重启键：保存成功，但不许弹重启横幅。
    //    弹了的后果是「每次保存都说要重启」，用户很快学会无视它。
    await mcp.uncheck()
    await saveButton(page).click()
    await expect(receipt(page), 'MCP 开关保存没有回执').toBeVisible({ timeout: 20_000 })
    expect((await readConfig())['mcpSurfaceEnabled'], 'MCP 开关没有真的落库').toBe(false)
    await expect(
      restartBanner(page),
      '改一个立刻生效的键也弹「需要重启」⇒ 这条横幅退化成噪音，真需要重启那次也会被无视',
    ).toHaveCount(0)

    // 还原（保持本组后续用例的环境干净），顺带再证一次「保存本身不会弹横幅」。
    await mcp.check()
    await saveButton(page).click()
    await expect(receipt(page), 'MCP 开关还原保存没有回执').toBeVisible({ timeout: 20_000 })
    await expect(restartBanner(page), '第二次非重启键保存弹了重启横幅').toHaveCount(0)

    // ② 重启键：把本次运行的有效端口钉进配置。bindPort 是全仓仅有的两个
    //    重启键之一，改完必须明说「现在这个进程还在老端口上」。
    const effectivePort = Number(new URL(daemon.baseUrl).port)
    expect(effectivePort, '取不到 daemon 的实际端口 ⇒ 这条用例的前提不成立').toBeGreaterThan(0)
    await page.getByTestId('settings-use-effective-port').click()
    await expect(
      page.getByTestId('settings-bind-port'),
      '「Pin current port」没有把有效端口填进草稿',
    ).toHaveValue(String(effectivePort))
    await saveButton(page).click()
    await expect(receipt(page), '端口保存没有回执').toBeVisible({ timeout: 20_000 })
    expect(
      (await readConfig())['bindPort'],
      '端口没有真的落库 ⇒ 后面这条横幅是在替一次没发生的改动报警',
    ).toBe(effectivePort)
    await expect(
      restartBanner(page),
      '改了 bindPort 却不提示重启 ⇒ 用户以为端口已经换了，去改反代 / 改书签，然后全连不上；' +
        '而这个进程其实还绑在老端口上',
    ).toHaveCount(1)
    await expect(
      restartBanner(page),
      '重启横幅没有说清该做什么 ⇒ 用户知道「要重启」却不知道重启什么、怎么重启',
    ).toContainText('agent-workflow start')

    await seedConfig({ bindPort: 0 })
  })

  // -------------------------------------------------------------------------
  // CFG-32 P3 —— 监听 host 的保存往返
  //
  // 网络分区一共两个持久键，`bindPort` 被 OPS-032（有效端口 / Pin current port）
  // 与上面的 CFG-06（重启横幅）盖住了，`bindHost` 却一条用例都没有。它偏偏是这一
  // 分区里**唯一一个纯文本输入**：`SettingsNumberInput` 有 `data-testid`、有
  // placeholder 联动，而 `bindHost` 只是一个裸 `<TextInput>`（settings.tsx:1588-1592），
  // 少拷一个字段、绑错一个 state 都不会有任何症状。
  //
  // 它的失效形态还特别贵：用户把 host 从 127.0.0.1 改成对外地址、看见「已保存」+
  // 「需要重启」，于是去重启守护进程——重启读的是 config.json。那一行要是没落盘，
  // 重启就是原地回滚，而用户此刻正对着一个「配好了」的界面等同事来连。
  // -------------------------------------------------------------------------

  test('RFC-319 CFG-32: 监听 host 改完保存要真的落盘、重新进页面读得回来，且只动它自己那个键 @nightly', async ({
    page,
  }) => {
    await seedConfig({ bindHost: '127.0.0.1', bindPort: 0 })
    const before = await readConfig()
    await openSettings(page, 'network')

    const bindHost = page.getByLabel('Bind host')
    await expect(bindHost, '网络分区没有把持久值念回输入框 ⇒ 下面改的是一张白表').toHaveValue(
      '127.0.0.1',
    )

    await bindHost.fill('0.0.0.0')
    await expect(
      saveButton(page),
      '改了 host 之后分区仍显示「无改动」⇒ 保存按钮点不动，改了等于没改',
    ).toBeEnabled()
    await saveButton(page).click()
    await expect(receipt(page), 'host 保存没有回执').toBeVisible({ timeout: 20_000 })

    // ① 真的落库，而且**落盘**。bindHost 是重启才生效的键，重启读的正是 config.json：
    //    只写内存的话，那一次重启就是原地回滚。
    const after = await readConfig()
    expect(after['bindHost'], 'host 没有真的落库').toBe('0.0.0.0')
    expect(readConfigFile(daemon)['bindHost'], 'host 只写进了内存没落盘').toBe('0.0.0.0')

    // ② 只动它自己那一个键——分区白名单漏了别的键时，一次改 host 会顺手把同分区
    //    里别人刚改的设置一起写回旧值。
    expect(changedTopLevelKeys(before, after), '保存 host 顺手改了别的顶层键').toEqual(['bindHost'])

    // ③ 重启横幅：bindHost 与 bindPort 是全仓仅有的两个重启键，CFG-06 只验过后者。
    await expect(
      restartBanner(page),
      '改了 bindHost 却不提示重启 ⇒ 用户以为已经对外可达了，同事连不上也查不出原因',
    ).toHaveCount(1)

    // ④ 读得回来：重新进这一页，输入框里必须是刚存下去的那个值。
    await page.reload()
    await expect(
      page.getByLabel('Bind host'),
      '重新进页面 host 又回到旧值 ⇒ 回执是假的，这一步存了个寂寞',
    ).toHaveValue('0.0.0.0')

    // 还原：别把后续用例留在一个对外监听的配置上。
    await seedConfig({ bindHost: '127.0.0.1' })
  })

  // -------------------------------------------------------------------------
  // CFG-X2 P2 —— Git 分区的子模块检出策略与后台刷新
  // -------------------------------------------------------------------------

  test('RFC-319 CFG-X2: Git 分区四个子模块旋钮整体落库并读得回来，嵌套的后台刷新对象不被拆散，且只写本分区自己的键 @nightly', async ({
    page,
  }) => {
    await seedConfig({
      gitRecurseSubmodules: 'auto',
      gitSubmoduleJobs: 4,
      gitSubmoduleRemote: false,
      submoduleAutoRefresh: { enabled: true, intervalMs: 6 * 60 * 60 * 1000, onlyRecentDays: 30 },
    })
    const before = await readConfig()
    await openSettings(page, 'git')

    const jobs = page.getByRole('spinbutton', { name: /Submodule parallelism/ })
    const interval = page.getByRole('spinbutton', { name: /Refresh interval \(ms\)/ })
    const recentDays = page.getByRole('spinbutton', { name: /Only refresh repos used within/ })
    const trackRemote = page.getByRole('checkbox', { name: /Track submodule upstream/ })
    const autoRefresh = page.getByRole('checkbox', { name: /Background repo refresh/ })
    await expect(jobs, 'Git 分区没有渲染出子模块旋钮').toBeVisible({ timeout: 30_000 })

    await pickSelectOption(page, 'Submodule recursion', 'never (off)')
    await jobs.fill('7')
    await trackRemote.check()
    // 用 click + 显式断言而不是 uncheck()：这个开关背后是**嵌套对象**里的一个字段，
    // 分区一旦不再认领 submoduleAutoRefresh，草稿就收不下这次改动、开关会自己弹回去。
    // uncheck() 遇到这种情况抛的是工装自己的措辞，读的人无从判断产品哪里坏了。
    await autoRefresh.click()
    await expect(
      autoRefresh,
      '点了「后台刷新」开关状态却没变 ⇒ 这一格的改动进不了本分区的草稿，用户关不掉它',
    ).not.toBeChecked()
    await interval.fill('1800000')
    await recentDays.fill('9')

    await saveButton(page).click()
    await expect(receipt(page), 'Git 分区保存没有回执').toBeVisible({ timeout: 20_000 })

    // ① 嵌套对象要整体成立。只发 enabled 而把 intervalMs / onlyRecentDays 丢掉，
    //    结果就是「我关了后台刷新，它照样按默认间隔去 fetch 每一个仓库」。
    const after = await readConfig()
    expect(
      after['submoduleAutoRefresh'],
      '后台刷新的三个字段没有整体落库 ⇒ 用户关掉的开关与他设的间隔各说各话',
    ).toEqual({ enabled: false, intervalMs: 1_800_000, onlyRecentDays: 9 })

    // ② 三个标量各自落库。检出策略是唯一能让「不要碰子模块」这个诉求生效的旋钮
    //    （services/gitRepoCache.ts:462-470 从磁盘上的这份配置读它）。
    expect(
      after['gitRecurseSubmodules'],
      '子模块检出策略没落库 ⇒ 用户在设置里选了 never，克隆时照样递归拉子模块',
    ).toBe('never')
    expect(after['gitSubmoduleJobs']).toBe(7)
    expect(after['gitSubmoduleRemote']).toBe(true)

    // ③ 真正落盘（守护进程与 git 助手下次都从这份文件读）。
    const disk = readConfigFile(daemon)
    expect(disk['gitRecurseSubmodules'], '只写进了内存没落盘 ⇒ 重启后检出策略又变回 auto').toBe(
      'never',
    )
    expect(disk['submoduleAutoRefresh']).toEqual({
      enabled: false,
      intervalMs: 1_800_000,
      onlyRecentDays: 9,
    })

    // ④ 一次保存只写本分区自己的键。不成立 ⇒ 我在 Git 分区点一次保存，
    //    同事刚在别的分区改的值被我带着的旧快照冲回去，而两边都不会收到提示。
    expect(
      changedTopLevelKeys(before, after),
      '保存 Git 分区顺手改动了别的分区的键 ⇒ 一次保存会静默回滚同事刚做的改动',
    ).toEqual([
      'gitRecurseSubmodules',
      'gitSubmoduleJobs',
      'gitSubmoduleRemote',
      'submoduleAutoRefresh',
    ])

    // ⑤ 重新加载后五个控件都回显新值——用户下次进来看到的就是生效值。
    await page.reload()
    await expect(
      page.getByRole('combobox', { name: 'Submodule recursion', exact: true }),
      '重载后检出策略回显的不是刚存下的值 ⇒ 用户会以为没存上，于是再存一遍',
    ).toContainText('never (off)', { timeout: 30_000 })
    await expect(page.getByRole('spinbutton', { name: /Submodule parallelism/ })).toHaveValue('7')
    await expect(page.getByRole('checkbox', { name: /Track submodule upstream/ })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: /Background repo refresh/ })).not.toBeChecked()
    await expect(page.getByRole('spinbutton', { name: /Refresh interval \(ms\)/ })).toHaveValue(
      '1800000',
    )
    await expect(
      page.getByRole('spinbutton', { name: /Only refresh repos used within/ }),
    ).toHaveValue('9')
  })

  // -------------------------------------------------------------------------
  // CFG-45 P2 —— 改默认运行时之后，新任务真的按它派发
  //
  // 放在本组最后：它会把 config.defaultRuntime 指到一个自定义行上。
  // -------------------------------------------------------------------------

  test('RFC-319 CFG-45: 在设置页把默认运行时改到另一行之后，新任务真的按那一行的运行时档案派发 @nightly', async ({
    page,
  }) => {
    const FORK = 'rfc319-cfg45-fork'
    const FORK_MODEL = 'rfc319/cfg45-fork-model'

    async function launchTask(name: string): Promise<string> {
      const agentName = `${name}-agent`
      const agent = await apiJson<{ id: string }>(
        daemon,
        '/api/agents',
        {
          method: 'POST',
          body: JSON.stringify({
            name: agentName,
            description: 'RFC-319 CFG-45 fixture',
            outputs: ['answer'],
            readonly: true,
            bodyMd: '',
          }),
        },
        `seed agent ${agentName}`,
      )
      // 这条用例的全部意义建立在「这个代理自己没有指定运行时」上
      // （agents.runtime NULL = 继承 config.defaultRuntime，db/schema.ts:44-49）。
      const stored = querySqlite<{ runtime: string | null }>(
        dbPath(daemon),
        `SELECT runtime FROM agents WHERE id = '${agent.id}'`,
      )
      expect(
        stored[0]?.runtime ?? null,
        '新建代理自带了运行时 ⇒ 它压根不继承默认运行时，这条用例测不到东西',
      ).toBeNull()

      const workflow = await apiJson<{ id: string }>(
        daemon,
        '/api/workflows',
        {
          method: 'POST',
          body: JSON.stringify({
            name: `${name}-workflow`,
            description: 'RFC-319 CFG-45 fixture',
            definition: {
              $schema_version: 1,
              inputs: [],
              nodes: [
                {
                  id: 'agent_1',
                  kind: 'agent-single',
                  agentId: agent.id,
                  agentName,
                  promptTemplate: 'Say something about RFC-319.',
                  position: { x: 0, y: 0 },
                },
                {
                  id: 'out_1',
                  kind: 'output',
                  ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
                  position: { x: 320, y: 0 },
                },
              ],
              edges: [
                {
                  id: 'e_agent_out',
                  source: { nodeId: 'agent_1', portName: 'answer' },
                  target: { nodeId: 'out_1', portName: 'answer' },
                },
              ],
            },
          }),
        },
        `seed workflow ${name}`,
      )
      const task = await apiJson<{ id: string }>(
        daemon,
        '/api/tasks',
        { method: 'POST', body: JSON.stringify({ workflowId: workflow.id, name, scratch: true }) },
        `launch task ${name}`,
      )
      return task.id
    }

    /** node_run 上被冻结的运行时档案——「这次派发到底按谁的参数跑的」的单一事实源。 */
    async function frozenModelOf(taskId: string): Promise<string | null> {
      let params: string | null = null
      await expect
        .poll(
          () => {
            const rows = querySqlite<{ runtime: string | null; params: string | null }>(
              dbPath(daemon),
              `SELECT runtime AS runtime, runtime_params_json AS params FROM node_runs ` +
                `WHERE task_id = '${taskId}' AND node_id = 'agent_1'`,
            )
            params = rows[0]?.params ?? null
            return params
          },
          {
            timeout: 90_000,
            intervals: [300],
            message: `任务 ${taskId} 的 agent 节点始终没有冻结运行时档案`,
          },
        )
        .not.toBeNull()
      const parsed = JSON.parse(params ?? '{}') as { model?: string | null }
      return parsed.model ?? null
    }

    // ① 对照组：默认运行时还是内置 opencode 时启的任务，冻结的是内置行的模型。
    const baselineTaskId = await launchTask('rfc319-cfg45-before')
    expect(
      await frozenModelOf(baselineTaskId),
      '改默认之前，任务冻结的就不是内置运行时的模型 ⇒ 这条用例的对照组不成立',
    ).toBe('test/model')

    // ② 注册一条自定义运行时行：同一个协议（照样是 opencode，走同一个二进制），
    //    只有运行时档案不同。这样「新任务按新默认跑」这件事才有一个不受二进制路径
    //    干扰的、可判别的痕迹。
    await apiJson<Json>(
      daemon,
      '/api/runtimes',
      {
        method: 'POST',
        body: JSON.stringify({ name: FORK, protocol: 'opencode', model: FORK_MODEL }),
      },
      `register runtime ${FORK}`,
    )

    // ③ 在设置页里把它设成默认——这是产品给管理员的那条路径。
    await primeToken(page, daemon)
    await page.goto(`${daemon.baseUrl}/settings?tab=runtime`)
    const forkRow = page
      .locator('.runtime-list__row')
      .filter({ has: page.locator('.runtime-list__name', { hasText: new RegExp(`^${FORK}$`) }) })
    await expect(forkRow, '新注册的运行时没有出现在设置页的表里').toBeVisible({ timeout: 30_000 })
    await forkRow.getByRole('button', { name: 'Set default', exact: true }).click()
    await expect
      .poll(async () => (await readConfig())['defaultRuntime'], {
        timeout: 20_000,
        message: '界面标了新默认，config.defaultRuntime 却没变',
      })
      .toBe(FORK)

    // ④ 新任务必须按新默认派发。红在这里 = 设置页那个下拉只是装饰，
    //    任务照旧按老运行时的档案烧钱。
    const afterTaskId = await launchTask('rfc319-cfg45-after')
    expect(
      await frozenModelOf(afterTaskId),
      '改完默认运行时之后新启的任务仍然冻结着旧运行时的档案 ⇒ 「设为默认」只改了界面，' +
        '新任务照旧按老运行时的模型 / 参数跑',
    ).toBe(FORK_MODEL)

    // ⑤ 已经启过的那条任务不受牵连——冻结的意义就是「事后改默认改不动历史派发」。
    expect(
      await frozenModelOf(baselineTaskId),
      '改默认运行时把**已经派发过**的历史 node_run 也改了 ⇒ 冻结形同虚设，' +
        '一次恢复 / 重试会被路由到用户从没为这条任务选过的运行时上',
    ).toBe('test/model')
  })
})

// ===========================================================================
// 意图构建器（INTENT-02 / INTENT-10 / INTENT-46）
// ===========================================================================

test.describe('RFC-319 intent', () => {
  let daemon: DaemonHandle

  test.beforeAll(async () => {
    daemon = await startDaemon({ stubMode: 'intent' })
  })

  test.afterAll(async () => {
    if (daemon !== undefined) await daemon.stop()
  })

  // INTENT-X6 会把一条提交请求扣在 handler 里；`behavior: 'wait'` 保证卸载路由前
  // 那个 handler 已经跑完（docs/dev-gotchas.md 的 page.route 两把锁之一）。
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'wait' })
  })

  interface CreatePayload {
    message?: string
    hint?: string
    mounts?: Array<{ resourceType: string; resourceId: string }>
  }

  /** 捕获创建会话那一次 POST 的请求体——「提示卡 / 挂载目标进没进负载」的唯一事实源。 */
  function watchCreatePayloads(page: Page): CreatePayload[] {
    const seen: CreatePayload[] = []
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      if (new URL(request.url()).pathname !== '/api/intent-sessions') return
      const raw = request.postData()
      if (raw === null) return
      seen.push(JSON.parse(raw) as CreatePayload)
    })
    return seen
  }

  async function seedAgent(name: string): Promise<string> {
    const agent = await apiJson<{ id: string }>(
      daemon,
      '/api/agents',
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: 'RFC-319 intent entry fixture',
          outputs: ['answer'],
          readonly: true,
          bodyMd: '',
        }),
      },
      `seed agent ${name}`,
    )
    return agent.id
  }

  /**
   * /intent 上**同时**挂着两个 composer：页头那个 inline 的，和 `?create=true`
   * 打开的弹窗那个。两者共用同一批 testid（IntentCreateComposer.tsx 是同一个
   * 组件），所以每一个定位都必须先收敛到弹窗里，否则命中的是 inline 那份，
   * 「带挂载目标时提示卡让位」之类的断言会对着错误的实例作答。
   */
  function dialogComposer(page: Page): Locator {
    return page.getByTestId('intent-create-dialog')
  }

  async function submitDialogComposer(page: Page, message: string): Promise<string> {
    await dialogComposer(page).getByTestId('intent-create-message').fill(message)
    // 弹窗的按钮被 portal 到 Dialog 自己的固定页脚里，不在 form 的 DOM 子树内。
    await page
      .getByTestId('intent-create-dialog-footer')
      .getByRole('button', { name: 'Start building', exact: true })
      .click()
    await page.waitForURL(/\/intent\/[^/]+$/, { timeout: 60_000 })
    const sessionId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
    expect(sessionId, '提交之后没有落到某个具体会话上').not.toBe('')
    return sessionId
  }

  // -------------------------------------------------------------------------
  // INTENT-10 P2 —— 资源详情页的「修改」入口预挂载该资源
  // -------------------------------------------------------------------------

  test('RFC-319 INTENT-10: 从代理详情页「修改」开出的会话，创建负载里带着这个资源，落地后它就是会话的挂载根 @nightly', async ({
    page,
  }) => {
    const agentName = `rfc319-intent10-${Date.now().toString(36)}`
    const agentId = await seedAgent(agentName)
    const payloads = watchCreatePayloads(page)

    await primeToken(page, daemon)
    await page.goto(`${daemon.baseUrl}/agents/${agentId}`)
    const entry = page.getByTestId('agent-intent-entry')
    await expect(entry, '代理详情页上没有「修改」入口 ⇒ 已有资源进不了意图会话').toBeVisible({
      timeout: 30_000,
    })

    // ① 入口必须把「改的是谁」带进 URL。丢了这一段，用户回到的是一个空手起步的
    //    创建弹窗，agent 会从零重写他本来只想改两行的那个代理。
    await entry.click()
    await page.waitForURL(/\/intent\?/, { timeout: 30_000 })
    const search = new URL(page.url()).searchParams
    expect(
      [search.get('create'), search.get('mountType'), search.get('mountId')],
      '「修改」入口没有把挂载目标写进 URL ⇒ 这条路径退化成一次普通的新建',
    ).toEqual(['true', 'agent', agentId])

    // ② 弹窗要如实说明它在改什么，并且**不再**给资源类型提示卡——挂载目标已经
    //    定死了要造什么，再给一组卡片只会让用户以为自己还能改。
    await expect(
      dialogComposer(page).getByTestId('intent-modify-target'),
      '带挂载目标的创建弹窗没有说明它在改什么 ⇒ 用户不知道这次会话会动哪个资源',
    ).toBeVisible()
    await expect(
      dialogComposer(page).getByTestId('intent-create-hint-workflow'),
      '带挂载目标时还渲染资源类型提示卡 ⇒ 用户会以为自己能把「改代理」改成「造工作流」',
    ).toHaveCount(0)

    // ③ 提交：负载里必须带着这个资源，且不许再带 hint（挂载目标已经决定了类型）。
    const sessionId = await submitDialogComposer(page, `Tighten the prompt of ${agentName}.`)
    expect(payloads.length, '没有捕获到创建会话的请求').toBe(1)
    expect(
      payloads[0]?.mounts,
      '「修改」开出的会话创建负载里没有那个资源 ⇒ 会话开局手上什么都没有',
    ).toEqual([{ resourceType: 'agent', resourceId: agentId }])
    expect(
      payloads[0]?.hint,
      '带挂载目标时还发了 hint ⇒ 服务端会同时收到两份互相矛盾的意图声明',
    ).toBeUndefined()

    // ④ 服务端事实：这个资源真的成了会话的挂载根，不只是一段被丢掉的请求体。
    const detail = await apiJson<{ mounts: Array<{ resourceType: string; resourceId: string }> }>(
      daemon,
      `/api/intent-sessions/${sessionId}`,
      {},
      'read intent session',
    )
    expect(
      detail.mounts.map((m) => `${m.resourceType}:${m.resourceId}`),
      '创建负载带过去了，服务端却没有把它挂上 ⇒ 会话仍然是空手起步的',
    ).toEqual([`agent:${agentId}`])

    // ⑤ 界面事实：会话页的工作上下文里点得出这个代理的名字。
    await expect(
      page.locator('.intent-working-context-chip', { hasText: agentName }),
      '会话页的工作上下文里看不到刚挂上的资源 ⇒ 用户无从确认自己改的是不是那一个',
    ).toHaveCount(1)
  })

  // -------------------------------------------------------------------------
  // INTENT-02 P3 —— 资源类型提示卡影响创建负载
  // -------------------------------------------------------------------------

  test('RFC-319 INTENT-02: 资源类型提示卡决定创建负载——auto 一个字都不发，选中哪张卡就发哪个类型 @nightly', async ({
    page,
  }) => {
    const payloads = watchCreatePayloads(page)
    await primeToken(page, daemon)

    // ① auto（默认档）：不许往负载里塞 hint。塞了就是替用户做了他没做的决定——
    //    服务端会被一个「用户其实没选」的类型约束住。
    await page.goto(`${daemon.baseUrl}/intent?create=true`)
    const autoCard = dialogComposer(page).getByTestId('intent-create-hint-auto')
    await expect(autoCard, '创建弹窗里没有资源类型提示卡').toBeVisible({ timeout: 30_000 })
    await expect(
      autoCard,
      '默认选中的不是 auto ⇒ 第一次用的人会在毫不知情下被塞进某个具体类型',
    ).toHaveAttribute('aria-checked', 'true')
    await submitDialogComposer(page, 'Draft something useful for the RFC-319 fixture.')
    expect(payloads.length, '第一次创建没有捕获到请求').toBe(1)
    expect(
      payloads[0]?.hint,
      'auto 档也往负载里发了 hint ⇒ 平台替用户做了一个他没做的类型决定',
    ).toBeUndefined()

    // ② 选一张具体的卡：它必须进负载。不进就等于这组卡片是纯装饰，
    //    用户点了半天，服务端那边一无所知。
    await page.goto(`${daemon.baseUrl}/intent?create=true`)
    const workflowCard = dialogComposer(page).getByTestId('intent-create-hint-workflow')
    await expect(workflowCard, '创建弹窗里没有工作流那张提示卡').toBeVisible({ timeout: 30_000 })
    await workflowCard.click()
    await expect(
      workflowCard,
      '点了提示卡但选中态没挪过去 ⇒ 用户看不出自己选了什么',
    ).toHaveAttribute('aria-checked', 'true')
    await expect(
      dialogComposer(page).getByTestId('intent-create-hint-auto'),
      '选了具体类型之后 auto 仍然是选中态 ⇒ 界面上同时有两个选中项',
    ).toHaveAttribute('aria-checked', 'false')
    await submitDialogComposer(page, 'Build a two-step review workflow for RFC-319.')
    expect(payloads.length, '第二次创建没有捕获到请求').toBe(2)
    expect(
      payloads[1]?.hint,
      '选中的资源类型没有进创建负载 ⇒ 提示卡是纯装饰，用户的选择服务端一无所知',
    ).toBe('workflow')
  })

  // -------------------------------------------------------------------------
  // INTENT-46 P2 —— /ws/intent-sessions 驱动的实时同步
  // -------------------------------------------------------------------------

  test('RFC-319 INTENT-46: 别处发生的会话变化经 /ws/intent-sessions 推到已经打开的列表页——不刷新就出现、不刷新就改状态 @nightly', async ({
    page,
  }) => {
    const holdDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-intent46-'))
    const holdFile = join(holdDir, 'turn.hold')
    writeFileSync(holdFile, 'held')
    let realtimeDaemon: DaemonHandle | undefined
    try {
      realtimeDaemon = await startDaemon({
        stubMode: 'intent',
        extraEnv: { STUB_INTENT_HOLD_FILE: holdFile },
      })
      await primeToken(page, realtimeDaemon)
      await page.goto(`${realtimeDaemon.baseUrl}/intent`)
      await expect(
        page.getByRole('heading', { name: 'Recent sessions', exact: true }),
        '/intent 连「最近会话」这一栏都没渲染出来',
      ).toBeVisible({ timeout: 30_000 })
      // 列表首帧必须先落定：不等它，后面「新卡片出现」可能只是首屏数据姗姗来迟。
      await expect(page.locator('.intent-recent__grid, .empty-state')).toBeVisible({
        timeout: 30_000,
      })

      // 带外创建：整个过程浏览器**没有**发生任何用户动作，页面也不失焦
      // （query-client.ts:47-54 关掉了 refetchOnWindowFocus，且这条查询没有轮询），
      // 所以列表要是更新了，只可能是 WS 推的。
      const created = await apiJson<{ id: string; title: string }>(
        realtimeDaemon,
        '/api/intent-sessions',
        {
          method: 'POST',
          body: JSON.stringify({ message: 'RFC-319 realtime fixture session.' }),
        },
        'create intent session out of band',
      )
      const card = page.locator(`a[href$="/intent/${created.id}"]`)
      await expect(
        card,
        '别处新建的会话没有推到已经打开的列表页 ⇒ 多标签页 / 多人协作下，' +
          '用户看到的永远是自己打开那一刻的快照，只能靠 F5 才知道多了什么',
      ).toHaveCount(1, { timeout: 60_000 })

      // 轮次是后台跑的：它跑完之后阶段 chip 必须跟着走。停在「生成中」不动的话，
      // 用户会一直等一个其实早就结束了的轮次。
      const chip = page.getByTestId(`intent-stage-status-${created.id}`)
      await expect(chip, '列表卡片上没有阶段 chip').toBeVisible()
      await expect(
        chip,
        '会话刚建出来，阶段 chip 却不是「生成中」⇒ 这条用例的起点不成立',
      ).toHaveText('Step 2/4 · Generate')
      rmSync(holdFile, { force: true })
      await expect
        .poll(
          async () =>
            (
              await apiJson<{ items: Array<{ id: string; inFlight: boolean }> }>(
                realtimeDaemon,
                '/api/intent-sessions?page=1&limit=50',
                {},
                'list intent sessions',
              )
            ).items.find((s) => s.id === created.id)?.inFlight,
          { timeout: 120_000, intervals: [500], message: '后台轮次始终没有落定' },
        )
        .toBe(false)
      await expect(
        chip,
        '后台轮次已经落定，页面上的阶段 chip 还停在「生成中」⇒ 用户在等一个早就结束的轮次',
      ).not.toHaveText('Step 2/4 · Generate', { timeout: 60_000 })

      // 归档同理：它在别处发生，这一页要当场跟上，而不是等下一次刷新。
      await apiJson<Json>(
        realtimeDaemon,
        `/api/intent-sessions/${created.id}/archive`,
        { method: 'POST' },
        'archive intent session',
      )
      await expect(
        chip,
        '别处归档的会话在已经打开的列表页上仍然显示成活跃 ⇒ 两个标签页各说各话',
      ).toContainText('Archived', { timeout: 60_000 })
    } finally {
      rmSync(holdFile, { force: true })
      if (realtimeDaemon !== undefined) await realtimeDaemon.stop()
      rmSync(holdDir, { recursive: true, force: true })
    }
  })
  // -------------------------------------------------------------------------
  // INTENT-X6 P3 —— 提交进行中的页面级离开守卫 + 不可关闭的对话框
  // -------------------------------------------------------------------------

  test('RFC-319 INTENT-X6: 提交还在飞的时候向导既关不掉也走不开——取消禁用、ESC 与遮罩无效、切走页面被守卫拦下 @nightly', async ({
    page,
  }) => {
    await primeToken(page, daemon)
    await page.goto(`${daemon.baseUrl}/intent`)
    const inline = page.getByTestId('intent-create-inline')
    await inline.getByTestId('intent-create-message').fill('Build an auditor agent for RFC-319.')
    await inline.getByRole('button', { name: 'Start building', exact: true }).click()
    await page.waitForURL(/\/intent\/[0-9A-Z]+/i, { timeout: 60_000 })
    const sessionId = /\/intent\/([0-9A-Z]+)/i.exec(page.url())?.[1] ?? ''
    await expect(page.getByTestId('intent-draft'), '会话没有产出可提交的草稿').toBeVisible({
      timeout: 90_000,
    })

    // 把提交请求扣在半路——「服务端可能正在落地，浏览器还不知道结局」这个窗口，
    // 正是这条守卫存在的全部理由。请求原样放行，只是延后。
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let commitAttempts = 0
    await page.route(
      (url) => url.pathname === `/api/intent-sessions/${sessionId}/commit`,
      async (route) => {
        commitAttempts += 1
        await held
        await route.continue()
      },
    )
    // 扣住的那条请求必须**无论如何**被放行：任何一条断言提前红掉时，
    // afterEach 的 unrouteAll({ behavior: 'wait' }) 会等这个 handler 跑完，
    // 不放行就会把失败变成挂死，报告里看到的将是超时而不是真正的失败点。
    try {
      await page.getByTestId('intent-open-commit').click()
      const commitDialog = page.getByRole('dialog', { name: 'Confirm and commit changeset' })
      await expect(commitDialog, '提交向导没打开').toBeVisible({ timeout: 20_000 })
      await expect(commitDialog.getByTestId('intent-commit-step-heading')).toHaveText('Strategy')
      await page.getByTestId('intent-commit-next').click()
      await expect(commitDialog.getByTestId('intent-commit-step-heading')).toHaveText('Details')
      const newName = commitDialog.getByPlaceholder('New name')
      if ((await newName.count()) > 0)
        await newName.first().fill(`rfc319-x6-${Date.now() % 100000}`)
      await page.getByTestId('intent-commit-next').click()
      await expect(commitDialog.getByTestId('intent-commit-step-heading')).toHaveText('Review')

      const submit = page.getByTestId('intent-commit-submit')
      await submit.click()
      await expect
        .poll(() => commitAttempts, { timeout: 20_000, message: '点了提交却没有发出提交请求' })
        .toBe(1)

      // ① 提交按钮换成进行中文案并锁死——不然用户会以为没点上，再点一次。
      await expect(
        submit,
        '提交进行中按钮还可点 ⇒ 用户以为没点上就再点一次，同一份变更集被提交两遍',
      ).toBeDisabled()
      await expect(submit, '提交进行中按钮没有换成进行中文案').toHaveText('Committing…')

      // ② 三条关闭路径全部失效。任何一条能把向导关掉，用户就会在「服务端到底改没改」
      //    这个问题上失去唯一的现场。
      await expect(
        commitDialog.getByRole('button', { name: 'Cancel', exact: true }),
        '提交进行中「取消」还能点 ⇒ 用户会以为自己撤销了一次已经在服务端跑着的提交',
      ).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(
        commitDialog,
        '提交进行中按 ESC 就把向导关掉了 ⇒ 用户失去这次提交的唯一现场，' + '既看不到结果也无从重试',
      ).toBeVisible()
      // 遮罩点击：坐标取对话框外的左上角，确保落在 overlay 上而不是面板里。
      await page.mouse.click(4, 4)
      await expect(
        commitDialog,
        '提交进行中点一下遮罩就把向导关掉了 ⇒ 同上，一次误点就丢掉现场',
      ).toBeVisible()

      // ③ 页面级守卫：站内导航必须被拦下，且真的没走成。
      //    走浏览器**后退**而不是点侧栏——提交向导是 modal，侧栏此刻被遮罩挡着点不到；
      //    而后退是这个状态下用户真正走得掉的那条路（也是 UnsavedChangesGuard 文件头
      //    列的四条拦截目标之一）。
      await page.evaluate(() => {
        window.history.back()
      })
      const guard = page.getByRole('dialog', { name: 'Commit is still in progress' })
      await expect(
        guard,
        '提交进行中切走页面没有任何拦截 ⇒ 用户走掉了，这次提交的结果再也没人对账',
      ).toBeVisible({ timeout: 20_000 })
      await guard.getByRole('button', { name: 'Stay here', exact: true }).click()
      await expect(guard, '点了「留下」守卫对话框没收起').toHaveCount(0)
      expect(new URL(page.url()).pathname, '守卫弹了框，导航却照样走成了 ⇒ 拦截只是个装饰').toBe(
        `/intent/${sessionId}`,
      )

      // ④ 放行之后一切恢复正常：提交落地、向导自己收掉。没有这一步，
      //    上面三条「关不掉」也可能只是「这个界面本来就卡死了」。
      release()
      await expect(
        commitDialog,
        '提交落地之后向导仍然关不掉 ⇒ 那三条「关不掉」其实是界面卡死，不是守卫',
      ).toHaveCount(0, { timeout: 60_000 })
      const committed = await apiJson<{ session: { commitSeq: number } }>(
        daemon,
        `/api/intent-sessions/${sessionId}`,
        {},
        'read intent session after commit',
      )
      expect(
        committed.session.commitSeq,
        '扣住又放行的那次提交没有在服务端落地 ⇒ 这条用例守的窗口根本不存在',
      ).toBeGreaterThan(0)
    } finally {
      release()
    }
  })
})
