# RFC-271 · 统一资源表达（Resource Bundle）与配置包

状态：Draft v10（2026-08-08）。经**八轮**外部设计门（R1 12 / R2 9 / R3 18 / R4 13 /
R5 13 / R6 7 / R7 7 / R8 5，逐条核实全部属实）。v1 → R1 → v2 → R2 → **用户决策：归一化
结构化表达** → v3 → **R3（13×P1 + 5×P2，判定不可进入实现）** → v4。

**v4 的范围变更（用户决策 26）**：R3 揭示 `applyChangeset.ts` 的承重不变量有 **~13 条**而非
我 v3 描述的 6 条，多出来的大多是 intent 特有的（session 串行、draft/session claim 与资源写
同事务、provenance + commitSeq + contextRevision + currentDraftId 同事务、copy-only、secret
slot、finalName、session mutation 期间 409）。用户据此拍板**拆**：表达层与引擎照建，但
**本 RFC 只给配置包这一个消费者**——它是 greenfield，没有存量用户、没有 13 条不变量要保；
表达被真实跑过一轮后，intent 再迁到一个已经受过验证的东西上（后续 RFC）。

## 1. 背景

### 1.1 直接诉求

今天唯一的「把配置搬到别处」的手段是工作流的单文件 YAML 导出，它只序列化工作流自己的
`definition`，被引用的一切退化成名字选择器——代理背后的技能 / MCP / 插件 / `dependsOn` 闭包
**一个字节都不在文件里**，导入后必然悬空。工作组则**根本没有导出**。

用户要的是**配置包**：一个 zip，装下这个资源递归闭包内的全部可移植配置，能在另一个实例导入
后直接跑。

### 1.2 为什么这变成了一个「表达层」RFC

第一版把导入设计成一套自建引擎。三轮外部设计门共 39 条 findings（逐条核实全部属实），其中
**至少五条同一根因**：
自造了仓里已有且已调试过的机制，且每次自造都恰好踩中那个机制当初为之而生的坑。

| 我造的                          | 仓里已有                                     | 自造版的缺陷                                                                                 |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 「FS 暂存 → DB 事务 → FS 入位」 | `stageManagedSkill` → `commitSkillReadyInTx` | 顺序反了，凭空造出「DB 已提交、FS 未发布」的不可收敛窗口                                     |
| `packageResourceKey` 出现序号   | `IntentTempRefSchema`（`$new:<slug>`）       | 序号随节点声明顺序漂移，manifest 又不拒重复 key                                              |
| 自建 import journal             | `intentApplyJournal`                         | 无客户端幂等键、无 active lease，慢导入会被小时收敛器当成崩溃任务标 failed                   |
| 预铸 id 解环                    | `bundleCreatedNames`                         | 目标库存在不可见同名行时，环形包仍无首个可写入节点                                           |
| 「复用 dump 脱敏函数」          | ——                                           | `projectMcpForDump` 输出 `oauth:'‹redacted›'` 是**字符串**，直接违反 `McpRemoteConfigSchema` |

同时核实到：`applyIntentChangeset` 已经支持**六类资源 × create/update** 的绝大部分 op，且
`IntentAgentPayloadSchema` / `IntentWorkflowPayloadSchema` 就是一份可移植资源表达——后者甚至
已经硬性禁止 payload 里出现 `agentId` / `agentName`，只许 `agentRef`。

**结论**：平台其实已经长出了一份「结构化资源表达 + bundle 落地引擎」，只是它被命名和圈定
在 intent 场景里。配置包不该再造一份，而该抽出一份**平台级**表达——本 RFC 建它并让配置包
先用起来，intent 在后续 RFC 迁入（决策 26）。

## 2. 目标

1. **抽出一份平台级的资源 bundle 表达**（`ResourceBundle`）：六类资源的可移植 payload +
   引用域 + 操作集 + 落地引擎，与任何具体场景（intent / 配置包 / 未来的模板市场）解耦。
   1b. **统一引用模型**（决策 29）：把仓里**六套各自为政**的「怎么指向一个资源」合成一个
   `ResourceRef`（形态集 + 域子集 + 解析契约）。**包括调度器的运行期解析**——用户观察
   「调度器的节点选择器和统一资源建模应该是一套东西」，核实属实。
2. 在此之上交付**配置包**：六类资源皆可作根，递归闭包导出为 zip；导入走预检页逐条决策；
   导出导入均提供 CLI。**配置包是本 RFC 唯一的消费者。**
