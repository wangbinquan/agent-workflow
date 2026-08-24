# RFC-319 技术设计：用户面 system-mock e2e 覆盖加固

本文承接 `proposal.md`。读之前先读它的 §1（三种失败形态）与 §2（G1–G6）。
逐条缺口清单在同目录 `findings.md`，机器索引在 `findings.json`。

## 0. 与 RFC-294 目标架构的关系（CLAUDE.md §RFC workflow 第 8 条）

**本 RFC 零生产代码功能改动**，因此不新增任何 bounded context、不新增跨模块耦合、
不往 `routes/` / `services/` 加 facade。交付物全部落在三处既有位置：

| 交付物 | 落位 | 理由 |
| --- | --- | --- |
| 浏览器用例 | `e2e/*.spec.ts` | 既有目录，不改组织结构 |
| 后端 system-mock 用例 | `packages/backend/tests/`（PR 档）/ `packages/backend/tests/nightly/`（nightly 档） | 与既有 6 个 RFC-310 套件同层 |
| 三份机器账本 + 守卫 | `architecture/*.json` + `packages/backend/tests/architecture/*.test.ts` | **RFC-317 已经建好的账本/守卫机制，本 RFC 入网而不另起一套** |

最后一行是本设计的一条硬约束，来自 RFC-317 收口时自查出的 T72：
> R10 号称「覆盖仓内每一个 allowlist」，实测 27 处账本只覆盖 8 处，且**没有任何东西要求新账本入网**
> ——「加一份新的豁免表」是绕过整套高水位机制最省事的办法。

所以 R1/R2/R3 的三份账本**必须**注册进 `architecture/ledger-baselines.json`（32 条现有条目，
由 `rfc317-ledger-highwater.test.ts` 强制「与源码逐字相等 + 相对上一 commit 只降不升」），
R1–R4 的每条守卫**必须**注册进 `architecture/guard-manifest.json`（144 条现有条目，
由 `rfc317-guard-negative-fixture.test.ts` / `rfc317-guard-corpus-floor.test.ts` 强制
「断言不存在的必须配负 fixture」「扫语料的必须声明语料下限」）。
不入网的账本 = 新的空白许可证。

## 1. 补测的层次落位规则（proposal G5）

这是全篇最需要被机械执行的一条——它决定 679 条各落在哪，直接决定 CI 成本。

| 缺口的语义类型 | 落位 | 为什么 |
| --- | --- | --- |
| 权限拒绝分支（403 / 404 同形 / PAT 作用域 / 越权写） | **后端 system-mock e2e** | 断言面是 HTTP 状态码与响应体形状，不需要浏览器；且今天这类分支大量只有内存 DB 单测 |
| 乐观锁 / CAS 冲突（409、`expectedUpdatedAt`、版本冲突） | **后端 system-mock e2e** + 一条 UI 接线断言 | 冲突语义在后端，UI 只需证明「409 被呈现成可读提示而不是白屏」 |
| 外部系统协议（验签失败、去重、限流、熔断、replay、rotate 后旧凭据失效） | **后端 system-mock e2e** | system-mocks 的 code-host / OIDC / registry 就是为这个建的 |
| 破坏性操作的**拒绝**分支（被引用时拒删、内置只读、需二次确认） | **后端 system-mock e2e** | 同上；确认框本身另算一条 UI 接线断言 |
| 数据往返完整性（表单字段 → PUT → SQLite → reload 读回） | **浏览器 e2e** | 这类缺陷正是「后端对、前端漏拷」，只有走 UI 才照得到 |
| 表单 / 弹窗 / 拖拽 / 多标签页同步 / WS 实时推送 | **浏览器 e2e** | 断言面就是 DOM 与实时性 |
| 首屏与登录路径（`/setup/admin`、登录、退出、会话失效） | **浏览器 e2e** | 每个部署都会走一遍，且失败形态是白屏 / 死循环 |
| 页面可达性（路由能打开、空态/错误态呈现） | **浏览器 e2e**，一条用例覆盖多条能力 | 廉价，且是 R2 账本的证据来源 |

