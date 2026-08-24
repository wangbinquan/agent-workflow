# RFC-319 任务分解：用户面 system-mock e2e 覆盖加固

读之前先读同目录 `proposal.md`（背景 / G1–G6 / AC-1–AC-8）与 `design.md`（层次落位规则 / 分流 /
四层棘轮）。逐条缺口在 `findings.md`，机器索引在 `findings.json`。

本仓**只在 `main` 上开发、不建分支、不开 PR**（CLAUDE.md 硬规则），所以下文的「批」= 一次或数次
提交，不是 PR。每批都必须独立过 `bun run gate:local`、独立可 revert。

## 0. 开工前置（必须先做，否则后面全部计数不可信）

| 任务 | 内容 | 依赖 |
| --- | --- | --- |
| **T1** | 在**干净的 exact SHA** 上重采分母：`allRouteMeta()` 端点数（落档时 462）、`router.tsx` 路由数（58）、`e2e/*.spec.ts` 用例数（340）、`startSystemMockSuite` 文件数（6）。落档基线是 `92478e636`，且当时工作树上有并发 session 的大批未提改动（RFC-318 数字员工工具合同等） | — |
| **T2** | 若 T1 与 `findings.md §1` 的数字有出入，**只订正分母**，不重跑 820 条审计；出入写进本文件 §7 变更记录 | T1 |
| **T3** | 确认 `design/RFC-318-minimal-digital-employee-tool-contracts/`（并发 session 的 RFC）与本 RFC 无交叉改动面；若他们的实现会新增用户面能力，在 R3 账本里给它们留 `gapSince: RFC-318` 的位置而不是替他们补测 | T1 |

## 1. B1 — 分档工装与 CI 拓扑（design §2）

| 任务 | 内容 |
| --- | --- |
| **T10** | `e2e/` 引入 `@nightly` tag 约定；在 `e2e/README.md` 写清「不带 tag = PR 档」与选 tag 不选分目录的理由 |
| **T11** | `ci.yml` 的 `e2e` job 增加 `--grep-invert`；**windows 腿必须与既有 `$AW_E2E_WINDOWS_EXCLUDE` 合成一条正则**（`(@nightly)\|(<既有>)`）——Playwright 只认一个 `--grep-invert`，写两次后一个静默覆盖前一个 |
| **T12** | 新建 `.github/workflows/e2e-full-nightly.yml`：cron + `workflow_dispatch`，**不加任何 grep 过滤**跑全量，分片 4 起；产出 `route-hits/` artifact |
| **T13**（未做，留待第一条 nightly 档后端用例落地时一起做）| `packages/backend/tests/nightly/` 目录 + `scripts/test-backend-sharded.ts` 与 `bun run test:backend` 的排除；`e2e-full-nightly` 增加一步跑它 |
| **T14** | 守卫：①排除清单与目录两向钉死（目录存在但没被任何腿跑 ⇒ 红；排除项指向不存在的目录 ⇒ 红）；②windows grep 合成正则里必须同时含 `@nightly` 与既有排除项 |
| **T15** | `gate:local` 增加**可选** Playwright 车道（默认关，显式开），并在 `packages/backend/tests/local-gate-runner.test.ts` 的车道断言里登记 |

## 2. B2 — 四层棘轮（design §3–§5）

棘轮**先于**补测落地：账本初值 = 今天的实测缺口集合，之后每个域批把它单调压小。
这样「进度」本身是机器可见的，且任何一批中断都不留半截状态。

| 任务 | 内容 |
| --- | --- |
| **T20** | `e2e/harness.ts`：`logLevel: 'info'` → `'debug'`（`harness.ts:556`）；`stop()` 在 `rmSync` 临时 home **之前**提取 `<home>/daemon.log*` 的 `req` 行 → `test-results/route-hits/<spec>-<pid>.jsonl`。覆盖 `keepHome=true` 的两次起停分支 |
| **T21** | 归一器：具体路径 → 路由模式，**method 一并比对**、最多字面量段获胜；与 `api-contract-coverage.test.ts:275` 的逐段匹配器**共用一份实现**，不得各写一套 |
| **T22** | `architecture/e2e-endpoint-coverage.json` 初值 = 全量 nightly 实测的未命中集合；汇总 job `route-coverage-ledger`：下载全部分片 artifact → 求并集 → 逐条相等断言 + 反方向 zombie 断言（日志里出现了注册表没有的端点） |
| **T23** | R1 的 fail-closed：分片数 < 预期 / 并集为空 / 某分片无 journal / 认不出任何一行日志格式 —— 四种都必须红 |
| **T24** | **R2-static**：从 `routes/*.tsx` 的 `createRoute({ path })` + `router.tsx` 派生路由集；`architecture/e2e-route-coverage.json` 初值 = 今天的 18 条未直达（其中 12 条零字符串命中）；守卫进 `gate:local` |
| **T25** | **R2-runtime**：新建 `e2e/test.ts` 共享入口（`test.extend` 包 `page`，监听 `framenavigated` 写 journal）；62 个 spec 的 import 机械迁移；源码守卫「`e2e/**` 不得直接 import `@playwright/test`」。**本任务侵入面最大，单独一批、可独立 revert** |
| **T26** | **R3**：`architecture/e2e-capability-ledger.json` 从 `findings.json` 播种 820 行；141 条 `covered` 的证据要**逐条归一**成 `{file, test}` 并验证 test 标题逐字存在——这一步会顺带照出 `findings.md` 里写歪的证据，照出来的就地订正 |
| **T27** | R3 守卫四条断言（证据可达 / 状态与证据互斥 / gap 只减不增 / 总数可增但须有出处） |
| **T28** | **入网**：三份账本注册进 `architecture/ledger-baselines.json`；R1–R4 全部守卫注册进 `architecture/guard-manifest.json`，按既有字段契约填 `corpusScanner` / `minCorpusFiles` / `assertsAbsence` / `negativeFixture` |
| **T29** | **R4 变异实证**：逐条守卫注入真实事故形态 → 确认转红 → 撤销 → 确认转绿；证据记进本文件 §6 验收清单。**没做过变异实证的守卫不算交付** |