3. 引擎的 provider 接口**预留事务钩子**（`claimInTx` / `revalidateInTx` / `finalizeInTx`），
   使后续 RFC 能把 intent 迁进来而不必重构引擎——但本 RFC **不迁 intent**。
4. **顺带解开 intent 的一处欠账**（决策 27）：`skill-update` 需要的四段技能版本内核本就要为
   配置包建，建好后 intent 自己那条路径也能调它，把 `copyOnlyTargetsFor` 里那句
   `'in-place update for this resource type is not supported yet'` 解掉。这是 intent 的
   **能力扩张**（非收缩，不进 §5 清单），单独验收。

## 3. 非目标

- 不导出运行态（任务 / node_run / 评审 / 聊天室 / 记忆）、账户面（用户 / 权限矩阵 / OIDC /
  PAT）、仓库（`cached_repos` / `repo_groups` 及其密封凭据）。
- 不替代 backup/restore（那是整机冷备份，两条线互不复用产物）。
- 不做跨格式版迁移、增量包、差分包、包签名、包加密。
- **不扫描技能文件树内容里的密钥**：脱敏保证限定在**结构化字段**，技能目录里硬编码的凭据
  属于技能作者的责任（决策 18）。
- 调度 / 准入 / containment / runtime 选择零改动。
  ⚠️ **一处例外（决策 28）**：`freezeCallClosure` 的工作组分支改 id-cache 优先，**且冻结闭包
  改为按节点键控**（两侧同改）。这是执行期行为变更，作为 **C7** 列入 §5。
- **不迁移 intent**（决策 26）：`applyIntentChangeset` 与 `intent_apply_journal` 原样保留，
  本 RFC 不碰它的生命周期。唯一的交集是 §2 决策 27 的技能内核复用。

## 4. 用户故事

1. 我在测试实例调好一条牵扯 4 个代理、2 个技能、1 个 MCP 的工作流，点「导出配置包」拿到
   zip；生产实例上传，预检页列出这 9 个资源、逐条确认后一次导入完成，直接能启动任务。
2. 我把一个成熟审计代理分享给同事，包里自动带上它的技能与 `dependsOn` 子代理；同事导入时
   已有的同名 MCP 选「复用已有」，代理选「新建副本」。
3. CI 里从 staging 同步到 prod：`export-package --as-user ci ...` → `import-package ...
--as-user deployer --plan > plan.yaml` → 人工复核 → `--apply plan.yaml`。
4. 包里的 MCP 需要 `GITHUB_TOKEN`，那一项是脱敏占位，预检页在那条上直接给输入框，我当场填。

## 5. 能力影响清单（CLAUDE.md 规则 7 强制）

沿用 v2 已获用户逐条确认的六条，**本版无新增收缩**：

| #                                  | 被关闭的能力                                              | 改后                                                                                                                                                                                                                                                              | 受影响者                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1**                             | 工作流单文件 YAML 导出（`GET /api/workflows/:id/export`） | 端点下线，由 `export-package`（zip）取代                                                                                                                                                                                                                          | curl 该端点解析 YAML 的自动化立即失效                                                                                                                                                                                                                                                           |
| **C2**                             | 裸 `.yaml` 导入（`POST /api/workflows/import` + 对话框）  | 端点与对话框下线，导入只接受 zip                                                                                                                                                                                                                                  | 手里只有旧 YAML 且源实例已不在的人没有导入路径                                                                                                                                                                                                                                                  |
| **C3**                             | 救援态「导出本地 YAML」（RFC-199 B2 纯浏览器端）          | 删除                                                                                                                                                                                                                                                              | 工作流被删后本地草稿只剩「另存副本」                                                                                                                                                                                                                                                            |
| **C4**                             | 无特权权限者导出含特权节点的工作流                        | 422，**按节点类型分轴**判定                                                                                                                                                                                                                                       | 普通用户导不出含对应特权节点的工作流                                                                                                                                                                                                                                                            |
| **C5a**                            | 按 exact id 覆盖导入                                      | 改为按名字匹配                                                                                                                                                                                                                                                    | 所有角色                                                                                                                                                                                                                                                                                        |
| **C5b**                            | 覆盖他人拥有的资源                                        | 仅对自己拥有的开放                                                                                                                                                                                                                                                | 仅 manager / admin                                                                                                                                                                                                                                                                              |
| **C6**                             | 导出传递不可见闭包的工作流                                | 整体 422 并明确提示                                                                                                                                                                                                                                               | 代理可见但其 `dependsOn` 不可见者；这类工作流**仍可正常运行**                                                                                                                                                                                                                                   |
| **C7** 🆕 **（行为变更，非收缩）** | call 节点的启动目标解析                                   | ①工作组分支今天**只按名字**取最老可见行，`workgroupId` 存在却从不被读（`closure.ts:269-309`）→ 改为 id-cache 优先；②**冻结闭包从按名字键控改为按节点键控**（`FrozenCallClosure` 的两个 `Record<string,…>` 都是按 name，同名两节点因此落到同一条）→ 每节点各自冻结 | **两处变更**：(a) 无冲突时启动目标从「最老可见行」变成「你当初在下拉里选的那个」；(b) 同名两节点从「都跑同一个」变成「各跑各的」。二者都是用户存下 `workgroupId` 时的意图，但确实是变更，发布说明须点名。**存量任务零影响**：`parseCallClosure` 同时接受 v1 name-keyed 与 v2 node-keyed，零迁移 |