**UI「最小接线断言」的定义**（防止把它写成又一个空洞绿）：一条接线断言必须同时满足
①触发一次真实用户动作（点击 / 提交 / 拖放），②断言一个**只有请求真的发出并成功才会出现**的
可观察结果（列表新增行、URL 变化、脏点消失、错误横幅带服务端文案），
③**不允许**用「元素存在」「计数为 0」这类在功能失效时同样成立的断言收尾——
`findings.md §2` 的 8 条空洞绿全部栽在第③点上。

## 2. 风险分流与 CI 拓扑（proposal G4 / I1 / I2）

### 2.1 分档标记

用 Playwright 原生 tag（`@playwright/test` ^1.50 支持 `test(title, { tag: '@x' }, fn)`）：

```ts
test('rotate secret invalidates the previous signature', { tag: '@nightly' }, async () => { … })
```

- **不带 tag = PR 档**。今天 62 spec / 340 用例一条不动，全部留在 PR 腿。
- **`@nightly` = nightly 档**。本轮新增的 P2 + P3（593 条）全部带这个 tag。
- P1（86 条）新增用例**不带 tag**，自动进 PR 腿。

选 tag 而不是分目录的理由：同一个能力的 P1 与 P2 断言常常共用一段 fixture 搭建
（例如「建端点 → 取 secret」既是 P1 的前置，也是 P2 rotate 用例的前置），
分目录会逼出重复的 fixture 代码；tag 让它们住在同一个 spec 里、共享 `beforeAll`。

### 2.2 CI 三条腿

| 腿 | 触发 | 跑什么 | 分片 |
| --- | --- | --- | --- |
| `e2e`（既有，PR 门） | push / PR | `--grep-invert` 掉 `@nightly` | ubuntu 2 / macOS 2 / windows 3 → **按实测上调**，目标是单片墙钟不超过今天的水平（20 分钟 timeout 不动） |
| `e2e-full-nightly`（新增） | cron + `workflow_dispatch` | **全部**用例（不加任何 grep 过滤） | 4 片起，按实测调 |
| `e2e-webkit-nightly`（既有） | cron | 保持现状 | 4 |

**windows 的 grep 组合是一个坑**：`ci.yml:696` 已经在用
`--grep-invert "$AW_E2E_WINDOWS_EXCLUDE"`，而 Playwright 只接受**一个** `--grep-invert`。
两者必须合成一条正则（`(@nightly)|(<既有排除项>)`），不能写两次 flag——写两次时后一个静默覆盖前一个，
于是 windows 腿会把 `@nightly` 全跑进 PR 门。这条要配一个守卫（见 §5 R4-c）。

### 2.3 后端档位

后端 system-mock 用例没有 tag 机制，按目录分：

- PR 档：`packages/backend/tests/*.test.ts`（现状，含 6 个 RFC-310 套件）
- nightly 档：`packages/backend/tests/nightly/**/*.test.ts`

`scripts/test-backend-sharded.ts` 与 `bun run test:backend` 显式排除 `tests/nightly/`；
`e2e-full-nightly` 里增加一步跑它。**排除清单与目录必须由守卫钉死**（否则「排除了但没人跑」
和「目录空了但排除还在」两种漂移都无声）——这是 `docs/dev-gotchas.md` §「`gate:local` 不跑
system mock 用例」那条教训的同族：本地门禁与 CI 的命令集有差集时，差集里的东西迟早找上门。

## 3. R1 运行期端点命中账本

### 3.1 判据

> 跑完**全套** e2e 之后，`allRouteMeta()` 声明的 462 条端点里，有哪些**一次都没有被打到**。
> 这个集合与 `architecture/e2e-endpoint-coverage.json` 逐条相等，且只减不增。

判据的一端（分母）是**活的源码**——`allRouteMeta()` 是框架在 `createApp` 之后实际持有的
声明表，计算路径、helper 挂载、`src/routes/` 之外的文件都逃不掉
（`rfc317-route-contract-oracle.test.ts` 已经用它替换了正则扫描器，正因为正则对
`path: cfg.base` 这种计算路径整族失明）。另一端（分子）是**运行期实测**，不是静态扫描——
静态扫描只能看见 spec 里直接 `fetch(${baseUrl}/api/...)` 的 fixture 调用，
而绝大多数请求是浏览器点击触发的，静态扫描一条都看不见。

### 3.2 采集：零生产改动

已实测确认的三个既有事实拼起来就够了：

1. `packages/backend/src/server.ts:317` 有一条 `app.use('*')` 中间件，
   逐请求 `log.debug('req', { method, path, status, ms })`。
