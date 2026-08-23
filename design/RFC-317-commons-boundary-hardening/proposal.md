# RFC-317：公共内核架构边界加固

- 状态：In Progress（2026-08-23 用户批准 D1–D7 与能力影响清单 C1–C9，按 `plan.md` B0→B11 推进）
- 性质：**治理批 + 有限行为修复**。对齐 RFC-294 `plan.md §4 W0-R`，但**不等于完成 W0-R**（承担与不承担的边界见 `design.md §1`）
- 审计基线：`56755bc00`（采数时 `main`、clean tree）。**落档时 `main` 已前进到 `dcb1476ac`，且工作树上有并发 session 的大批未提改动**（`modules/digital-employee`、`modules/task-execution/public`、`employeeTypePackage.ts` 等，对应他们的 RFC-316）——本文的 66 / 33 / 79 / 52 等计数与部分 `DE-*` 锚点**开工时必须在新的干净 exact SHA 上重采**（`plan.md §0` 已列为前置）
- 直接输入：
  - 本目录 `findings.md` —— 2026-08-23 的 18-agent 并行审计产出，131 条经复核发现 + 95 条无人看守的违规类别
  - 本目录 `census-2026-08-23.md` —— B0/T1 在干净 SHA 上的**正式分母**；它订正了本文落档时用 `rg` 行计数估算的三个数字（口径差见该报告 §0）
  - `design/RFC-294-backend-layered-target-architecture/{proposal,design,plan}.md`
  - `design/system-commons-unification-audit-2026-08-12.md`（§5 决策台账 D1–D22）
  - `docs/dev-gotchas.md`（守卫失效的三种形态、变异实证纪律）

## 1. 背景：归一做完了，防复发没做

RFC-294 `design.md §1.2` 给出了「什么才配进共享内核」的四条判据：

> 抽象只有同时满足以下条件才进入共享内核：**①至少两个真实生产 consumer；②语义和失败/恢复合同相同；③旧实现可被删除；④存在防止第二实现再长出的棘轮**。

前三条在 RFC-280 / 282 / 284 / 285 与 2026-08-12 归一审计之后大体兑现——这也是那份审计给出「判定层/状态机层/spawn 层：是」的依据。**第四条从未系统性落地**：仓内确实有 26 个架构守卫机制，但它们**无一例外只覆盖各自诞生时的那一块**，没有一个是面向「未来新增」的全域棘轮。

结果是：公共内核在**判定层**是单一事实源，在**防护层**是不设防的。今天任何人都可以在 `services/lifecycle.ts` 里加一个 `if (origin === 'schedule')`、在 `resourceAcl.ts` 里加一个 `switch (resourceType)`、在 `routes/` 里深导入某个 context 的 `infrastructure/`，而**整套门禁全绿**。

这不是假设。审计逐条实测出的结构性事实（主 session 已亲手复核）：