> **两条候选收缩经核实/决策后消解**：PAT 导入通道（是我把 `tokenAccess` 写成 `'never'` 写错
> 了，`registry.ts:44-62` 写明该值只为 RFC-247 的 D5/D6 存在、创建资源不在其列，六类 create
> 端点全是 `'allow'`）；同名二义 422（改为沿用 `freezeCallClosure` 的解析规则）。

**intent 侧只有一处能力扩张、无收缩**：决策 27 解开 skill/plugin 的原地更新（今天硬编码
只能 copy）。扩张不进本清单，但有专门验收（AC-K1/K2）。

## 6. 产品决策

### 6.1 前五轮澄清（v1，逐条仍有效）

1. 导出 + 导入同期交付，导入入口统一收 zip，裸 YAML 能力下线。
2. 密钥一律脱敏（范围见 18），manifest 生成待填清单，预检页给输入框当场补。
3. 闭包里有不可见依赖 → 整体 422 并明确提示无法导出。
4. 覆盖只对自己拥有的资源开放；包不携带权属信息；新建一律「导入者 owner + private」。
5. 机器级依赖（runtime / 代码平台 / MCP 可执行文件 / 插件源 / 仓内 `project` 技能）只进
   `requirements` 声明。
6. 框架内置资源不进包，只记依赖声明。
7. 特权节点无对应权限直接拒绝导出，按轴判定。
8. 体积上限沿用 `SKILL_ZIP_LIMITS`。
9. 预检匹配：优先自己的同名 → 否则列可见候选让你选 → 都没有则新建。
10. 导入失败即停 + 回滚已建。
11. 权限不足 → 预检页标红，不解决不让导。
12. manifest 只记格式版 + 平台版 + 导出时间。
13. 插件只带 `spec` + `options`。
14. 「新建副本」名字自动生成且可现场改。
15. CLI 导出导入都给，两条命令都必须 `--as-user`。
16. 导出入口在详情/编辑页「更多操作」；导入入口各列表页 + 统一入口 + 类型不符自动跳转。

### 6.2 设计门后追加（v2）

17. 落地复用既有 pre-stage + big-tx 内核，不自造持久化路径。
18. 脱敏范围限定结构化字段，不扫技能文件树。
19. 同名二义沿用 `freezeCallClosure` 的解析规则。
20. CLI 两条命令都要 `--as-user`；文档写明本机操作者本身是 break-glass 管理员。
21. 导入端点 `tokenAccess:'allow'`，授权靠逐类权限点，与界面逐字一致。

### 6.3 架构决策（v3）

22. ~~**归一化：新设计一份表达，intent 与配置包两边都迁**~~ **（已被决策 26 supersede：表达层
    照建，但 intent 主流程不迁）**，不以 `IntentChangeset` 为基底
    向后兼容——它带着「模型输出专用」的历史包裹（session handle 域、给模型看的约束文案），
    作为平台级表达会长期别扭。
23. ~~**同一 RFC 一次到位**~~ **（已被决策 26 supersede）**：R3 揭示 intent 的不变量面是
    ~14 条且多为场景特有，与包的新 bug 压在同一 changeset 里风险叠加。
24. **可见即有读权限**：导出的读侧判据只有 ACL 行级可见性，**不**额外要求类型级 `*:read`
    权限点。AC-7d 是一条**反向锁**（可见但缺该类型权限点必须导出成功）。