2. `packages/backend/src/cli/start.ts:274` 启动时 `configureLogger({ level: …, logFile: Paths.daemonLog })`
   ——**每一行日志都会 append 到 `<AGENT_WORKFLOW_HOME>/daemon.log`**。
3. 同文件 `:375-378`：`if (config.logLevel !== 'info') configureLogger({ level: config.logLevel })`
   ——config.json 里写非 `info` 的值就会生效。

而 `e2e/harness.ts:556` 正好在给每个 daemon 写 `logLevel: 'info'`。**把它改成 `'debug'` 即可**，
改的是测试 harness，生产代码一行不动。

采集时序（harness 侧）：

```
startDaemon() → 写 config.json（logLevel: 'debug'）→ 起编译后的 daemon
   …spec 跑…
stop() → 在删除临时 home 之前，从 <home>/daemon.log（含轮转出来的 daemon.log.1..5）
         提取所有 `req` 行 → 归一成 {method, path} → 追加写到
         test-results/route-hits/<spec>-<pid>.jsonl → 再走既有的 rm 逻辑
```

三处必须小心：

- **轮转**：`log.ts` 到 10MB 轮转、保留 5 份。debug 档下长 spec 有可能触发，
  提取器必须把 `daemon.log*` 全部读进来。读漏了的后果是「少记命中」，
  方向上是**保守**的（把已覆盖的报成未覆盖），不会把未覆盖的漂绿。
- **teardown 顺序**：`DaemonHandle.stop()` 会 `rmSync` 临时 home，提取必须排在它前面。
  `keepHome=true` 的分支（crash-recovery 复用同一个 home 起两次 daemon）要保证两次都提取到。
- **日志格式**：`formatHuman` 输出 `[ts] DEBUG [server] req method=GET path=/api/x status=200 ms=3`，
  `jsonMode` 时是 JSON。提取器两种都要认，并且对**认不出任何一行**的情况 fail closed
  （见 §5 R4-b 的语料下限）。

### 3.3 归一：具体路径 → 路由模式

日志里是具体路径（`/api/agents/01JD…`），账本要的是模式（`/api/agents/:id`）。
逐段比较，**最多字面量段获胜**——这与 Hono 自身的路由优先级一致，
所以不会把 `/api/workflows/new` 错记成 `/api/workflows/:id` 的命中
（`rfc317-route-contract-oracle.test.ts` 之外，`api-contract-coverage.test.ts:275` 的
反方向守卫已经在用同族的逐段匹配器，两边共用一份实现，避免「账本一套判据、守卫另一套判据」）。

**method 必须一并比对**。RFC-310 PR-10 的实测教训：删的是 `PUT /api/code/matrix/:repoId`
而同路径的 `GET` 还在，只比 path 的守卫会全部放行。

### 3.4 在哪里执行

**只在 `e2e-full-nightly` 里执行**。PR 腿只跑 PR 档，它的命中集合天然小于全量，
拿它去比账本会得到一份错误的（过大的）未命中集合。所以：

- nightly job 各分片跑完后 `upload-artifact` 自己的 `route-hits/`；
- 一个 `route-coverage-ledger` 汇总 job `download-artifact` 全部分片 → 求并集 → 与账本逐条相等断言。
- 汇总 job 对「分片数 < 预期」「并集为空」「某分片没有产出 journal」三种情况 **fail closed**。

PR 腿不做 R1，但做 R2-static / R3 / R4（都是静态的，进 `gate:local`）。

## 4. R2 前端路由 × e2e 账本

### 4.1 两层判据

**R2-static（进 `gate:local` 与 PR CI）**——分母派生自 `packages/frontend/src/routes/*.tsx` 的
`createRoute({ path })` 与 `router.tsx` 的路由树（今天 58 条）。
判据：每条路由的字面量必须在 `e2e/**` 里出现过，否则必须在
`architecture/e2e-route-coverage.json` 里显式登记为缺口。**新加一个页面而没有任何 e2e ⇒ 本地就红。**
今天的初值：18 条从未被直达，其中 12 条连字符串都不出现（`/setup/admin`、`/code/missions/*`、
`/code/outcomes`、`/fusions/$id`、`/memory/distill-jobs/$jobId`、`/plugins/$id`、`/plugins/new` 等）。