| 事实 | 证据锚点 |
| --- | --- |
| RFC-294 preflight 只把 `modules/**` 当**边的起点**，起点在 `modules/` 之外的边结构上不可见 | `packages/backend/tests/rfc294-architecture-preflight.test.ts:18` + `:241-242` 的 `if (from === null) continue` |
| 于是 legacy 层深入 module 内部的边完全无人看守：**94 条边 / 28 个文件** | `census-2026-08-23.md §2`（AST 边计数，正式分母）。目标层分布：domain 28 / infrastructure 22 / composition 21 / application 16 / engine 2 / inbound 2 / public 2 / ports 1 |
| 反向同样不可见：模块被围栏四层反向依赖 legacy 的边 **22 条，且 22 条全部出自 `application` 层**（RFC-294 `§G1` 硬禁止）——`domain` / `engine` / `public` 三层今天是干净的 | `census-2026-08-23.md §3`。按 context：code-capability 9 / task-execution 8 / integration 5；其中 11 条是 `drizzle-orm`、11 条是 `@/services/*` |
| 模块形状锁（顶层目录集、层内矩阵、composition 纯净）只覆盖 **4/11** 个 bounded context；`task-execution`——RFC-294 命名的执行内核本身——**零形状锁**，且已长出非规范的 `inbound/` 顶层目录 | `rfc310-architecture-lock.test.ts:27` 的 `MODULE_ROOT` 绑死单模块；`packages/backend/src/modules/task-execution/inbound/directTaskInitiator.ts` |
| `modules/intent` 只有 1 个文件、**没有 `public/`**，唯一消费者是 legacy 深导入——所有守卫都判它「干净」（空 context 得满分） | `packages/backend/src/modules/intent/domain/workflowCreateLayout.ts`；`packages/backend/src/services/intent/turnEngine.ts:60` |
| 归档守卫只走**一跳** FK，`review_comments` 是两跳级联后代 ⇒ 归档**静默删除**且既不在 `ARCHIVED_TABLES` 也不在豁免表 | `packages/backend/tests/rfc311-task-archive.test.ts:495` 的 `if (target !== 'tasks' && target !== 'node_runs') continue`；`packages/backend/src/db/schema.ts:2211-2217`（`review_comments.doc_version_id → doc_versions` cascade）；`packages/backend/src/services/taskArchive.ts:223-232` |
| RFC-310 的 5 类 ACL 资源写门**只校验「能看见」**，而 `permission.ts:952-965` 的注释白纸黑字写「per-row check 是 resource ACL，和这里其他类型一样」 | `packages/backend/src/routes/developmentConfig.ts:245-255` 自定义 `requireVisible`，`:343 / :350 / :357 / :392 / :399 / :406 / …` 全部只调它；7 个经典资源路由文件用的是 `requireResourceOwner`（28 处） |
| 账本只有 stale 检测、**没有增长上限**：`scripts/depcheck.ts:28-30` 的注释声称「只能缩不能涨」，`:403-413` 只实现了「缩」的一半 | ⇒ 同一个 PR 里加违规 + 加豁免行，全绿 |
| 约 20 个架构机制里**只有 4 个**带在仓变异 fixture；`rfc217-architecture-locks.test.ts:176-210` 用 `<=` 而非 `===`，实测 snapshot 记 `dwActions.ts:2` / `room.ts:1` 而真实计数是 `0` 和 `0` | ⇒ **今天就有 3 个免费的业务分支槽位**；且 `strategies/` 目录下 cap 是 `Infinity` |

## 2. 目标

- **G1 「公共内核」成为机器可读的一等资产。** 今天「哪些文件是公共内核」只存在于 RFC 散文与人的记忆里；本 RFC 把它落成 `architecture/commons-manifest.json`——每个内核声明 owner context、层、文件集、它是什么的单一事实源、允许的业务词汇预算、看守它的守卫。这是 RFC-294 W0-R 七份 manifest 中 `module-symbol-owners.json` 的**公共内核子集**，是那份 manifest 的第一次真实沉积。
- **G2 每一类「业务特殊处理」形态都有一条会红的规则。** 审计归纳出七种形态（通用写点里长业务分支 / 默认值编码某族调用方旧行为 / 「通用」内核只对一个调用方正确 / 第二实现 / 逃生舱 / 可伪造合同 / 陈述与源码相反），每一类都必须有一条**新增一个实例就红**的机器规则，而不是靠 code review 纪律。
- **G3 账本只减不增。** 仓内每一个 allowlist / 债务表都加高水位基线，且基线本身只能下降。终结「同一个 PR 里加违规又加豁免」这条路。
- **G4 守卫的绿必须是可信的绿。** 守卫文件两向钉死（删/改名要红）、扫描语料非空断言（挡「扫了个寂寞」）、每条守卫必须导出变异 fixture 并由 manifest 跑一遍证明它会红。
- **G5 修掉 52 条 P1/P2**，每条配红→绿回归；79 条 P3 不修，但全部登记进精确债务账本并被棘轮锁死不再增长。
- **G6 三处边界同批统一**：`packages/backend/src` 的公共内核、`packages/shared/src` 的注册表与纯核、`packages/frontend/src/components` 的公共原语。CLAUDE.md §Frontend UI consistency 是硬规则，但今天**只有散文没有可执行棘轮**——新文件落原生 chrome 零红。

## 3. 非目标

- **不做 RFC-294 W0-R 的全部内容。** 不产出七份完整 manifest、不做 SCC 归零、不做 route→DB 归零、不做 362 个 service 文件的完整 owner map、不做 P0-D durable ownership fence。本 RFC 只交付 W0-R 中**与公共内核边界直接相关**的那一刀，其余仍由后续波次各自立 RFC。
- **不搬迁文件、不改目录结构。** 债务用账本登记，不用 `git mv` 解决。这是为了让本批可整体 revert，且与并发 session 的冲突面最小。
- **不修 79 条 P3。** 它们进账本、被棘轮锁住不增长，随各域下一个 RFC 顺带清。
- **不改 API / DB schema / WS 协议**，`§4 能力影响清单` 逐项列出的收缩项除外。
- **不引入新的横向 `services-v2/`**，不新建 facade。

## 4. 能力影响清单（CLAUDE.md §RFC workflow 第 7 条，**须逐项确认**）