25. **owner 断言进最终事务**：commit 时服务端重算每条允许的动作（不信客户端传来的），并在
    真正写入的事务内对每个 overwrite 目标断言 `ownerUserId === actor.user.id`。
    ⚠️ 这不是新规则，是把决策 4 在**新写路径**上补齐——已核实 `commitMcpUpdateInTx`
    （`mcp.ts:180`）等内核只校验 `expectedConfigHash` **不校验 owner**，owner 门在路由层
    （`routes/mcps.ts:375`），而导入提交不经过那条路由。详见 `design.md §5.4`。
    ✅ R3 已核实**这不构成 intent 能力收缩**：`copyOnlyTargetsFor`
    （`applyChangeset.ts:135`）今天就在 preflight 校验 `ownerUserId`，非本人资源只能 copy。
    加断言只是闭合「preflight 后发生 owner 转移」的 TOCTOU 窗口。

### 6.5 统一引用模型（v8，本轮）

29. **六套引用机制合一**（用户拍板，2026-08-08）。合的是**命名与解析层**，不是事务层——
    与已被砍回的决策 23（把 intent 的 apply 引擎迁进来）是两个量级。
    - **既有拼写全部保留为合法形态**：`res#agent#3`、`$new:slug`、裸 ULID、`name` 选择器
      逐一进 `ResourceRef` 的形态集 ⇒ **`INTENT.md`、模型输出、存量 definition、导入 YAML
      一个字节都不用改**（v4/v6 那句「模型契约不动」的承诺因此保住）。
    - **域是收窄不是放宽**：六个域各自只允许一个形态子集，把 `name` 塞进 agent 的
      `dependsOn` 必须 parse 失败。
    - **解析契约是实质**：`freeze` / `aclAt` / `dangle` 三条属性一并进模型，否则表达不了
      `freezeCallClosure`。决策 28 因此不再是独立实现，而是 `CallRef` 域的 resolver 实例。
    - 受影响的运行期代码：`scheduler.ts` 的 `agentId` 裸读（`:5187` / `:6943` / `:6997`；
      ⚠️ v8 误列的 `:7226` 是 `markWrapperTerminal` 不是读取点）、`freezeCallClosure`、
      `detectCallCycles`、validator 闭包装载、runner 的技能/MCP/插件闭包组装。
      ⚠️ **我明确提示过这是决策 23 那条已失败过一次的路**；用户在知悉后仍选择一次到位。
      风险按 `plan.md` 的批次 A′ 独立成 commit 控制。

### 6.4 范围决策（v4）

26. **拆**：表达层 + 引擎 + 配置包在本 RFC；**intent 迁移另立 RFC**。引擎的 provider 接口
    预留事务钩子，使后续迁移不必重构引擎。理由见状态段——intent 的不变量面是 ~13 条，
    与包的新 bug 压在同一个 changeset 里风险叠加。
27. **`skill-update` / `plugin-update` 进表达层，且顺带给 intent 开**：四段技能版本内核本就
    要为配置包建；建好后解开 intent 那句 `'not supported yet'`。属**能力扩张**，单独验收
    （AC-K1/K2），不进 §5 收缩清单。外部 owner 仍只能 copy（那条判据不动）。

## 7. 验收标准

### 表达层（新）

- **AC-B1** `ResourceBundle` 表达覆盖六类资源，且**不含任何场景特有字段**（无 session
  handle、无 intent 用语、无包路径）。
- **AC-B2** 引用槽只接受该槽所属域的形态（四个域见 design §1.3）；裸 id / 裸 name 出现在
  payload 里 → parse 失败。
- **AC-B2c** 🆕 **统一引用模型**（决策 29）：`ResourceRef` 是**唯一**的「怎么指向一个资源」，
  六个域各取一个形态子集。**跨域使用必须 parse 失败**（如 `name` 形态出现在 agent 的
  `dependsOn`）。
- **AC-B2d** 🆕 **wire 零变更**：`res#<type>#<n>`、`$new:<slug>`、裸 ULID、name 选择器逐一
  保留为合法拼写 ⇒ `INTENT.md`、模型输出、存量 workflow definition、agent.md 导入
  **一个字节不改**。测试做**字节级拼写断言**；intent 测试套**零改判**。
- **AC-B2e** 🆕 **解析契约进模型**：域级 `freeze` / `aclAt` + **调用级 `purpose` /
  `onMissing` / `failureOwner`**（共五属性），且 `resolve` 返回 typed `Result`、**不 throw**
  ——直接 throw 会被 `runScope` 冒泡成任务级 `scheduler error`，丢掉 node/wrapper 归属。
  `freezeCallClosure` 是 `CallRef` 域的 resolver 实例，不是独立实现。