## 3. B3 — 8 条空洞绿修复（design §6）

逐条见 `findings.md §2`。口径：先写会红的断言并**确认它红**，再恢复被测行为；
恒真成因写进 test 上方注释。

| 任务 | 条目 | 处置要点 |
| --- | --- | --- |
| **T30** | `AGENT-31` | `rfc099-ownership-acl.spec.ts:188` 的 `acl-panel` 计数恒为 0（carol 从未打开该弹窗）。改成断言「详情页与不存在同形」，并先注释掉私有化那步验证会红 |
| **T31** | `WF-49` | `workflow-editor.spec.ts` 的删除用例只开框跑 axe 点 Cancel；全仓无一处对 `/api/workflows` 发过 DELETE。补真删除 + 名字二次确认 + 版本 CAS |
| **T32** | `AGENT-35` | 功能断言被误关在 `rfc250-visual-states.spec.ts:530` 的 `test.skip(!RUN_VISUAL_REGRESSION)` describe 里。**搬出去**到 PR 档功能 spec，不是给 visual describe 解 skip |
| **T33** | `EVENT-46` | `rfc232-owner-list.spec.ts` 全程 admin 身份，peer 只用来播种。补真正的非 admin 会话可见性边界 |
| **T34** | `TASK-32` | 任务成员面板对话框从未被打开、`members-save` 从未被点、转让所有权从未跑过 |
| **T35** | `DE-10` | 泳道拖拽重排发生在未保存草稿里且以 Cancel 收尾，「刷新后仍生效」在源码里不存在。补 publish + reload + 序断言 |
| **T36** | `OPS-002` | harness 把同一个 bindPort 既写进 config.json 又传成 flag，两者恒等，「flag 压过 config」不可分辨。构造两者不同的场景 |
| **T37** | `UX-19` / `WF-23` | 覆盖面清单写错（前者漏记三处已有整页 axe 扫描，后者 `workflow-camera-focus-selection` 全仓零命中）。订正账本 + 补 focusSelection 断言 |

## 4. B4–B18 — 逐域补测（design §1 层次落位）

**同一个域的 P1 / P2 / P3 一起做**——它们大量共用 fixture 搭建（例如「建端点 → 取 secret」
既是 P1 前置也是 P2 rotate 用例前置），分开做会逼出重复代码。档位靠 tag 区分：
P1 不带 tag（PR 腿），P2 / P3 带 `@nightly`。

按 P1 密度排序，先做风险最集中的：

| 批 | 域 | 缺口 | P1 | P2 | P3 | 备注 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| **B4** | 身份、认证、用户与资源权限 | 38 | 15 | 18 | 5 | P1 密度最高；`/setup/admin` 首屏、退出登录、会话失效、越权写他人 public 资源 |
| **B5** | 技能 / 插件 / MCP | 50 | 11 | 30 | 9 | 技能详情整页零 e2e（Save All / 文件树 / 版本回滚 / 删除拒绝 / 可见性）；PAT 脱敏 |
| **B6** | 事件自动化 | 47 | 10 | 23 | 14 | `scripts:author` 五处拒绝分支全仓零命中（违反 CLAUDE.md 硬规则）；rotate secret、去重、熔断、replay |
| **B7** | 记忆与蒸馏 | 52 | 8 | 28 | 16 | 四类 scope 的 ACL 边界、候选行只对资源管理员可读、蒸馏任务详情页零直达 |
| **B8** | 仓库、仓库组与 Git | 41 | 7 | 25 | 9 | 凭据脱敏、推送拒绝、镜像 GC、worktree 清理 |
| **B9** | 代理 | 45 | 6 | 12 | 27 | 富字段保存往返（`agents.detail.tsx:315-353` 四条事故墓碑）、409 冲突、能力引用不丢 |
| **B10** | 意图构建器与融合 | 62 | 6 | 41 | 15 | 融合可见性隔离、跨用户 approve/reject 拒绝形状 |
| **B11** | 数字员工 / 开发任务 | 36 | 5 | 20 | 11 | UI 面为主（后端 journey 已有 6 个 system-mock 套件）；`/code/missions/*` 零直达；`retireTool` 零校验（可能是真缺陷，按 §5 处理） |
| **B12** | 工作流与画布编辑器 | 50 | 5 | 34 | 11 | wrapper 归属拖放、连线弹窗提交、冲突三条恢复动作、code-host-call 检查器（全 e2e 零命中） |
| **B13** | 任务生命周期 | 33 | 3 | 25 | 5 | 删除终态任务、成员面板、启动前置权限门的绕 UI 直打接口分支 |
| **B14** | 前端横切 | 35 | 3 | 16 | 16 | 退出登录、WS 4401/4403 语义、WS 推送让**已打开的**页面自更新（今天全部是「先收 WS 再 goto」） |
| **B15** | 人机交互门 | 42 | 2 | 28 | 12 | 引擎侧已扎实；缺的是浏览器里走完门 + 任务问题看板整条产品线（e2e 零字符串命中） |
| **B16** | 设置、运行时、文档与总览 | 51 | 2 | 31 | 18 | 全仓没有一条 e2e 点过设置页的 Save；备份/恢复的「选文件 ≠ 上传」护栏 |
| **B17** | 运维面 CLI / daemon / 备份恢复 | 48 | 2 | 22 | 24 | 备份→改数据→恢复→重启的完整往返（五组路径 e2e 全零命中）；`auth password-login` 零测试 |
| **B18** | 工作组 | 49 | 1 | 30 | 18 | 自动保存的冲突处置（工作流侧有 5 条弱网用例，工作组侧 0 条） |

每批的**收口检查项**（写进提交前的自查，来自 `docs/dev-gotchas.md` 的实测教训）：

1. `grep -o "getByTestId('[^']*')" <新增/改动的 spec>` 逐个回 grep `packages/frontend/src` 确认存在；
   动态拼接的按前缀比对。**RFC-310 T140 实测：一条 21 个 testid 的 spec，头三个在源码里根本不存在。**
2. 新增 / 改动的 spec **在本机真跑过一次**（`bun run build:binary:e2e` + `bunx playwright test <spec>`）。
   「本机跑不了、CI 会替我跑」通常是错的。