本 RFC 修复 P1/P2 时会**关闭或收缩既有能力**。按仓规逐项列出、作为 breaking change 呈确认——不得以「安全默认」名义静默移除。

| # | 收缩项 | 现状 | 收缩后 | 受影响 actor / 部署形态 | 判据来源 |
| --- | --- | --- | --- | --- | --- |
| **C1** | RFC-310 五类配置资源（`action_template` / `verification_profile` / `digital_employee` / `automation_policy` / `development_adapter`）的**写门** | 任何持 `<type>:update` / `:archive` 点的登录用户（= 默认 `user` 角色预设即持有，`permission.ts:955-998`）可以改写 / 发布 / 归档**别人的** public 资源 | 与其余 7 类 ACL 资源对齐：**仅 owner 本人与 `resource-acl:bypass` 持有者可写**。注意 `resource_grants` **不含写权**——`resourceAcl.ts:458-462` 的 `isResourceOwner` 只认 bypass 或 owner 本人，grant 只进 `canViewResource`（`:416-421`），即「授权」只授可见与可用 | **所有非 owner 的普通用户**。已在生产把这些资源当共享编辑面用的团队会**立刻失去写权**，且**没有 grant 级的替代品**；三条出路：①由 owner 操作；②给该用户授 `resource-acl:bypass`（manager+ 才有此点）；③转移 owner（RFC-223 owner transfer）。④自己复制一份 | `findings.md` ACL-01 |
| **C2** | `employee_definitions` 的可见性 | 表已带 `owner_user_id` / `visibility` / `acl_revision` 三列且有 owner+name 唯一索引，但 `'employee_definition'` 不在 `ACL_RESOURCE_TYPES` 中 ⇒ 三列**完全惰性**，`listEmployeeDefinitions` 只按 `archivedAt` 过滤，**全员可见全部员工定义** | **裁决：(a) 立为第 13 类 ACL 资源**。存量行不回填——`ownerUserId` 恒等于创建者、`visibility` 恒为 `'private'`（`authoringService.ts:1073`），故入网后每个用户只看得见自己的员工定义 | **所有非 owner 用户**：别人的员工定义立刻从列表消失，需 owner 显式 grant 或设 public | `findings.md` ACL-02 |
| **C3** | `POST /api/runtimes/probe` 的 `extraArgs` / `isSandbox` | **无能力门**：请求可对任意 runtime 带上这两个字段并真实拉起子进程；注册写路径的 `validateExtraArgs` / `validateIsSandbox` 在这条路上从不调用 | 两个校验前置到 handler 顶部，不支持该能力的 runtime 返回 400 | 直接调该端点、给不支持 `extraArgs` 的 runtime 传参的用户 / 脚本 | `findings.md` RT-01 |
| **C4** | `spawnVersionProbe` 的「无 timeout」模式 | `timeoutMs` 可省略；省略时**无进程组、无树杀、无超时、stdout 无上限**。daemon 启动路径 `cli/start.ts:401` 与 `cli/doctor.ts:41` 正是这么调的 | `timeoutMs` 改必填（带具名默认常量），无 timeout 模式**删除**（delete > deprecate） | 无外部可见行为变化；探测本身耗时超过默认值的极端环境会从「永久挂起」变成「超时报错」 | `findings.md` EK-02 |
| **C5** | `list<markdown>` 端口正文的持久化形状 | `outputKinds/list.ts:142` 对**所有** list 用单行 codec `splitListItems`（trim 每行 + 丢弃所有空行），`list<markdown>` 的多行文档正文因此在落库前被压掉空行——而同一文件的 prompt 指引又告诉 agent 它的文档是多行的 | 按 item kind 选 codec，`list<markdown>` 保留原文 | **持久化正文形状变化**：新产出的 `list<markdown>` 端口内容会保留空行；存量行不回填 | `findings.md` NK-01 |
| **C6** | 归档产物 | `review_comments` 随归档被**不可逆删除**且无任何报错 | 纳入 `ARCHIVED_TABLES`（归档目录新增一个 `review_comments.jsonl`），或显式进豁免表并写清理由 | 归档产物多一个文件；已归档任务的评论**无法追回**（本 RFC 只止血，不做历史恢复） | `findings.md` CC-01 |
| **C7** | `EXEMPT_MOUNTS` 与 `method='ALL'` 的路由门豁免 | 可静默新增：`app.all('/api/x')` / `app.use('/api/x/*')` 天然绕过启动自检 | `EXEMPT_MOUNTS` 冻结为精确集合；`/api/*` 前缀的 ALL 挂载必须显式入账 | 未来新增 ALL 挂载的开发者（须改一行账本） | `findings.md` TP-02 |
| **C8** | 前端五个死 className 家族 | `page__subtitle` / `form-section__hint` 等在 TSX 里用、CSS 里无定义 ⇒ **报错/提示无视觉** | 改用公共原语或补 CSS | **用户可见**：原本静默无形的错误与提示会显示出来（这是修 bug，但确实改变界面） | `findings.md` FE-02 |
| **C9** | `allowTerminal` / blind-write marker / spawn-site / migration-hash 等 8 类账本 | 可自由增长 | 精确计数 + 高水位、只减不增 | 未来要新增一处的开发者（须显式改账本并写 why） | `findings.md` LC-02 / LC-07 / CC-03 / CC-06 |