- **AC-B2g** 🆕 **边身份契约**：所有 call 图操作走 `resolveEdge(sourceWorkflowId, CallRef)`,
  **六个消费者同源**（冻结生成 / scheduler 主消费 ×2 / `childClosureSubset` /
  `detectCallCycles` / validator 闭包装载与端口推导 / **配置包导出器**）。
  导出实例逐字为 `{purpose:'export', onMissing:'dangle', failureOwner:'caller'}`。
  ⚠️ validator 的注释写明「与启动绑同一行」是不变量——决策 28 改了启动判据就**必须**一起改
  validator，否则同名双 id 场景下预览与启动绑不同的行。
- **AC-B2h** 🆕 agent 的 `skills` 槽用**第四个**专属 codec `BundleAgentSkillRef`
  （`local:` / `external:` / **`project:<name>`**），`project-skill` **只在该槽**合法。
  **project 是非资源叶子**：不入 `walkClosure` 队列、不查 row/ACL、不进 `(type,name)` 去重门，
  只产出 payload 边 + 去重后的 `requirements.projectSkills`。
  managed 的编码规则：闭包内 → `local:<slug>`；**builtin / `__system__` → `external:builtin/<type>/<name>`**
  （导入按名字绑本地内置件，本地没有则预检页报错）。⚠️ 否则一个今天合法可跑的代理（含 `{kind:'project'}`
  技能）**无法 round-trip**——`external:` 兜不住它（无资源行可解析）。
- **AC-B2f** 🆕 **调度器不再裸读字段**：`scheduler.ts` 四处 `agentId` 直读收成一个
  `RuntimeRef` resolver；配一条守卫防止下一个 NodeKind 再抄第五份。
- **AC-B2b** 🆕 表达层有**第三种引用形态** `name:<selector>`（late-bound）：`call-workflow` /
  `call-workgroup` 的权威引用是名字且**允许保存时不存在、启动时才解析**
  （`intentDoc.ts:264` 定其为唯一允许的裸名字引用；`rfc234-apply-changeset.test.ts:868`
  锁住 dangling 可保存）。只有 `local:` / `external:` 两形态无法表达它。
- **AC-B3** 操作集是**严格 discriminated union**（12 分支）：create 必须有合法 slug、禁
  `target`/`expect`；update 必须是 external `target`、禁 `slug`、**必须**带该资源类型的
  `expect`；`kind` 与 payload 类型绑定；`local:` 引用的目标类型与引用槽期望类型一致。
  ⚠️ 缺这条约束时 `kind:'mcp-update'` 不带 `expect` 能通过 schema，而
  `commitMcpUpdateInTx` 只在 `expectedConfigHash !== undefined` 时 CAS ⇒ **无 CAS 覆盖**。
- **AC-B3b** 🆕 payload 逐字段对照**正式** create/snapshot schema，不是只列相对
  `Intent*Payload` 的差异。已知两个缺口：agent 的 `network:'allow'|'deny'`
  （`agent.ts:267`，intent 版没有 ⇒ 导出再导入会静默回落成 deny）；技能文件路径
  （intent 版只许 ASCII `[A-Za-z0-9._-]`，正式写路径只要求相对且不越界 ⇒
  `references/审计 规则.md` 这类合法技能**导不出去**）。
- **AC-B4** 落地引擎保留 `applyChangeset.ts` 的**全部**承重不变量。开工前先把它们列成清单
  逐条对照——`invariants.md` 已核实为 **14 条（11 条归引擎）**，v3 只覆盖了 6 条。
  验收清单直接枚举 I1–I14。
- **AC-B4b** 🆕 provider 接口带**事务钩子**（`claimInTx` / `revalidateInTx` / `finalizeInTx` +
  receipt 投影），使后续 RFC 能把 intent 的 session 原子性迁进来而不必重构引擎。
- **AC-B4c** 🆕 引擎自带 **dependency planner + pending seams**：同 bundle 内新建的
  skill/MCP/plugin/agent/workgroup 互相引用时，preflight 必须接受尚未落库的目标
  （`pendingBundleIds` / `pendingAgentNames`），并按类型 + agent `dependsOn` 排序、对
  agent 互相 `dependsOn` 的闭环给出确定拒绝点。
- **AC-B5** 🆕 op 数上限 `BUNDLE_MAX_OPS = 512` **显式披露**：`§3 非目标`里声明，超限报专门
  错误码 `bundle-too-many-ops` 并点名实际条数。不得像 v3 那样静默塞一个字面量。