3. 改了选择器 / 等待条件的，必须真浏览器跑——源码层守卫只能证明两处字符串一致，**它看不见 DOM**。
4. 跑**根级** `bun run lint`（`e2e/` 只被 `lint:repo-ui` 覆盖，`--filter <pkg> lint` 漏它）。
5. `bun run gate:local` 全绿；推完立刻按**本人 exact SHA** 查 CI。
6. 账本单调性：本批把 R1/R2/R3 的 gap 计数**压小了多少**，写进 commit body。

## 5. 补测过程中发现真缺陷时的处置

审计已预判若干条（例如 `retireTool` 对「工具正被已发布岗位模板绑定」零校验、
`forcePasswordChange` 后端发信号前端零消费）。口径：

1. 先写一个**能稳定复现**的用例（红），再写修复（绿）——CLAUDE.md §Test-with-every-change。
2. 生产改动**单独 commit**，与测试批分开，commit message 写清是本 RFC 补测时照出来的。
3. 在本文件 §7 逐条登记；若缺陷涉及产品行为判断（不是明显 bug），**停下来问用户**，不自行裁决。

## 6. 验收清单（对齐 `proposal.md` AC-1–AC-8）

- [ ] **AC-1** 679 条缺口逐条有用例，且在 R3 账本里指向具名证据；账本守卫验证证据可达
- [ ] **AC-2** 8 条空洞绿修复完毕，每条附变异实证记录（注入→红→撤销→绿）
- [ ] **AC-3** R1/R2/R3/R4 四条棘轮全绿；每条自带负 fixture 能自证会红；每条断言语料非空
- [ ] **AC-4** 三份账本注册进 `architecture/ledger-baselines.json`，条目数只减不增
- [ ] **AC-5** PR 腿单片墙钟不超过今天的水平；`e2e-full-nightly` 能完整跑完
- [ ] **AC-6** 每条新增 / 改动 spec 本机真跑过；testid 逐个回 grep 过
- [ ] **AC-7** `bun run gate:local` 全绿；hosted CI 按 exact SHA 全绿
- [ ] **AC-8** `e2e/CAPABILITY_COVERAGE.md` 改写为导读，删除被本次审计证伪的宣称，指向三份机器账本

**两向对账**（RFC-317 收口时自查出的定式，写在这里免得重蹈）：收口前拿**编号**做一次
双向核对——①`proposal.md` 的每条 AC 都能在本文件找到承载它的任务；②本文件的每个任务都能
回指一条 AC 或一条 `findings.md` 条目。RFC-317 正是在这一步发现「52 条 P1/P2 逐条修复」
与「C1–C9 各有拒绝分支覆盖」两条 AC 在「看起来做完了」的状态下静默不成立。

## 7. 变更记录