> **C1、C2(a)、C5、C6、C8 是真实的对外行为变化**，其余是开发期摩擦。
>
> **2026-08-23 逐项确认结果**：C1–C9 全部接受。C1 采**「直接收紧、不做迁移」**。
>
> **⚠️ 确认后订正（B1 开工前读源码时发现，未改变裁决、但改变了代价）**：本表初稿把 C1 的替代路径写成「改用 grant」，**这是错的**。`resource_grants` 只进 `canViewResource`，不进 `isResourceOwner`，仓规也写明「Granted users can view and use；owner 与 `resource-acl:bypass` 持有者才能 modify」。因此收紧后**不存在 grant 级的写权替代品**，出路只有「由 owner 操作 / 授 `resource-acl:bypass` / 转移 owner / 自己复制一份」四条。C2 采 **(a) 立为第 13 类 ACL 资源**，存量行不回填；已复核 `resource-acl:private` 在 `USER_BASELINE` 内（`permission.ts:1032`），故 owner 仍能看见与编辑自己的私有员工定义。

## 5. 用户故事

1. **作为接手某个公共内核的工程师**，我想在动手前一眼看到「这个文件是什么的单一事实源、它禁止出现哪些业务词汇、谁在看守它」，而不是去翻六份 RFC 和一份 8 个月前的审计报告。
2. **作为写新功能的工程师**，当我图快在 `services/lifecycle.ts` 里加一个 `if (origin === 'schedule')` 时，我希望**本地门禁立刻红**并告诉我正确形状是「注入一个 policy」，而不是等三个月后的下一轮审计。
3. **作为 code reviewer**，当有人在同一个 PR 里既加了一条跨界导入、又往账本里加了一行豁免时，我希望门禁红在「账本涨了」上，而不是依赖我逐行看 diff 发现那一行。
4. **作为下一轮的审计者**，我希望「某条守卫今天还有没有预言力」是可执行的判据（语料非空 + 变异 fixture 转红），而不是读注释里那句「写入时验证过」。
5. **作为普通用户**，我不应该能改写别人的动作模板；我的评论不应该在任务归档时无声消失；界面报错时我应该看得见。

## 6. 验收标准

