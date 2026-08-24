# RFC-319：用户面 system-mock e2e 覆盖加固

- 状态：Draft（2026-08-24 落档，等待用户确认后进入实现）
- 性质：**质量加固批**。零产品行为变更、零生产代码功能改动；交付物是**测试与机器判据**，外加 8 条既有坏用例的修复
- 审计基线：`92478e636`（采数时 `main`）。**落档时工作树上有并发 session 的大批未提改动**（RFC-318 数字员工工具合同、`modules/digital-employee`、`system-mocks/code-host` 等），本文的 820 / 679 / 86 等计数按该 SHA 采集；开工时若 `main` 已前进，`plan.md §0` 要求在新的干净 SHA 上重采一次分母
- 直接输入：
  - 本目录 `findings.md` —— 2026-08-24 的 **15 领域审计 agent + 15 对抗性复核 agent** 产出，820 条用户面能力逐条对账，含 `path:line` 证据
  - 本目录 `findings.json` —— 上文的机器索引
  - `e2e/CAPABILITY_COVERAGE.md`（既有的**散文**覆盖账本，本 RFC 将其降级为导读、判据移交机器账本）
  - `docs/dev-gotchas.md` §「新写的 e2e spec 不跑一次就等于没写」/ §「`gate:local` 不跑 system mock 用例」/ §「删端点时 `e2e/` 不在任何本地门禁的覆盖面内」
  - `design/RFC-317-commons-boundary-hardening/`（棘轮方法论：判据的一端必须是活的源码、守卫必须自证会红、账本只减不增）

## 1. 背景：安全网有洞，而且没人知道洞在哪

本仓的 e2e 基建是好的——`e2e/global-setup.ts` 在全套 Playwright 之前起一个进程级
`startSystemMockSuite()`，各 spec 用 `harness.ts` 起**编译后的 daemon 二进制**，真 HTTP API +
内嵌前端 + 真 SQLite + 真 git worktree + 真子进程，外部世界（runtime CLI / git smart-HTTP /
GitLab·GitHub / OAuth·OIDC / MCP / npm·PyPI / PlantUML / SCIP）全部是确定性替身。
**问题不在基建，在覆盖面与判据。**

一轮 30-agent 的双向审计（15 个领域各一名审计员 + 一名对抗性复核员，复核员既要找能推翻
「缺口」的既有覆盖，也要打开被宣称「已覆盖」的用例读它真正断言了什么）逐条对账出：

| 事实 | 数字 | 证据锚点 |
| --- | --- | --- |
| 审计到的用户面能力 | **820** | `findings.md §5` 全量台账 |
| 判定为缺口（`gapKind != covered`） | **679** | 其中 P1 **86** / P2 **383** / P3 **210** |
| 真正被 e2e 守住的 | **141** | 复核后仍判 `covered` 的条目 |
| **零自动化**（`coverage=none` 且 `no-test-at-all`） | **44** | `findings.md §3`，含 `/setup/admin` 首屏、`agent-workflow auth password-login`、退出登录 |
| **空洞绿**（既有用例断言恒真或答非所问） | **8** | `findings.md §2`，逐条带复核依据 |
| 后端 system-mock e2e 的文件数 | **6**，且**全部是 RFC-310 一个域** | `grep -rl startSystemMockSuite packages/backend/tests/` |
| 浏览器 e2e | 62 spec / 340 用例，其中 **48 条是视觉快照** | `e2e/*.spec.ts` |
| 前端路由从未被任何 e2e 直达 | **18 / 58** | 按 `router.tsx` 路由树逐条比对 `goto`；其中 12 条在整个 `e2e/` 里连字符串都不出现 |
| 后端端点声明 | **462**（`allRouteMeta()`） | 现成的机器分母，但**没有任何东西**把它和 e2e 证据对起来 |
| 架构守卫文件 | 25 个（`packages/backend/tests/architecture/`） | **没有一个**要求「新增用户面能力必须带 e2e 证据」 |

### 1.1 三种失败形态，按危害排序

**① 空洞绿——有一张假安全网。** 这比没有更坏，因为它让人以为这条路已经守住，于是没有人再去补。
逐条实证（全部经复核员打开源码核对）：

- `e2e/rfc099-ownership-acl.spec.ts:188` 断言「陌生人直链进不去」用的是 `acl-panel` 计数为 0，
  而 `acl-panel` 只在 More→Permissions 弹窗里渲染、carol 从未点开过它——**即便 carol 拥有全部权限，
  这条断言照样为 0**。同一用例里「列表过滤」那一半（`:186`）是真覆盖，两半判若两人。
- `e2e/workflow-editor.spec.ts` 的「删除工作流」用例只是打开确认框、跑 axe、点 Cancel。
  全仓 e2e **没有任何一处**对 `/api/workflows` 发过 DELETE。
- `e2e/rfc250-visual-states.spec.ts:530` 起整个 describe 被 `test.skip(!RUN_VISUAL_REGRESSION)` 关着——
  默认 `bun run e2e` 与 **PR CI 的 Playwright 腿根本不跑它**，它只在 path-filtered 的
  visual-regression-nightly（触发路径限 `packages/frontend/**`）里跑。代理「引用资源失效告警」
  这条唯一的浏览器断言就住在里面。