| 日期 | 内容 |
| --- | --- |
| 2026-08-24 | 落档。审计基线 `92478e636`。原拟编号 RFC-318，与并发 session 的「数字员工工具最小合同」撞号，改为 RFC-319 |
| 2026-08-24 | **B20（蒸馏分区权限门）**：新建 `e2e/memory-distill-gating.spec.ts`，两条 P1（MEM-24 / MEM-31）。蒸馏任务面暴露的是**未经人审的模型产出**与它们的失败诊断（stderr 摘录 / 源事件 / 模型会话），由 `memory-distill-jobs:manage` 单点把守。三个面一起锁，少一个就留一条真实口子：①导航里不出现那一格（否则点进去只撞 403 墙）；②`?tab=distill-jobs` 深链回落到默认分区**并说明原因**（深链会留在书签 / 聊天记录 / 旧收藏里，静默显示空白最坏——用户会以为功能坏了去提一个查不出问题的工单）；③整个过程**一个蒸馏请求都不发**（否则服务端日志被必然失败的 403 刷屏，真问题被淹没）。manager 那条正向对照不能省：没有它，「看不见」可能只是「这个分区根本没渲染」。变异（`routes/memory.tsx:83` 的权限查询恒真）咬中。同批**按机制清理了上一笔的一次性 `allowGrowth`**：账本从 612 回落到 610，署名随即过期（RFC-317 T17 的设计就是让它挂不长）。能力 gap 612 → **610**，covered 67 → **69** |
| 2026-08-24 | **REPO-35 覆盖撤回（CI 归因产物）**：`529937e32`（含本轮 B18 的 superseding commit）上 CI 报 `route-not-found: /api/account/code-host-push-credentials/gitlab`，而本机全绿。根因不是判据、也不是平台差异——那条路由所在的 `routes/accountRepositoryTransportCredentials.ts` 是并发 session RFC-321 **尚未上库的未追踪文件**；我的 e2e 二进制从共享工作树构建（含它），CI 从 `main` 构建（不含它）。这是 `docs/dev-gotchas.md:189`「`git ls-files` 型守卫对未追踪文件是盲的」的**镜像形态**：那条讲的是自己的新文件没进 index 导致本地绿 CI 红；这次是**给别人尚未提交的生产代码写了测试**，同样是本地绿 CI 红。按多人协作纪律不代提他人文件，故把 REPO-35 退回 `gap`（`gapSince: RFC-319`），等 RFC-321 落库后由它带上覆盖。账本因此**上涨一条**（611 → 612），按 RFC-317 T17 的定式在 `ledger-baselines.json` 写了一次性署名 `allowGrowth` 并写明原委；下一笔不涨的提交会把它判为过期并强制清理。同批留下的教训：**给一条端点写 e2e 前先 `git ls-files <实现文件>` 确认它在库里**——共享工作树上「能跑通」不等于「已存在」。covered 68 → **67** |
| 2026-08-24 | **B19（会话中途失效）**：新建 `e2e/session-invalidation.spec.ts`，一条 P1（UX-08），两个用例分别锁**必须踢**与**必须不踢**：①凭据本身死了（账号被停用）⇒ 清 token + 回登录（留着它就是 30 秒一次的静默重连循环：页面看着还在、数据永不更新，用户完全不知道自己掉线了）；②凭据仍有效、只是某条通道的门禁不再放行 ⇒ **不许**把人踢去登录（他还能用系统其余部分）。两条必须同时成立才算这个能力做对——只写「会掉线」的话，把 4403 也当 4401 处理同样能通过，而那正是 RFC-312 修掉的那个 bug。**第二条第一版是教科书式的空洞绿，当场作废重写**：原本用 presence 通道构造，可 `ws/registry.ts` 里只有 **task 频道**声明 `rerunUpgradeGate: true`，presence 根本不重跑门禁——用例什么也没观察到，变异下仍绿。改用「把人从任务成员里摘掉」这条真实触发路径（服务端对已连着的 `/ws/tasks/:id` 重跑门禁并以 4403 关闭），变异（把 4403 分支换成 `clearToken()`）即刻咬中。**另附一条操作教训**：还原被变异的源码之后**必须重新 `build:binary:e2e`**——我漏了这一步，于是拿着仍含变异的二进制去跑重写后的用例，红了整整一轮才用 `localStorage.removeItem` 打桩抓到调用栈才认出来。判据没错，跑的东西不对。能力 gap 612 → **611**，covered 67 → **68** |
| 2026-08-24 | **B18（定时任务到点自触发）**：新建 `e2e/scheduled-task-firing.spec.ts`，一条 P1（EVENT-42），覆盖整条链：轮询选中 → CAS 认领并把 `next_run_at` 推到下一槽 → 启动任务 → 回写展示字段。判据挂在 `lastTaskId` 上（那是「真的启动了一个任务」的唯一凭据；只看 `lastStatus` 会把「认领了但启动失败」也算成功），并单独断言**槽位确实前移**——不前移的话同一行会被每个 tick 反复认领，变成每 30 秒开一次任务的无限循环，而 CAS 认领存在的理由正是这个。变异（认领时不推进槽位）咬中。**这条是本 RFC 第一条打 `@nightly` 的用例，理由记在明处**：它按风险是 P1，但实测墙钟 1.5 分钟，且慢在**判据本身**——「到点自己跑」的观察窗口由真实 tick 周期（`SCHEDULE_TICK_MS = 30_000`）与 interval 规格下限（1 分钟）决定，没有任何测试技巧能缩短，除非给 tick 加旋钮，而本 RFC 是零生产改动。放进 PR 腿等于给每次提交加 90 秒，却换不来更早的反馈（这条链一天内不会被改多次）。分档设计存在的理由正是这种「高风险但慢」的用例；`rfc319-ci-topology` 守卫已复核 PR 腿排除 / 夜跑选中两侧都对。能力 gap 613 → **612**，covered 66 → **67** |
| 2026-08-24 | **B17（MCP 撤权与会话终止）**：新建 `e2e/mcp-acl-session-termination.spec.ts`，一条 P1（RES-28）。runtime-test 会话是一个**活着的模型进程**，握着这个 MCP 的完整配置（命令行 / 环境变量 / 远端地址）；把 MCP 从某人眼前收回去却不掐掉他已开的会话，那么「撤销访问」撤的只是**列表里的一行**——撤权的人不会看到异常，被撤权的人也不会。用例：公开 MCP → 普通用户开会话（断言它确实 active，否则「被终止」证明不了任何东西）→ 收回私有 → 从**管理档**读回会话（被撤权者此时连 MCP 都 404，拿他的令牌读只会验到另一件事）→ 断言 `status !== 'active'` **且** `endReason === 'access-revoked'`（只断终止不断原因，事后审计说不清它为什么断）。两处实测契约：建会话的回执只有 `{sessionId, acceptedTurnId}`，状态要另读一次；远端地址指向必然连不上的本地端口不影响会话行的建立——这条用例关心的是生命周期，不是连通性。变异（`transitionMcpAclRuntimeTestsInTx` 的 `endNow` 短路）咬中。能力 gap 614 → **613**，covered 65 → **66** |
| 2026-08-24 | **B16（Webhook 触发规则）**：新建 `e2e/webhook-trigger-matching.spec.ts`，两条 P1（EVENT-18 / EVENT-19）。EVENT-18 用一条规则打满五维：仓库范围（exact 名单外）/ 事件类型（同仓同分支、只把 `status` 换成 success ⇒ `pipeline_succeeded`）/ 分支 glob / 评论命令前缀（note 事件，目标分支设为 main 让它只可能栽在前缀这一维）/ 忽略作者（push 事件）。**第一版把「忽略作者」挂在 pipeline 上，红了，而那条红是对的**：`matchTrigger`（`services/webhook/matching.ts:75`）只对 `AUTHOR_FILTERED_EVENT_TYPES`（push / tag_push / mr_* / note）做作者过滤，**pipeline 类刻意不过滤**——bot 推分支引发的流水线失败必须还能触发「修到绿」，作者身份改为参与熔断重置。这条不对称因此被单独锁成一条正向断言：ignore 名单里的作者发 pipeline 事件**仍然**开工。忘掉它的人会顺手把名单加进 pipeline 分支，而症状是「自动修复再也不启动」。事件类型那一维刻意选 `pipeline_succeeded` 而不是 `tag_push`：后者会先栽在分支过滤上，那样这一条验的就不是事件类型了。EVENT-19 让作者恒在忽略名单里（`evaluateCircuit` 因此不会按「人已介入」清零），连投四次同流事件 ⇒ 出现 `skipped-circuit-open`，同时断言上限之内的那几次确实放行了（否则「熔断生效」可能只是「规则根本没命中」）；再按 streamKey 人工重置，下一条同流事件重新开工——没有这一步，熔断就是个单向门。两处实测契约：`launchPayload.scratch` 与 `autoRegisterRepos` 互斥（`scratch-auto-register-conflict`，事件仓库没注册进平台就没得注册）；无 MR 的事件流键是 `${repoPath}|branch:${branch}`。两个变异（分支过滤失效 / 熔断永不 open）各自咬中对应用例。能力 gap 616 → **614**，covered 63 → **65** |
| 2026-08-24 | **B15（任务启动门与终态删除）**：新建 `e2e/task-lifecycle-gates.spec.ts`，两条 P1（TASK-46 / TASK-28）。TASK-46 三段：不可见工作流与不存在**同形 404**（这条漏掉的症状是**没有症状**——泄漏形式是「任务启动成功」）、公开之后同一个人就能启动（正向对照，排除「他压根启动不了任何东西」）、guest 缺 `tasks:execute` 时是 **403** 而非 404（此时工作流已公开、藏无可藏，能力缺失才是真原因）。TASK-28 四段：非终态拒绝、缺回显 422、回显错 422、回显对才真删且再读 404。**非终态那段用了一个确定性停住的任务**：input → agent → review → output，停在 `awaiting_review` 等人拍板，不依赖任何时序窗口。构造它撞了一条契约——评审节点的 `inputSource` 必须来自 agent 节点的 markdown 产物（直接接 input 被静态校验拒为 `review-input-source-not-markdown`），所以中间那个 agent 是必需的。**变异实证再次照出双层实现**：终态门有两处——`taskDelete.ts:93` 的廉价前置检查与 :174 事务锁内的权威复查；只短路前置那道用例仍绿，两道一起短路才转红。已写进用例注释。能力 gap 618 → **616**，covered 61 → **63** |
| 2026-08-24 | **B14（融合的可见性与决定权）**：新建 `e2e/fusion-access.spec.ts`，两条 P1（INTENT-58 / INTENT-X3）。一次融合会**改写托管技能的正文并递增版本**，而技能正文是往后每次任务都要读的东西——所以「谁看得见」「谁能拍板」是真实边界。INTENT-58 三个读面各锁一次：列表按 owner 过滤、详情与不存在同形（沿用 B13 的 `normalizeRefusal`）、**待审徽标计数**不含他人（这个面最易漏——它只是个数字，错了没有任何症状，只是导航栏上多一个点）。INTENT-X3 三条写路径全拒，且逐条断言拒绝码确实是 `fusion-forbidden` 而不是别的原因，最后回读确认融合没被推进。用例只需要融合**行存在**，不必跑完，隔离面在 `running` 阶段就已成立。**陌生人的角色选择卡了三轮，值得写下来**：`manager` 自带 `resource-acl:bypass`，拿他做陌生人隔离断言恒真；改用显式 `additionalPermissions` 又连撞两次 `user-permission-redundant`——最后核对源码发现 `USER_BASELINE` 是由 `USER_RESOURCE_READS/WRITES` + `USER_EXECUTE` **spread** 组成的，纯 `user` 早就有 `skills:read/update`、`tasks:execute`、`memory:update`，且没有 bypass，本身就是这里要的形状。同一次核对**推翻了 B9 留下的一条注记**：那里写「`user` 角色没有 `agents:create`」——错的，它在 `USER_RESOURCE_WRITES` 里。IAM-32 用例的注释与本表 B9 条目已一并更正为：那半边没断言是因为本用例的原所有者是管理档、自带 bypass 而 bypass 按设计绕开归属，不是因为构造不出普通用户所有者。能力 gap 620 → **618**，covered 59 → **61** |
| 2026-08-24 | **B13（人机门的访问边界）**：新建 `e2e/human-gate-access.spec.ts`，两条 P1（HUMAN-09 / HUMAN-32）。编排沿用 `clarify.spec.ts` 的 stub designer（第一轮抛问题 → 任务停在 awaiting_human），因此门是**真的**——`beforeAll` 里显式断言「任务确实停在反问门上」，否则后面所有隔离断言都会因为「本来就没有东西」而平凡通过。两条各锁三层：读面详情与不存在同形、待办列表不含别人任务的门、写面（作答 / 拍板）拒绝；HUMAN-09 另回读确认门既没被推进也没被污染。**存在性判据被实测收紧了一次**：第一版直接逐字节比较两次拒绝正文，红了——正文里回显了**调用方自己送进去的 id**（`no clarify_round for intermediary node_run <id>`）。那不是泄露（他本来就知道自己问的是谁），所以加了 `normalizeRefusal`：先把各自的 id 归一成同一个占位符再比。这样判据既不误报，也仍然咬得住任何**结构性**差异——两个变异（反问 / 评审各自的 `canViewTask` 短路）分别把对应用例打红，而它们改变的正是 code 与 message 的形状。能力 gap 622 → **620**，covered 57 → **59** |
| 2026-08-24 | **B12（代码平台推送凭据）**：`e2e/repo-governance.spec.ts` 追加 REPO-35。存进去的个人推送令牌**再也读不出来**——写入回执、列表回执两处都逐字节断言不含明文，回读面只有 `tokenHint`（长度恰为 4 且确为原令牌尾 4 位）。**变异实证又一次改写了这条用例的宣称**：把三条路由的 `tokenAccess: 'never'` 全改成 `'allow'`，用例仍然绿——因为 `account:self` 不是可授予的 PAT scope、令牌也不继承它，**权限门总是先触发**，通道门在 HTTP 面根本不可达（与 B4 的 `last-access-administrator-protection` 同一形状）。于是把可证的那道提为显式断言（申请 `account:self` scope 必须 422 `pat-scope-ungrantable`），把三条路由的令牌调用统一断言 **403**，并在注释与标题里写明「通道门由路由注册表单测守着，这条用例不覆盖它」。第一版还犯了个自己刚警告过的错：为绕开 ungrantable 而把 PAT 换成 `agents:update` scope，那样「令牌被拒」就退化成「它缺权限」——现在两层分别点名。另两处实测契约：个人凭据必须挂在**已配置的代码平台连接**上，`connectionGeneration` / `endpointBindingDigest` 要与该连接当前值逐字相等（否则 `code-host-push-credential-stale`）；GitLab 的 baseUrl 必须以 `/api/v4` 结尾。能力 gap 623 → **622**，covered 56 → **57** |
| 2026-08-24 | **B11（运维：本地找回与备份恢复）**：新建 `e2e/ops-local-recovery.spec.ts`，三条 P1（OPS-022 / OPS-020 / CFG-31）。OPS-022 走**真实事故形态**：建一个指向不可解析主机的 enabled 身份源（即「身份源存在但不可用」），据此关掉密码登录并确认登录端点真的 403，停 daemon，用**编译后的二进制**对着**同一个 home** 跑 `auth password-login status|enable`，再重启验证能登进去。用进程内函数调一下只能证明函数存在，证明不了发行的二进制里有这个子命令。顺带锁两条：输出里的 `daemon token remains retired`（本地通道只开门、不发新的最高权限凭据，否则它就成了权限提升通道），以及子命令拼错时给出用法提示并非 0 退出。OPS-020/CFG-31 走完整往返：备份 → 再造一条数据 → 装填 → **取消**（CFG-31 点名的可反悔窗口）→ 重新装填 → 重启 → 两个方向都断言（备份时点那条还在、备份之后那条消失、待生效标记已清）。只测「备份文件生成出来了」等于什么都没测——内容错误或装不回去的 tarball 同样能让那条断言通过。**一处坑值得记**：第一版让 harness 自己建 home，结果 `first.stop()` 因 `keepHome=false` 把整个 home（含数据库）删了，CLI 随即在原地新建空库、`status` 报 `bootstrap: required`——用例会「通过」得毫无意义。改为**由用例自己持有 home** 并两次 `startDaemon({ home })`。另一处是老坑复发：断言消息里 `await res.text()` 之后再 `res.json()` 抛 `Body is unusable`，统一改 `clone()`。两个变异（CLI enable 只读不写 / 启动时不应用待生效恢复）各自咬中对应用例。能力 gap 626 → **623**，covered 53 → **56** |
| 2026-08-24 | **B10（事件响应规则）**：新建 `e2e/event-response-rules.spec.ts`，两条 P1（EVENT-30/31）。EVENT-30 覆盖增删改回环 + 三类拒绝：`subjectMatch` 与 `subjectPattern` 的互斥约束（all 不许带、非 all 必须带）、重复删除必须 404 而非静默成功、以及**模板引用未声明参数在创建时就被拒**（`event-response-template-ref-invalid`）——最后这条是本域最安静的失效形态：放过去的话要等真事件来了才发现启动的是一份参数为空的工作，而那时没有人在看。EVENT-31 锁三档：普通用户读得到但 create/update/delete 三个动作全 403；另一个 manager 有写权限但不是 owner，拒绝形状是 **404 而非 403**（规则 id 的存在性不从错误码泄露），且回读确认规则没被动过；持 `override-owner` 的管理档能跨 owner 改——这条正向对照不能省，否则前两条可能只是「这条规则谁都改不了」。两个变异（模板校验短路 / owner 检查短路）各自咬中对应用例。实测契约：事件类型引用形如 `{id:'code-host.branch.pushed', revision:1}`，从 `/api/event-center/catalog` 的 `eventTypes[].eventTypeRef` 取。能力 gap 628 → **626**，covered 51 → **53** |
| 2026-08-24 | **B9（凭据与归属）**：新建 `e2e/identity-credentials.spec.ts`，四条 P1（IAM-12/13/27/32）。共同特征是「改完之后界面上看不出区别，只有下一个人拿旧凭据敲门时才知道有没有生效」。IAM-13/27 都把判据落在**会话是否真的死了**上（改密 / 重置的唯一目的就是把入侵者踢出去），并各自带正向对照（新密码能登、新签发的票能用）。IAM-27 的「下次必须改密」判据改挂登录回执的 `mustChangePassword`（`auth.ts:121`，前端正是据它跳转），而不是内部列名；顺带锁了 `__system__` 不接受重置（否则平台内部身份会变成可登录账号）。**IAM-12 被真实行为改写了两次，最终判据比原设想强得多**：①原打算直接关掉密码登录，实测被 409 `password-login-requires-enabled-oidc` 拦下——这正是审计条目里「最后一个 provider 保护」那半，遂把它提为第一段断言（没有退路时关掉 = 一次点击锁死整个实例），再建一个 enabled 的 fixture IdP 走完真正的关闭路径，两段互为正反对照；②`oidcDefaultRole` 只收 `guest|user`，原本的回环断言改成**上限断言**：`manager` / `admin` 必须被拒（这个字段决定陌生人从身份源首次登入时的身份，能填管理档就等于把开户即管理员写进配置）。**变异实证暴露了一处判据错位并已写进用例注释**：关掉密码登录后真正拦人的是 `auth/loginPolicy.ts:306`，不是 `routes/auth.ts:85`——摘掉路由那道用例仍绿（它是冗余的第二层），摘掉 loginPolicy 那道才转红。判据落在行为上，所以两层里任何一层还在这条能力就成立。IAM-32 的「原所有者从此不能管」本批没有断言：本用例的原所有者是管理档、自带 `resource-acl:bypass`，而 bypass 按设计绕开归属，拿它做否定断言只会锁死一个错误期望；改用继承人的**前后对照**——转让前连资源都看不见（404），转让后能改它的 ACL——并把标题与注释一并改准。能力 gap 632 → **628**，covered 47 → **51** |
| 2026-08-24 | **B8（仓库 / 仓库组治理）**：新建 `e2e/repo-governance.spec.ts`，三个用例覆盖 REPO-07/13/23/24（四条 P1）。REPO-07 与 REPO-23/24 是同一形状的两条删除挡板——「被引用 → 409 且点名引用者 → force 放行」，两条都补了**正向对照**（强制删除确实删得掉、被拒之后东西确实还在），否则「拒绝」可能只是「这个东西根本删不掉」。REPO-23 额外断言强制删除的回执如实报出连带影响：`detachedReferences ≥ 1`、`archivedMemories == 1`（组被删而挂在它上面的记忆没归档 = 孤儿 scope），并回读父组确认它不再挂着已删子组的 id。**REPO-13 的变异实证纠正了它自己的判据**：第一版注释说它锁的是失败消息脱敏（`clipAndRedact`），实测把那处脱敏摘掉用例仍绿——本机 git 对无法解析的 host 报错时并不回显 URL 里的密码段。真正咬住它的是 `rowToWire` 的两次 `redactGitUrl`（`repoBatchImport.ts:505-506`），改成原样回显立刻转红。已把注释与用例标题一并改准，并写明「失败消息那条仍只有单测守着」，免得下一个人误读这条用例的覆盖面。两处实测契约：仓库组的子组挂载键是 `childGroupId` 而非 `groupId`；任何组都必须显式含一个 `path: ''` 的根节点（缺了报 `repo-group-root-missing`）。能力 gap 636 → **632**，covered 43 → **47** |
| 2026-08-24 | **B7（记忆域）**：新建 `e2e/memory-access.spec.ts`，覆盖 MEM-34/35/36/37（四条 P1：候选未审不可见、逐行管理权、资源 scope 随可见性、repo/global 全员可读仅 bypass 可管）+ MEM-04/08/10/19/48。九条能力、八个用例，全部本机实跑 + 变异实证（四个变异各自只咬中对应用例，其余保持绿——变异归因干净）。能力 gap 645 → **636**，covered 34 → **43**。四处契约是实跑撞出来才写对的，都不在任何文档里：①`POST /api/memories` 的回执是 `{memory:{id,…}}` 而非扁平 `{id}`；②**手工建的记忆初始就是 `candidate`**，而列表对无 `resource-acl:bypass` 者整个滤掉 candidate（`routes/memories.ts:128`）——所以要让普通用户看见必须先 promote，而这条弯路本身把原本排在 P1 却没打算做的 MEM-34 变成了「不用跑蒸馏就能构造」；③`POST /:id/promote` 要带判别体 `{action:'approve'|'approve_and_supersede'|'reject'}`；④`memory:read` 与 `agents:read` 同类，是角色基线权限、不能作为 PAT scope 显式授予（`pat-scope-ungrantable`）。另有两条判据是**先写错、被真实行为纠正**的，比原判据更强：①MEM-10 原打算断言「驳回后普通用户看不到」——实测 rejected 行仍在列表读面上（`dropCandidates` 只挡 candidate）。查过注入侧 `services/memoryInject.ts:143` 只取 `status='approved'`，确认那是审计读面而非注入泄露，遂把判据改成「驳回是终态、不能再被 approve 洗回」；②MEM-19 的 token 回显门原挂在 global 记忆上，实测 PAT 会先撞管理权 403（`resource-acl:bypass` 不是可授予的 PAT scope），根本走不到确认门——那样用例什么也证明不了，改挂到同 owner 的 agent scope 上，并补了「回显正确时确实删得掉」这条正向对照，免得三条拒绝退化成「token 压根删不掉任何东西」 |
| 2026-08-24 | **B4 第二批**：再补 IAM-30（用户访问变更的硬不变量）与 IAM-21/47（令牌只能管自己、且永远够不到归属/授权写面）。能力 gap 660 → **657**，covered 19 → **22**。两条实测结论值得记：①`last-access-administrator-protection` **从 HTTP 面不可达**——任何能 PATCH 用户的 actor 自己就是访问管理员（计数 ≥ 1），而唯一被排除在计数外的 `__system__` 那条路要走 bootstrap 档，那一档在交接完成前对所有业务端点回 `bootstrap-admin-required`（实测 403）。它是 `userAccessPolicy.ts:118-125` 的纵深防御，由那层单测守着；用例里写清了这段，免得下一个人再撞一遍。构造过程中反而照出一条此前同样没有端到端断言的真护栏 `self-disable-forbidden`，一并锁上。②IAM-47 用「**同一个人、同一个资源**，会话能改 ACL、令牌永远不能」作对照，把拒绝精确归因到通道本身而不是权限/可见性/所有权——第一版把资源建在 daemon 名下，PAT 拥有者根本看不见它（404 与不存在同形），「令牌写不了」会因为看不见而成立、证明不了任何针对性。另有三处契约是实跑撞出来的：PAT 的 `purpose` 只接受 `general`/`mcp_only`；`agents:read` 是角色基线权限、不能作为 PAT scope 显式授予；账号面 `/api/auth/me` 对 PAT 也是 `tokenAccess: never`（存活探针因此改用「在自己资源上做一次普通写」）。**端点/路由账本本批未同步**：并发 session 的 `services/gitCredential.ts` 重构中途，`createApp` 起不来（`leasePushCredential` 导出缺失），`allRouteMeta()` 取不到分母。能力账本不依赖它，已同步。端点/路由账本待树能构建时补——期间 nightly 若跑，其「上游没全绿就拒绝对账」的判据会吸收这段不一致 |
| 2026-08-24 | **B4 第一批（身份与访问）**：新建 `e2e/identity-access.spec.ts`，补 IAM-01/03（首次安装的管理员交接：`/setup/admin` 此前是**零自动化**的首屏）、IAM-05/06（密码登录回到原目标页 + 三类拒绝）、IAM-26（停用用户后**已发出的会话**立刻失效）、IAM-43（退出登录：服务端吊销 + 客户端凭据清空 + 回 /auth）。IAM-38 已被上一批的 TASK-32 覆盖，一并销账。四条全部本机实跑 + 变异实证。两处判据是实跑撞出来后改对的：①交接完成后**不能**再查 `/api/auth/bootstrap/status`——它要求 daemon 源身份（`auth.ts:137`），而交接恰恰退役了那张一次性票，所以改成直接断言「那张票不能用了」，判据更强；②登录的三类拒绝里，「不存在的用户」与「错密码」必须**同形**，否则登录页可被用来枚举账号。账本：能力 gap 668 → **660**（8 条晋升为可校验 covered），端点 266 → **264**，路由 18 → **17**（`/setup/admin` 首次被真实加载）。**采集踩了一个坑并已沉淀进 `docs/dev-gotchas.md`**：journal 原本写在 `test-results/` 下，而那个目录归 Playwright 所有、每次 run 开始清空——共享工作树上别人跑一次 e2e 就把它端走了，重播脚本读到 0 份、把账本写成「全都没覆盖」。已把 journal 路径移出 `test-results/`（含 nightly workflow），并确立第三条纪律：**账本重播只能用全绿的那次跑**；这轮全量因并发 session 的在制改动红了 2 条 RFC-310 spec，于是改用「只按正向证据删除、绝不新增」的口径入账 |
| 2026-08-24 | **R3 能力账本落地（T26/T27）+ AC-8**：`architecture/e2e-capability-ledger.json` 播种 820 行。设计上比落档时多了一档状态，理由是**不能把散文原样搬进 JSON**：`gap`（668，只减不增）/ `covered-unverified`（141，审计判定有防护但证据仍是散文 `path:line`，只减不增，**存量专用**——新增行只能是 covered 或 gap，否则它就成了「宣称覆盖但不必证明」的永久后门）/ `covered`（11，证据是 `{file, test}` 且守卫每次验证标题逐字存在）。这样「把散文变成判据」这件事本身也有了一个会下降的数字。两个债务数字通过显式 `gapIds` / `unverifiedIds` 数组接入 RFC-317 的高水位机制（它按数组长度清点，派生计数它数不到），并由守卫钉死两个数组与 rows 派生集合逐条相等，避免冗余漂移。守卫六条负 fixture + 三条变异实证（改 test 标题 → 红；偷偷把 gap 改成 covered-unverified → 红；gapIds 与 rows 脱钩 → 红）。AC-8 同批完成：`e2e/CAPABILITY_COVERAGE.md` 头部加上「这是导读、不是判据」并点名本次抓到的三种失效形态，权威判据指向三份机器账本 |
| 2026-08-24 | **B3 第二批**：T33 / T34 / T36 / T37 完成（T35 泳道拖拽留待下一批——它要走数字员工编排的发布链路，深度另算）。账本再收敛：端点 268 → **266**（新覆盖 `GET /api/scheduled-tasks/:id`、`PUT /api/tasks/:id/members`）。**T33 的根因值得单记**：`rfc232-owner-list.spec.ts` 之所以「全程 admin」，是因为 peer 的会话令牌在 seed 里用完就丢了，浏览器侧根本没有非 admin 凭据可用——把它挂进 `OwnerFixtures` 之后那条边界才写得出来。**T34 撞出一条通用坑（已可复现）**：这条用例单跑绿、全量跑红。两个叠加原因——①`TaskMembersPanel` 的 UserPicker `onChange` 里有 `if (!sessionIsCurrent()) return`，会话未落定时**静默丢弃**用户的选择，症状是「选了但保存按钮一直灰着」；②portal 出来的结果列表**会盖住 Save 按钮**，而列表长度取决于库里累积了多少用户，所以隔离跑时列表短、不覆盖。判据加了两条：用 `members-transfer-owner`（仅 canManage 时渲染）当就绪信号，并断言选择真的落进了 chip；Save 前用 `Escape` 关列表（UserPicker 对 Dialog 内首个 Escape 做过 stopPropagation，正是为此）。**T37 的第一版把邻居弄红了**：插在相机场景中段时，后面 `wrapper.click` 的 `toHaveClass(/selected/)` 变红——那条红与本能力无关，纯粹是我扰动了它的前置相机/选中状态。改放函数末尾；390 窄屏那条腿点不开相机面板，按 `profile` 收窄到 desktop 并写明理由 |
| 2026-08-24 | **B3 第一批 + 代理域 P1**：空洞绿 T30 / T31 / T32 修复完毕，代理域四条 P1（AGENT-01 表单创建落库、AGENT-04/23 富字段保存零丢失、AGENT-07 过期保存被拦、AGENT-35 真实完整性告警）落成新 spec `e2e/agent-authoring.spec.ts`，全部本机实跑通过并逐条变异实证。两处与审计建议不同：①AGENT-31 的修法改为**存在性不可区分**（把「真实但不可见的 id」与「不存在的 id」两次访问的可见文本逐字比较），比「断言进不去」更难写成恒真；②WF-49 的版本 CAS 无法通过 UI 造出来——编辑器通过 WS 立刻同步了外部保存，`expectedVersion` 不会过期（产品做对了），改在合同层断言过期删除被拒 409 且资源仍在。T32 同时纠正了审计没点出的一层：那条唯一的浏览器断言不但被 `RUN_VISUAL_REGRESSION` 关着，而且用 `page.route` 把 `/resource-status` 响应整个换掉，后端完整性计算一行都没跑过；新用例走真实路径（停用被引用的插件）。账本随之收敛：端点 271 → **268**（新覆盖 `DELETE /api/workflows/:id`、`GET`/`PUT /api/plugins/:id`——第一条正是 T31 那条空洞绿此前假装测过的东西），路由 18 不变。`PATCH /api/auth/me/profile` 出现在未覆盖集里但**未写入账本**：它是并发 session RFC-320 尚未入库的新端点，那是他们的债，等它落库后由棘轮向他们提出 |
| 2026-08-24 | **B1 落地**：T10/T11/T12/T14/T15 完成，T13 推迟到第一条 nightly 档后端用例落地时一起做（现在建空目录 + 排除清单，只会得到一条无人验证的配置）。分档用 Playwright 原生 tag：不带 tag = PR 档（今天 340 条一条不动），`@nightly` = 夜跑档。新增 `.github/workflows/e2e-full-nightly.yml`（06:00 UTC，4 分片，**不加任何 grep 过滤**，设 `AW_E2E_ROUTE_JOURNAL`，四分片 journal 汇总后跑两条账本守卫；上游没全绿或分片数不足时**拒绝对账**而不是拿残缺语料比账本）。`rfc319-ci-topology.test.ts` 钉死三处静默失效面，三条变异全部实证转红。`gate:local` 加 `AW_GATE_E2E=1` 可选 Playwright 车道（默认关——门禁慢到让人跳过就等于失效） |
| 2026-08-24 | **B2 第一批落地**：T20/T21/T22/T23/T24/T28 完成，T29 对本批四条守卫做过变异实证。三处与落档设计不同，均已回写 `design.md`：①R1 采集挂在 `AW_E2E_ROUTE_JOURNAL` 开关下（落档时列为退化方案，实做直接采纳——PR 腿行为与今天逐字节相同）；②R2 的分子改用**同一份 journal 里的 SPA 文档请求**，不再需要 T25 的 fixture 迁移作为前提（T25 从必需项降级为增强项）；③R2 的「源码提过」从通过判据降级为纯诊断——实测发现它会把 `/code/*` 十条路由整族漂绿（那些出现全在默认不跑的视觉套件里）。实测值：端点 462 声明 / 191 命中 / **271 从未**；路由 60 / 42 / **18 从未**（其中 14 条「提过却从未加载」）；归一器反方向零失配 |