- **AC-1**：`architecture/commons-manifest.json` 落地并覆盖本轮认定的全部公共内核；每条含 owner context、层、文件集、单一事实源声明、业务词汇预算、看守它的守卫 id。清单与源码双向闭合：清单里的文件必须存在，被 R4 规则扫到的文件必须在清单里。
- **AC-2**：R1（inbound）与 R2（outbound）两条边界规则落地，今天的 **94 + 22** 条边**逐条**入 `architecture/commons-debt.json`（含 `from` / `to` / `symbol` / `edgeKind` / `owner` / `why` / `removeAfterWave`），断言用 `toEqual` 精确相等 ⇒ 新增会红、修好不销账也会红。
- **AC-3**：R3（模块形状）覆盖 `modules/` 下**全部 11 个** context：顶层目录集闭合、层内导入矩阵、composition 纯净、`public/` 非空（或显式标 `status:'skeleton'` 带 `removeWhen`）。`task-execution/inbound/` 与 `intent` 无 `public/` 作为具名偏离入账。
- **AC-4**：R4（业务身份字面量预算）在 `commons-manifest.json` 声明的文件集上生效，逐文件精确计数（`toBe` 而非 `toBeLessThanOrEqual`），涨要红、降到位不改账本也要红。按 **D4**，标记 `core: true` 的内核预算 **= 0**（业务字面量必须在本 RFC 内清空），其余按实测钉住。
- **AC-5**：R5–R9 五条新规则落地（表归属 / 注册表反向完备 / 站点治理属性 / 级联闭包 / 前端设计系统全域棘轮），每条各带正反 fixture。
- **AC-6**：R10 账本高水位对仓内**每一个** allowlist 生效（`KNOWN_VIOLATIONS`、spawn-site、ux-source-ratchets 三个 allowlist、`rfc143` kind-discrimination、`LEGACY_MIGRATION_HASHES`、rfc294 两条 debt list、本 RFC 新增账本）。
- **AC-7**：R11 `architecture/guard-manifest.json` + `architecture-guard-manifest.test.ts` 落地：守卫文件两向钉死；每个源码文本扫描器断言 `filesScanned > 0`；每条守卫导出 `__mutationFixtures` 并由 manifest 逐条跑过、逐条证明会红。**本条自身也要变异实证**（把某条 fixture 改成不违规，manifest 必须红）。
- **AC-8**：R12 preflight 的解析语料扩到 `packages/shared/src/**` 与 `packages/backend/src/platform/**`（**仅用于解析**，规则主体仍是 `modules/**`），`FORBIDDEN_TYPE_IMPORT` 补 `@/platform` / `@/embed`，public entrypoint 禁非字面量键 `Record`。扩面后 god-surface 与 type-taint 的复算结果入账。
- **AC-9**：52 条 P1/P2 **逐条**修复，每条配一个**先红后绿**的回归用例，且每条都做过变异检验（把修复退回去必须立刻红，**且要复跑一次原变异确认转红**——见 `docs/dev-gotchas.md` 关于「宣布已锁上但断言仍是 no-op」的事故）。
- **AC-10**：79 条 P3 逐条进 `architecture/commons-debt.json`，带 `why` 与 `removeWhen`；`findings.md` 的 gid 与账本条目一一对应。
- **AC-11**：`§4 能力影响清单` 九项各自有测试覆盖**禁用/拒绝分支**（仓规：禁用分支与正向功能同等对待）。C1 须有「被授予 view 的非 owner 发 PUT/publish/archive ⇒ 403 且零写入」的行为断言。
- **AC-12**：`bun run gate:local` 全绿；推送后按 exact SHA 查 hosted CI 全绿（含 Playwright 与 visual）。前端改动若动到已有 scene，按仓规走「首次 hosted run 故意红 → 人工审 PNG → 只提交被接受的 Linux 基线」。
- **AC-13**：本 RFC 修正的全部 stale 断言（15 条 family + 4 条 critic）逐条改对，包含 `services/lifecycle.ts:18` 引用的**不存在的** ESLint 规则名、`shared/ref/resolution.ts:87` 的「单一事实源」声明（实测零生产消费者）、`resourceAcl.ts:1-36` 的「六类资源」表述（实际 12 类）、`depcheck.ts:28-30` 的「只能缩不能涨」（实现只做了一半）。
- **AC-14**：`design/plan.md` RFC 索引登记 RFC-317；`STATE.md` 顶部「进行中 RFC」与完工后的已完成表同步；`docs/dev-gotchas.md` 补本轮沉淀的通用教训（至少：「守卫只覆盖自己诞生的那一块」这一类系统性盲区的自检定式）。

## 7. 风险

| 风险 | 处置 |
| --- | --- |
| R4 业务字面量预算噪声过大，日常开发被摩擦淹没 | 范围限定在 `commons-manifest.json` 显式声明的公共内核文件集（用户已拍板「只在公共内核目录推行」），领域模块不入网。初版预算按实测值精确钉住，不追求归零 |
| 52 条 P1/P2 触及 `scheduler.ts` / `lifecycle.ts` / `task.ts` 三个高冲突文件，与并发 session 撞车 | 这三个文件的改动**严格串行**、单独成批；批次顺序见 `plan.md §3`。开工前 `git pull --rebase`，绝不用 `git reset --hard` / 无参 `git stash pop`（仓规） |
| 账本高水位需要跨 commit 比较，CI 上实现脆弱 | 高水位落成**单独一行的具名常量**（`LEDGER_BASELINE`），测试断言 `ledger.length <= LEDGER_BASELINE`；「基线本身只能降」由一条读 `git show HEAD~1:<file>` 的测试兜底，且该测试在无 git 环境下 skip 而非假绿 |
| 变异 fixture 塞进共享工作树会留下「故意的红」 | 仓规：变异 fixture 用**内存中的合成源码字符串**喂给导出的 matcher，绝不往工作树写真实的违规文件（`docs/dev-gotchas.md` 已有此戒） |
| 本 RFC 自己成为「又一条只覆盖自己诞生那一块」的守卫 | AC-7 的 manifest 是全域的，且要求**未来任何架构守卫**都必须注册进去——这条 meta 规则是本 RFC 的核心交付物，不是附赠品 |