- **AC-B6** 🆕 `ops` **允许为空**（全 reuse 的包）：引擎走 no-op 成功路径——journal 直接
  committed、返回空 op receipt、同 `importId` 重试返回原 receipt；`rootRef` 可为 external，
  此时必须带 `rootType`（external token 不自带类型，receipt 需要它才能报出根的类型）。

### 导出

- **AC-1** 六类资源详情/编辑页「更多操作」都有「导出配置包」，产物是 zip。
- **AC-2** `manifest.yaml` 的 `resources` 是权威清单；包内未登记文件 → 导入拒绝。
- **AC-2b** 🆕 闭包内出现两个同 `(类型, 名字)` 的资源 → **导出侧 422**
  `package-duplicate-resource-name`，点名是哪两个、各自被谁引用。包不携带 owner
  （决策 4/12），而名字只在 owner 内唯一 ⇒ 这种包对导入方不可分辨、语义上不可表示。
- **AC-3** 闭包完整（工作流 → 代理 / 子工作流 / 工作组；代理 → 技能 + MCP + 插件 +
  `dependsOn`；工作组 → 成员代理）。
- **AC-4** 闭包去重 + 去环；导入侧不要求拓扑序。
- **AC-4b** 包内身份用 `BundleRef` 的 `local:<slug>`，**与声明顺序无关**且 manifest schema
  拒绝重复 slug、拒绝悬空 `rootRef`。
- **AC-5** 技能带整棵文件树。
- **AC-6** **结构化字段**中的密钥值收敛为占位符、键名保留，且脱敏后的文档**仍满足各资源的
  严格 schema**（不得像 dump 投影那样把 `oauth` 变成字符串）。
- **AC-7** 闭包内有导出者不可见的 **id 域**资源 → 422，含传递依赖。
- **AC-7b** **name 域** call 引用「零匹配」与「全不可见」产生**逐字节相同**的 dangling 结果。
- **AC-7c** name 域解析**与 `freezeCallClosure` 逐字一致**：`workflowId` cache 优先（且该行
  仍带该名字），其次最老可见 ULID；manifest 记录候选数与选中项。
- **AC-7d** **可见即有读权限**的反向锁：actor 缺该类型 `*:read` 但资源可见 → **导出成功**。
- **AC-8** 特权节点按轴判定：`lens.scripts && 含脚本节点` / `lens.codeHost && 含代码平台节点`
  各自独立。
- **AC-9** builtin / `__system__` 资源不入 `resources`，只入 `builtins` 声明。
- **AC-10** `requirements` 五段（runtimes / codeHosts / executables / pluginSources /
  projectSkills），**不含任何密钥**（插件 spec 在此处同样脱敏）。
- ~~**AC-11**~~ **【已改判 2026-08-09，用户决策】** 原文：「超 `SKILL_ZIP_LIMITS` 任一维度
  → 422 并点名资源与维度」。**取消**：用户就技能文件树导出明确拍板「整棵树进包，
  **不设任何上限**」——一个技能带多大的辅助文件是作者的事，平台替他截断会产出一个
  「看起来成功」的残包，比大包糟得多。导出侧因此**没有**体积门（`skillTree.ts` 一次
  读完整棵树），本条不再作为验收条款。
- **AC-12** 根资源沿用 exact-revision 保护，**六类都要且用各自的完整形态**（R4-P2-13）：
  工作流 / 工作组 `expectedVersion`；代理 `expectedUpdatedAt` **+ `expectedAclRevision`**
  （`agent.ts:414` 的正式 mutation revision 是这两个）；MCP / 插件 `expectedConfigHash`；
  技能 `contentVersion` **+ `metaRevision`**（`skillToken.ts:23`——只改 description 会推进
  `metaRevision` 而 `contentVersion` 不变，只带后者会漏掉这类漂移）。
  ⚠️ v3 只给了工作流 / 工作组 ⇒ 另一标签把 agent 的 `network` 从 deny 改成 allow 后，
  原标签点导出会静默导出新版本而不是 409。

### 导入

- **AC-13** 各列表页与统一入口都能上传；`rootRef` 类型与当前页不符 → 自动跳转。
- **AC-14** 预检页逐条列出：类型 / 名字 / 本地匹配 / 可选动作 / 权限是否满足。
- **AC-14b** 本地存在多个你自己拥有的同名资源时全部列出，要求显式选定，不得静默折叠。
- **AC-15** 「覆盖」仅在本地同名资源属于你自己时可选。
- **AC-15b** **服务端在 commit 时重算 `allowedActions`**，客户端传来的动作只是意向；
  最终事务内对每个 overwrite 目标断言 owner（决策 25）。