- `e2e/rfc232-owner-list.spec.ts` 被当作定时任务可见性的覆盖，但 peer 用户只用来**播种一行数据**，
  浏览器**全程以 admin 身份**跑，没有任何一处以非 admin 身份验证过可见性边界。

**② 覆盖只到 happy path，拒绝分支裸奔。** CLAUDE.md 明文写着「每条禁用 / 拒绝分支必须有测试覆盖」
（RFC-224 事故沉淀），但审计实测：`event-center` 的 `scripts:author` ForbiddenError 有 **5 处**
（`eventCenter.ts:313/338/357/379/399`），全仓 grep `scripts-author-required` **零命中**。
同形的还有「被 agent 引用时拒绝删除 MCP / 插件 / 技能」、「PAT 读取时机密脱敏」、
「轮换 secret 后旧签名立即失效」——全部只有内存 DB 单测，没有一条走过编译后的 daemon。

**③ 判据本身会漂移。** `e2e/CAPABILITY_COVERAGE.md` 是一份写得很好的**散文**账本，
但它的每一句宣称都需要人回到用例源码才能验证真伪——本次审计就推翻了其中若干条。
这与 RFC-317 起因的第四条判据（**存在防止再长出来的棘轮**）是同一形态：
归一 / 覆盖做了，防复发没做。今天任何人新加一个页面、一个端点、一条破坏性按钮，
**整套门禁全绿**，因为没有任何机器判据在问「它有 e2e 吗」。

### 1.2 为什么本地门禁照不到这一切

`gate:local` **不跑 Playwright**，`e2e/` 也**不在任何 package 的 tsconfig `include` 里**
（backend 是 `src|tests|db`，frontend 是 `src|tests|vite`）。`docs/dev-gotchas.md:902` 记录了这条
一年多、仍复发三次：删端点 / 改执行策略默认值都能本地全绿而 CI 的 Playwright 腿红。
RFC-310 PR-10 后补的 `api-contract-coverage.test.ts` 守卫只解决了「e2e 打了已删端点」这一个方向，
**反方向（端点没有任何 e2e 打过）至今无人看守**。

## 2. 目标

- **G1 全量补齐。** 679 条缺口全部落成可执行用例，不做取舍。按风险分流到两条腿（见 G4），
  不是「挑一部分做」。
- **G2 修掉 8 条空洞绿，每条配变异检验。** 修完必须把真实事故形态注入回去、确认断言会红——
  `docs/dev-gotchas.md` 已有定式「红→绿对里的绿不是终点」。
- **G3 立四层棘轮，让「新增用户面能力没有 e2e」这件事会红。** 四层各自的分母都必须派生自
  **活的源码**（路由注册表 / 路由树 / 测试标题），不得是人手维护的清单：
  - **R1 运行期端点命中账本**——跑完整套 e2e 后，把实际被打到的端点集合与 `allRouteMeta()` 的
    462 条声明对账，「从未被任何 e2e 打到的端点」变成只减不增的账本。
  - **R2 前端路由 × e2e 账本**——从 `router.tsx` 路由树派生 58 条路由，每条必须至少有一个 spec
    真实导航并做过功能断言（不是只截图、不是只跑 axe）。
  - **R3 能力账本**——820 条能力落成机器账本，每条指向具名测试证据（文件 + test 标题），
    并由守卫验证被引用的标题**今天确实存在**。终结散文账本的漂移。
  - **R4 守卫自证**——本轮新立的每一条守卫都必须配一个会让它变红的变异样本，并断言语料非空。
- **G4 按风险分流 CI，PR 反馈时间不退化。** P1（86 条）进 PR CI 的 Playwright 腿；
  P2 + P3（593 条）进 nightly。分片数按用例总数上调，保证单片墙钟不涨。
- **G5 补测按层次落位，不无脑堆浏览器用例。** 能在后端 system-mock 层表达的语义
  （权限拒绝分支、409 冲突、验签失败、级联删除、CAS）落后端；UI 只补最小的
  **接线断言**——点了按钮真的发出了那个请求、回执真的呈现了。
- **G6 把 e2e 拉进本地可见面。** 给 `gate:local` 加一条**可选**的 Playwright 车道
  （默认关、显式开），并把 R1/R2/R3 三条账本守卫放进**默认**车道——它们是纯静态 / 纯账本比对，
  不需要起浏览器。

## 3. 非目标

- **不改产品行为、不改生产代码功能。** 唯一允许触碰生产代码的情形是：补测过程中发现真缺陷
  （审计已预判若干条，例如 `retireTool` 对「工具正被已发布岗位模板绑定」零校验），
  那按 bug 修复处理、单独 commit、带红→绿回归，并在 `plan.md` 里逐条登记。
- **不重构既有 spec 的组织结构。** 不做 spec 大搬家；新用例优先并入语义最近的既有 spec，
  确需新建才新建。