R2-static 有一个已知的弱点：字符串出现 ≠ 真的导航过去 ≠ 做过功能断言。它只挡「全新的页面零 e2e」，
挡不住「有个 spec 提到过这个路径但什么也没测」。这个弱点由 R2-runtime 补。

### 4.2 R2-runtime（nightly，权威判据）

分子改成运行期实测：所有 spec 从 `e2e/test.ts` 这个**共享入口**导入 `test` / `expect`，
而不是直接 `from '@playwright/test'`。该入口用 `test.extend` 包一层 `page` fixture，
监听 `framenavigated` 把每次导航的 pathname 归一成路由模式后写进同一份
`test-results/route-hits/` journal（与 R1 共用汇总管道）。

代价与风险：需要把 62 个 spec 的 import 改掉（机械改动），并加一条源码守卫
「`e2e/**` 不得直接 import `@playwright/test`」——否则下一个人新建 spec 时照旧写老写法，
而**那条 spec 的导航就此对账本隐形**，账本会朝「看起来覆盖更少」的方向漂
（同样是保守方向，但会制造假缺口，浪费后来者的时间）。

这条改动比 R1 侵入面大，`plan.md` 里单列一批（T40 系列），可独立 revert。

## 5. R3 能力账本 与 R4 守卫自证

### 5.1 R3：`architecture/e2e-capability-ledger.json`

本次审计的 820 条能力落成机器账本，每条：

```jsonc
{
  "id": "AGENT-04",
  "domain": "代理",
  "title": "编辑既有代理的普通字段并保存",
  "tier": "pr",                       // pr | nightly
  "status": "covered",                // covered | gap
  "evidence": [                       // status=covered 时必填、status=gap 时必须为空
    { "file": "e2e/agent-authoring.spec.ts", "test": "rich agent fields survive a description-only save" }
  ],
  "gapSince": null                    // status=gap 时填 RFC 号，说明谁欠着
}
```

守卫（`rfc319-capability-ledger.test.ts`）四条断言：

1. **证据可达**：每条 `evidence` 的 `file` 存在，且该文件里**逐字**包含那个 test 标题。
   这一条直接终结 `e2e/CAPABILITY_COVERAGE.md` 那种散文漂移——改名或删用例立刻红。
2. **状态与证据互斥**：`covered` 必须有证据，`gap` 必须没有。
3. **gap 只减不增**：`status=gap` 的条目数注册进 `ledger-baselines.json`，
   由 RFC-317 的高水位守卫强制只降不升；要升必须 `allowGrowth` 并点名 RFC。
4. **总数可增但必须有出处**：新能力（新功能）允许追加行，但追加的行要么带证据，
   要么带 `gapSince` 指向一个已登记的 RFC——**不允许匿名欠账**。

### 5.2 R4：守卫自证（沿用 RFC-317 已有机制，不新建）

本轮新立的每条守卫（R1 汇总断言、R2-static、R2-runtime import 守卫、R3 四条、
§2.2 的 grep 组合守卫、§2.3 的后端目录排除守卫）都要在
`architecture/guard-manifest.json` 追加条目，并满足既有 manifest 的字段契约：

- `corpusScanner: true` 的必须声明 `minCorpusFiles` 下界（挡「扫了个寂寞」的空转绿）；
- `assertsAbsence: true` 的必须 `negativeFixture: true` 并提供会让它变红的变异样本。

**每条守卫都要做一次变异实证并记录**：把真实事故形态注入 → 确认转红 → 撤销 → 确认转绿。
`docs/dev-gotchas.md` 已经记了这条的反面教材（「我在 commit message 里宣布已锁上的那条断言
因字段名笔误 + `as never` 遮掩仍是 no-op，同一变异照样全绿」），本轮不重蹈。

## 6. 空洞绿的修复口径（proposal G2）

8 条逐条处置见 `findings.md §2`。统一口径三条：

1. **先写会红的断言，再确认它红**。修 `rfc099-ownership-acl.spec.ts:188` 时，
   正确断言是「carol 打开详情页后看到的是与不存在同形的结果」——先把 alice 的私有化那步注释掉，
   确认新断言**会红**，再恢复。不做这一步就无法区分「修好了」和「换了个恒真断言」。