- **AC-16** 「新建副本」默认名不冲突且可现场改。
- **AC-17** 任一条目权限不满足 → 标红，整包不可提交。
- **AC-18** 待填密钥逐条给输入框；留空则跳过并进导入报告。
- **AC-19** 工作组人类席位带 `username`，自动匹配；匹配不上须手动指派或删除该席位。
- **AC-20** 导入可收敛：任一步失败或进程被 `SIGKILL` → 启动收敛能**证明**该前滚还是回滚。
- **AC-20b** 正式资源行在 journal 到达 `committed` 前对读 / 启动路径不可见。
- **AC-21** 新建一律 `owner = 导入者` + `private` + 零 grants；覆盖不改动 owner / visibility /
  grants。
- **AC-22** 跨资源引用按 `BundleRef` 绑到本次导入结果（复用 / 新建混合时各自绑对）。
- **AC-23** `formatVersion` 高于本二进制 → 拒绝。
- **AC-24** 决策携带**内容级** exact token 并在最终事务 CAS：工作流/工作组 `expectedVersion`、
  代理 `expectedUpdatedAt + expectedAclRevision`、MCP/插件 `expectedConfigHash`、技能
  `contentVersion + metaRevision + aclRevision`。
- **AC-24c** 内容 token **由 preview 返回、由 decisions 原样回传**；commit 不得现场重读后
  自比自（那样等于没有 CAS）。回传值的可信度由 AC-24d 的签名保证。
- **AC-24f** 🆕 重复提交按 **三态**处理（I3）：`committed` → 返回原 receipt；`failed` → 409
  并说明上次失败；`prepared`/`applying` → 409「有未结尝试」。**不是「总是返回 receipt」**。
- **AC-24g** 🆕 技能 `noop`（内容未变）**仍进 big tx 做 fence**，只跳过版本写入与 publish。
- **AC-24h** 🆕 每个 `reuse` 目标在 big tx 内复核 `selectedExternalFence`（类型 / id / **签名
  基线里的内容 token** / 当前可见性），**`ops` 为空时也要走**。
  ⚠️ 否则「全 reuse 的包」恰恰是完全免检的那一档：preview 时基线 `H1`、commit 前并发改成
  `H2`，导入成功并绑定用户从未确认的 `H2`。`previewToken` 只证明「用户当时看到 H1」，
  它不是提交的线性化点。
  ⚠️ 跳过整个 op 会破坏整包基线：stage 判定相同 → 同 bundle 慢安装期间并发改成 v2 →
  big tx 跳过它却提交了引用它的代理 ⇒ 导入绑定的是用户从未确认的 v2。
- **AC-24d** 🆕 **preview 与 commit 绑定同一份确认基线**（R5-P1-A 修正）：preview 返回
  `previewToken` —— 一个签死了 `importId ‖ actor ‖ packageDigest ‖ exp ‖ canonical(基线)`
  的信封，基线含每条目的候选 id、各候选的 `expect`、允许动作。decisions / CLI plan 原样回传。
  commit 必须：**① 验签 → ② duplicate lookup（命中走 I3 三态，不查 exp）→ ③ 仅首次 claim
  查 exp**；并断言用户提交的 `(target, expect)` **是该条目基线里的一对**。
  ⚠️ 只签 `packageDigest` 不够：包没变、但客户端把某条的 `expect` 从 `H1` 换成并发改出来的
  `H2`，签名仍有效 ⇒ 覆盖了用户从未确认的 `H2`。
  ⚠️ 顺序也是承重的：先查 exp 会让「commit 成功但响应丢失、过期后重试」直接 409，进不了
  replay，违反 AC-24f 的三态。
- **AC-24e** 🆕 **稳定 `importId` 进 wire**：preview 下发、decisions / CLI plan 回传。
  否则 commit 成功但响应丢失后重传同一个 zip 会**再建一遍资源**（幂等键必须由客户端持有
  并重放，服务端每次新生成等于没有幂等）。
- **AC-24c** 技能目标同时取 `skill_operation_locks`；同目标第二个导入 409。
- **AC-25** 技能与插件落地走既有内核，产出完整 `skill_versions` v1 快照、content hash、
  非空 `cached_path`；测试断言导入后的技能能过 `skillBootVerify`。