- **不追求端点命中率 100%。** R1 账本的初值就是今天的实测缺口集合，只要求**只减不增**，
  不要求本轮清零（清零由 G1 的 679 条推动，两者会自然收敛但不互为前提）。
- **不动 `visual-regression.spec.ts` 的快照策略。** 视觉基线自成一套（含 Linux 基线刷新流程），
  本 RFC 只把它「被 skip 关掉」这个事实登记清楚并修 `rfc250-visual-states` 那条错位的门。
- **不引入新的测试框架 / 断言库。** 用现有 Playwright + `bun:test` + `@agent-workflow/system-mocks`。

## 4. 用户故事

- **作为维护者**，我改了 `agentToPutBody` 的字段拷贝，忘了带上 `branchPorts`——
  PR CI 的 Playwright 腿立刻红在「富字段保存不丢」那条用例上，而不是三个月后用户报「我的配置没了」。
  （今天：整套 e2e 里唯一被证明能「UI 改字段 → PUT → SQLite → reload 读回」的代理字段只有 Runtime，
  而那个 fixture agent 是空壳，漏拷任何字段一格都不会红——`agents.detail.tsx:315-353` 排着四条
  「round-trip fix」注释，说明这件事已真实发生过至少四次。）
- **作为维护者**，我新加了一个 `/code/reports` 页面但没写 e2e——R2 账本守卫在 `gate:local` 就红，
  提示我要么补一条 spec、要么显式把它记进账本并说明理由（而账本只能减不能增）。
- **作为维护者**，我删了一个端点——今天已有守卫拦「e2e 还在打它」；本轮之后 R1 还会告诉我
  「这个端点从来没有任何 e2e 打过」，于是我知道删它没有回归风险，或者知道我该先补一条。
- **作为安全负责人**，我要确认「未授权用户完全不可见」这条 ACL 承诺是真的——
  R3 能力账本里 IAM 域每一条可见性边界都指向一条具名用例，而不是一句散文。

## 5. 影响清单（本 RFC 不收缩任何能力，但有两项成本变化，需逐项确认）

| 编号 | 影响 | 现状 | 变更后 | 需确认 |
| --- | --- | --- | --- | --- |
| I1 | **PR CI 墙钟** | Playwright 腿 7 个 job（ubuntu 2 片 / macOS 2 片 / windows 3 片），单片 20 分钟超时 | P1 的 86 条用例进入 PR 腿，分片数按实测上调（预计 ubuntu/macOS 各 4 片、windows 4~5 片），**单片墙钟维持在今天的水平**，CI 总机时上涨 | ✔ 用户已确认「根据用例数调整分片」 |
| I2 | **nightly 规模** | 三条 nightly（webkit / visual-regression / evidence-soak），后两条 path-filtered | 新增一条 `e2e-full-nightly`，跑 P2+P3 的 593 条；红了没有 PR 会被拦，需人主动看 | ⚠️ **请确认**：nightly 红的响应机制（本仓 visual-regression-nightly 已有先例） |
| I3 | 本地门禁时长 | `gate:local` 不跑 Playwright | 默认车道**只**多三条账本守卫（静态，秒级）；Playwright 车道默认关，显式开 | ✔ 无实质变化 |
| I4 | 生产代码 | —— | 零功能改动；仅在补测发现真缺陷时逐条修，单独 commit | ✔ |

## 6. 验收标准

- **AC-1** `findings.json` 的 679 条缺口逐条有对应用例，且每条在能力账本（R3）里指向具名测试证据；
  账本守卫验证被引用的 test 标题今天存在。
- **AC-2** 8 条空洞绿全部修复，且每条附一次**变异实证**记录（把事故形态注入 → 断言转红 → 撤销注入 → 转绿）。
- **AC-3** R1/R2/R3/R4 四条棘轮落地并全绿；每条自带负 fixture，能自证会红；每条断言语料非空
  （spec 目录挪走 / 后缀改名 / 路由树改写法都必须让守卫红，而不是空转成绿）。
- **AC-4** 三份机器账本（R1 端点、R2 路由、R3 能力）的条目数**只减不增**；要升必须显式
  `allowGrowth` 并点名 RFC，且在下一笔不涨的提交上被判过期、强制清理（沿用 RFC-317 的高水位形态）。
- **AC-5** PR CI 的 Playwright 腿单片墙钟不超过今天的水平；`e2e-full-nightly` 能完整跑完 593 条。
- **AC-6** 每一条新增 / 改动的 spec **在本机真跑过一次**（`bun run build:binary:e2e` + `playwright test`），
  并且其 `getByTestId` 逐个回 grep 过前端源码确认存在。`docs/dev-gotchas.md` 已有的两条定式
  （「不跑一次就等于没写」「改选择器只有真浏览器能验证」）在 `plan.md` 里作为每批的收口检查项。
- **AC-7** `bun run gate:local` 全绿；hosted CI 按**本人 exact SHA** 全绿。
- **AC-8** `e2e/CAPABILITY_COVERAGE.md` 改写为导读，明确指向三份机器账本作为唯一判据，
  并删除其中已被本次审计证伪的宣称。
