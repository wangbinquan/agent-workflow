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
| 2026-08-24 | **B3 第二批**：T33 / T34 / T36 / T37 完成（T35 泳道拖拽留待下一批——它要走数字员工编排的发布链路，深度另算）。账本再收敛：端点 268 → **266**（新覆盖 `GET /api/scheduled-tasks/:id`、`PUT /api/tasks/:id/members`）。**T33 的根因值得单记**：`rfc232-owner-list.spec.ts` 之所以「全程 admin」，是因为 peer 的会话令牌在 seed 里用完就丢了，浏览器侧根本没有非 admin 凭据可用——把它挂进 `OwnerFixtures` 之后那条边界才写得出来。**T34 撞出一条通用坑（已可复现）**：这条用例单跑绿、全量跑红。两个叠加原因——①`TaskMembersPanel` 的 UserPicker `onChange` 里有 `if (!sessionIsCurrent()) return`，会话未落定时**静默丢弃**用户的选择，症状是「选了但保存按钮一直灰着」；②portal 出来的结果列表**会盖住 Save 按钮**，而列表长度取决于库里累积了多少用户，所以隔离跑时列表短、不覆盖。判据加了两条：用 `members-transfer-owner`（仅 canManage 时渲染）当就绪信号，并断言选择真的落进了 chip；Save 前用 `Escape` 关列表（UserPicker 对 Dialog 内首个 Escape 做过 stopPropagation，正是为此）。**T37 的第一版把邻居弄红了**：插在相机场景中段时，后面 `wrapper.click` 的 `toHaveClass(/selected/)` 变红——那条红与本能力无关，纯粹是我扰动了它的前置相机/选中状态。改放函数末尾；390 窄屏那条腿点不开相机面板，按 `profile` 收窄到 desktop 并写明理由 |
| 2026-08-24 | **B3 第一批 + 代理域 P1**：空洞绿 T30 / T31 / T32 修复完毕，代理域四条 P1（AGENT-01 表单创建落库、AGENT-04/23 富字段保存零丢失、AGENT-07 过期保存被拦、AGENT-35 真实完整性告警）落成新 spec `e2e/agent-authoring.spec.ts`，全部本机实跑通过并逐条变异实证。两处与审计建议不同：①AGENT-31 的修法改为**存在性不可区分**（把「真实但不可见的 id」与「不存在的 id」两次访问的可见文本逐字比较），比「断言进不去」更难写成恒真；②WF-49 的版本 CAS 无法通过 UI 造出来——编辑器通过 WS 立刻同步了外部保存，`expectedVersion` 不会过期（产品做对了），改在合同层断言过期删除被拒 409 且资源仍在。T32 同时纠正了审计没点出的一层：那条唯一的浏览器断言不但被 `RUN_VISUAL_REGRESSION` 关着，而且用 `page.route` 把 `/resource-status` 响应整个换掉，后端完整性计算一行都没跑过；新用例走真实路径（停用被引用的插件）。账本随之收敛：端点 271 → **268**（新覆盖 `DELETE /api/workflows/:id`、`GET`/`PUT /api/plugins/:id`——第一条正是 T31 那条空洞绿此前假装测过的东西），路由 18 不变。`PATCH /api/auth/me/profile` 出现在未覆盖集里但**未写入账本**：它是并发 session RFC-320 尚未入库的新端点，那是他们的债，等它落库后由棘轮向他们提出 |
| 2026-08-24 | **B1 落地**：T10/T11/T12/T14/T15 完成，T13 推迟到第一条 nightly 档后端用例落地时一起做（现在建空目录 + 排除清单，只会得到一条无人验证的配置）。分档用 Playwright 原生 tag：不带 tag = PR 档（今天 340 条一条不动），`@nightly` = 夜跑档。新增 `.github/workflows/e2e-full-nightly.yml`（06:00 UTC，4 分片，**不加任何 grep 过滤**，设 `AW_E2E_ROUTE_JOURNAL`，四分片 journal 汇总后跑两条账本守卫；上游没全绿或分片数不足时**拒绝对账**而不是拿残缺语料比账本）。`rfc319-ci-topology.test.ts` 钉死三处静默失效面，三条变异全部实证转红。`gate:local` 加 `AW_GATE_E2E=1` 可选 Playwright 车道（默认关——门禁慢到让人跳过就等于失效） |
| 2026-08-24 | **B2 第一批落地**：T20/T21/T22/T23/T24/T28 完成，T29 对本批四条守卫做过变异实证。三处与落档设计不同，均已回写 `design.md`：①R1 采集挂在 `AW_E2E_ROUTE_JOURNAL` 开关下（落档时列为退化方案，实做直接采纳——PR 腿行为与今天逐字节相同）；②R2 的分子改用**同一份 journal 里的 SPA 文档请求**，不再需要 T25 的 fixture 迁移作为前提（T25 从必需项降级为增强项）；③R2 的「源码提过」从通过判据降级为纯诊断——实测发现它会把 `/code/*` 十条路由整族漂绿（那些出现全在默认不跑的视觉套件里）。实测值：端点 462 声明 / 191 命中 / **271 从未**；路由 60 / 42 / **18 从未**（其中 14 条「提过却从未加载」）；归一器反方向零失配 |