- **AC-25b** **技能覆盖**（`skill-update`）不得留下部分提交：已核实 `commitSkillVersion`
  收 `DbClient` 且自开事务（`skillVersion.ts:474`），必须拆成**四段**——
  `stageSkillVersion` / `commitSkillVersionInTx` / `publishStagedSkillVersion` /
  **`abortStagedSkillVersion`**（pre-commit 补偿）。
  ⚠️ **不是「rename 候选目录到 live」**——`versions/vN/files` 是永久权威快照，
  `reconcileSkillLiveFiles()` 靠它重建 live、恢复 handler 靠它前滚
  （`skillVersion.ts:555,608`、`skillVersionOp.ts:64`）；搬走它会让 `skillBootVerify` 失败、
  版本历史读不到、恢复无法前滚。DB 提交后立即 `unmarkSkillBootVerified`，成功后重新 mark；
  **pre-commit 失败保留 op 作恢复 oracle，post-commit 失败绝不回滚**。

### intent 能力扩张（决策 27）

- **AC-K1** 🆕 四段技能版本内核落地后，intent 对**自己拥有的** skill / plugin 支持原地更新；
  `copyOnlyTargetsFor` 里 `'in-place update for this resource type is not supported yet'`
  那条分支移除。
- **AC-K2** 🆕 **外部 owner 仍只能 copy**（`copyOnlyTargetsFor` 的 owner 判据一字不动），
  且既有 copy 语义（slot derivation / copy rewiring / finalName / receipt `fromCopy`）
  逐条保持。测试对「自己的技能 → 原地更新成功」与「他人的技能 → 仍强制 copy」双向锁。

### CLI

- **AC-26/27** 两条命令都必须 `--as-user`，缺则报错退出。
- **AC-26b** 🆕 CLI 根选择器支持 `--id`：工作流名不是 identity，同一 owner 可以有两个都叫
  「审计」的工作流（`rfc264-unicode-names.test.ts:101` 锁住该行为），`--type --name` 选不中。
  二义时列候选并要求 exact id。
- **AC-28** `--plan` / `--apply` / `--on-conflict`（后者与 `--plan` 互斥）。
- **AC-29** CLI 的权限校验、owner 归属、回滚语义与网页逐条一致。

### 令牌与能力下线

- **AC-30/30b** 导入端点 `tokenAccess:'allow'`；令牌矩阵缺某类写权限时含该类新资源的包提交
  422（与预检页标红同源）。
- **AC-30c** 🆕 **路由层只做身份准入，资源类型权限按包内实际条目动态计算**。
  ⚠️ v3 把 preview/commit 的路由门写成六类 `*:read` 的 AND，与 §预检逐条权限自相矛盾：
  只有 agent 读/建权限的用户导入一个无依赖的单 agent 包，会在 middleware 直接被拒、
  根本看不到 `missingPermissions`。
- **AC-31~34** 两条旧路由不再注册；前端 YAML 路径消失；C4 分轴正反例；C6 传递不可见 422。

## 8. 包结构

```
code-review-配置包.zip
├── manifest.yaml          # 格式版 / 平台版 / 导出时间 / rootRef / resources（权威清单）
│                          #   / graph / builtins / requirements / secrets / ambiguousCallRefs
├── README.md              # 自动生成的人类摘要（中英双段）
├── bundle.yaml            # ← ResourceBundle：六类 payload + BundleRef 引用图
├── skills/
│   └── review-checklist/  # 技能整树（payload 引用它，二进制/大文件不进 bundle.yaml）
│       ├── SKILL.md
│       └── references/rules.md
```

**与 v2 的结构差异**：v2 把六类资源各拆成一个目录、各自一份文档；v3 的资源声明**统一收进
`bundle.yaml`**（就是那份共享表达），只有技能文件树因为是二进制/任意文件而留在包内目录。
这样「包」与「intent 产出的 changeset」是**同一种东西的两种载体**，而不是两套格式。

## 9. 度量与回归防护

- 表达层是纯 schema + 纯函数，可脱离 DB 全覆盖。
- **决策 27 的能力扩张单独验收**（AC-K1/K2）：intent 测试套除 `copyOnlyTargetsFor` 的
  四处（prestage 循环 / artifact / 收敛 / `copyOnlyTargetsFor`）外零改判；`ownerUserId`
  判据一字不动。
- 六类根 × 九种闭包形态矩阵；混合「复用 + 新建」的同名重绑单独锁。
- 崩溃收敛在 journal 各 phase 边界注入中断，重启后断言收敛到二态之一。
- 并发导入同目标 → 409。
- **越权对照**：伪造 `overwrite + 他人资源 id + 正确 hash` 的提交必须被最终事务拒绝
  （AC-15b 的锁）。
- C1–C6 每条下线都有源码层文本断言。