2. **恒真断言的成因要写进注释**。每条修复在 test 上方写清「原断言为什么恒真」，
   让未来的 refactor 一旦改回去能立刻看出意图（CLAUDE.md §Test-with-every-change 的回归防护命名要求）。
3. **`rfc250-visual-states.spec.ts:530` 的 skip 是分类错误**，不是覆盖缺口：
   「代理引用完整性告警」是功能断言，被误放进了只在 visual nightly 跑的 describe。
   处置是把这条功能断言**搬出去**（搬到 PR 档的功能 spec），而不是给 visual describe 解 skip。

## 7. 失败模式与对策

| 失败模式 | 症状 | 对策 |
| --- | --- | --- |
| 新写的 spec 从未真跑过 | testid 在前端源码里根本不存在（RFC-310 T140 实测：21 个 testid 的 spec 头三个就不存在） | 每批收口前 `grep -o "getByTestId('[^']*')" <spec>` 逐个回 grep 前端源码；动态拼接的按前缀比对。写进 `plan.md` 每批的检查项 |
| 改选择器只靠源码守卫验证 | 守卫绿、真浏览器全超时（2026-08-20 实测：CI 从 2 failed 变 26 failed，跑时 1.5min→8.3min） | 凡改选择器 / 等待条件，必须本机真跑；判据是看失败是 `toHaveScreenshot` 还是 `toBeVisible` 超时 |
| debug 日志拖慢 daemon 造成 flaky | 时序敏感用例间歇红 | 先在一个分片上实测对比墙钟；若显著劣化，退化方案是只对 nightly 全量腿开 `logLevel: 'debug'`，PR 腿维持 `info`（R1 本来也只在 nightly 执行） |
| R1 归一把两个端点混成一个 | 账本少了一条却没人发现 | method + 最多字面量段获胜；并对「日志里出现了 `allRouteMeta()` 里不存在的路径」也断言（反方向的 zombie 检测） |
| nightly 红了没人看 | 债务无声累积 | 本仓已有 visual-regression-nightly 先例；`plan.md` 要求把 nightly 失败的响应流程写进 `docs/dev-gotchas.md` 并在 STATE.md 留一行 |
| 账本变成新的空白许可证 | 有人加违规同时加豁免 | 三份账本全部注册进 `architecture/ledger-baselines.json`，由 RFC-317 的高水位守卫管；不入网就等于绕过（T72 教训） |
| e2e 改动本地 typecheck 看不见 | `e2e/` 不在任何 tsconfig include | 改完 e2e 必须跑**根级** `bun run lint`（= 各 package lint + `lint:repo-ui`），不能只跑 `--filter <pkg> lint` |

## 8. 测试策略（本 RFC 自身的验收面）

本 RFC 的交付物大部分**就是**测试，所以「测试策略」这一节说的是**守卫的守卫**：

- **每条新守卫配负 fixture**（R4），并跑一次变异实证；证据记进 `plan.md` 的验收清单。
- **每条账本配语料下限**：R1 断言「journal 非空且分片数达标」，R2 断言「路由数 > 40」，
  R3 断言「账本条目数 > 700」——挡住「目录挪走 / 后缀改名 / 路由树换写法」导致的空转绿。
- **反方向断言**：R1 除了「未命中集合相等」，还要断言「日志里没有出现注册表里不存在的端点」，
  这条与 `api-contract-coverage.test.ts:275` 既有的「e2e 打了已删端点」形成闭环。
- **本轮新增的每一条 e2e 用例都必须在本机真跑过一次**（AC-6），不接受「CI 会替我跑」。

## 9. 明确的偏离与遗留债

- **R2-static 的字符串判据偏松**（出现 ≠ 覆盖）。这是刻意的：它的职责是挡「全新页面零 e2e」，
  精确判据由 R2-runtime 承担。两者的分工写进守卫注释，避免后来者误以为 static 那条就是全部。
- **R1 只在 nightly 执行**，PR 腿拿不到端点覆盖的即时反馈。代价是：一个 PR 加了新端点、
  没有任何 e2e 打它，要到当晚才红。可接受——R3 能力账本在 PR 档就会因为「新能力没有证据」而红。
- **679 条不会在一批里落完**。`plan.md` 按域分批，每批独立可 revert、独立过门禁。
  批与批之间账本单调收敛（gap 计数只降），任何一批中断都不会留下半截状态。
