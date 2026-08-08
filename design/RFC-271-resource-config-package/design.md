# RFC-271 · 技术设计 v4

配套 `proposal.md`。锚点为本仓当前源码。

**v4 相对 v3 的范围变更（决策 26）**：表达层与引擎照建，但**本 RFC 只给配置包这一个消费者**；
**intent 不迁移**（`applyIntentChangeset` 与 `intent_apply_journal` 原样保留）。引擎的
provider 接口预留事务钩子，使后续 RFC 迁 intent 时不必重构引擎。唯一与 intent 的交集是
§2.4 的三段技能内核——它本就要为配置包建，建好后顺带解开 intent 的 skill/plugin 原地更新
（决策 27，能力扩张）。

§11 列出三轮设计门共 39 条 findings 的落点。

## 0. 设计要旨

1. **一份表达，多个生产者**。`ResourceBundle` 描述「一组资源 + 它们之间的引用 + 要执行的
   操作」，不含任何场景特有概念。**本 RFC 只接一个生产者（配置包）**；intent 与未来的模板
   市场在后续 RFC 接入，接口为此预留（§2.1 的事务钩子）。
2. **引用槽只许放 `BundleRef`**。这条规则今天已经存在于
   `IntentWorkflowPayloadSchema`（显式拒绝 `agentId` / `agentName`，只收 `agentRef`），
   泛化后成为整份表达的硬约束——它同时解决「包内同名资源绑错」（设计门 B1）与「模型编出
   一个 id」两类问题。
3. **落地引擎保留既有全部不变量，并补齐三条**。`applyIntentChangeset` 的承重不变量
   **R3 点出至少 13 条**（不是 v3 写的 6 条），泛化时**一条都不许丢**——开工前先列清单
   （§2.2b），另补 ① 最终事务内的 owner 断言、② `skill-update` / `plugin-update`、
   ③ dependency planner 与 pending seams。
4. **导出是引擎的逆向，不共用引擎**。导出只需把闭包序列化成 `ResourceBundle`，不写库；
   导入才走引擎。两者共用的是**表达**，不是执行路径。

> **v1/v2 的教训写在这里，供接手者避坑**：v1 自造了「FS 暂存 → DB 事务 → FS 入位」，方向
> 与既有内核相反并凭空造出不可收敛窗口；v2 改为复用内核但仍自建 journal / 自定义 key /
> 直接复用 dump 脱敏函数，又各错一次。定式：**多资源批量落地之前，先在仓里找有没有既成的
> bundle/pre-stage/commit 内核**——`skill-zip.ts:415` 的注释早把自造裸路径的代价写清楚了
> （留下 `versionState='legacy-unbackfilled'`，**单测能过但活 daemon 上每次 create 都挂**）。

---

## 1. `ResourceBundle` 表达（shared）

新目录 `packages/shared/src/bundle/`。

### 1.1 引用域 `BundleRef` —— **三**种形态（R3-F1）

```ts
/** ① bundle 内前向引用：指向同一 bundle 里某个 create op。 */
local:<slug>          /^local:[a-z0-9][a-z0-9_-]{0,63}$/
/** ② bundle 外部引用：不透明 token，provider **必须**解析成本地资源 id。 */
external:<token>      /^external:[A-Za-z0-9._:#-]{1,128}$/
/** ③ late-bound 名字选择器：**允许解析不到**，由启动期兜底。 */
name:<type>/<name>    /^name:(workflow|workgroup)\/.{1,256}$/
```

**第三种形态是必须的**：`call-workflow.workflowName` / `call-workgroup.workgroupName` 的
权威引用是**名字**，且允许保存时不存在、启动时才失败——`intentDoc.ts:264` 明确它是唯一允许
的裸名字引用，`schemas/workflow.ts:800` 定义 `workflowName` 为权威 selector，
`rfc234-apply-changeset.test.ts:868` 锁住 dangling 可保存。

可复现的反例（v3 的两形态设计过不去）：intent 或包创建一个节点为
`{kind:'call-workflow', workflowName:'does-not-exist-anywhere'}` 的工作流——保留裸名字违反
AC-B2；编码成 `external:` 则 `resolveExternal` 拿不到 id、apply 失败。**两条路都堵死。**

`name:` 形态**只允许出现在 call 节点的目标槽**（其它引用槽仍只收 `local:` / `external:`），
schema 层按槽位区分，不是全局放宽。

三种形态与消费者的对应：

| 消费者 | `local:` | `external:` 的 token 是什么 | 谁解析 |
|---|---|---|---|
| intent | 同一 changeset 里新建的资源 | session handle `res#agent#3` | intent provider（查会话挂载表） |
| 配置包导入 | 包里新建 / 副本的资源 | 预检页选定的**本地资源 id** | package provider（决策表） |
| 配置包导出 | 闭包内的资源 | 闭包外已解析的引用 | 导出侧只写不解析 |
| （三种） `name:` | — | 闭包外**未解析**的 call 目标 | 谁都不解析，启动期兜底 |

**裸 id / 裸 name 永远不得出现在 payload 的引用槽里**（AC-B2）。这是把
`IntentWorkflowPayloadSchema` 已有的规则提升为整份表达的通则。

`local:<slug>` 的稳定性（设计门 B1）：slug 由**导出侧显式分配并写进 manifest**，不是从声明
顺序派生的序号；`BundleSchema` 拒绝重复 slug、拒绝悬空引用、拒绝悬空 `rootRef`。

### 1.2 六类 payload

从 `Intent*PayloadSchema` 泛化（去掉给模型看的约束文案与 session 概念，补上包需要的字段）：

| payload | 泛化自 | 变更 |
|---|---|---|
| `BundleAgentPayload` | `IntentAgentPayloadSchema` | `dependsOn/mcp/plugins` 由 `IntentRef` → `BundleRef`；`skills` 条目同 |
| `BundleSkillPayload` | `IntentSkillPayloadSchema` | 文件树条目改为**外部载体引用**（`files: { path, ref }[]`，`ref` 指向包内路径 / intent 的内联内容），因为技能文件可能是二进制 |
| `BundleMcpPayload` | `IntentMcpPayloadSchema` | 保留 `McpLocalConfig` / `McpRemoteConfig` **原结构**（见 §4.2 脱敏必须 schema-valid） |
| `BundlePluginPayload` | `IntentPluginPayloadSchema` | 同上 |
| `BundleWorkflowPayload` | `IntentWorkflowPayloadSchema` | `agentRef` / `call-*` 目标改为 `BundleRef` |
| `BundleWorkgroupPayload` | `IntentWorkgroupPayloadSchema` | **人类成员补 `username`**（intent 版只有占位符，因为模型不许绑人；包必须能带跨实例的人类席位标识） |

### 1.3 操作与顶层

```ts
export const BUNDLE_OP_KINDS = [
  'agent-create','agent-update','skill-create','skill-update',      // ← skill-update 新增
  'mcp-create','mcp-update','plugin-create','plugin-update',
  'workflow-create','workflow-update','workgroup-create','workgroup-update',
] as const

export const BundleOpSchema = z.object({
  opId: z.string().regex(/^op-[1-9][0-9]{0,3}$/),
  kind: z.enum(BUNDLE_OP_KINDS),
  /** create：本 op 产出的 local slug；update：目标的 external ref。 */
  slug: z.string().optional(),
  target: BundleRefSchema.optional(),
  /** update 的内容级 CAS token（AC-24），由 provider 填充。 */
  expect: BundleExpectTokenSchema.optional(),
  payload: BundlePayloadSchema,
}).strict()

export const BundleSchema = z.object({
  bundleVersion: z.literal(1),
  ops: z.array(BundleOpSchema).min(1).max(512),
  /** 该 bundle 的「主角」，供 UI/CLI 定位；必须指向 ops 里的某个 slug。 */
  rootRef: BundleRefSchema.optional(),
}).strict().superRefine(assertBundleRefsClosed)   // 重复 slug / 悬空引用 / 悬空 rootRef 全拒
```

`BundleExpectTokenSchema` 是六类内容级 token 的联合（AC-24）：

| 类型 | token |
|---|---|
| workflow / workgroup | `expectedVersion` |
| agent | `expectedUpdatedAt` + `expectedAclRevision` |
| mcp / plugin | `expectedConfigHash` |
| skill | `contentVersion` + `metaRevision` + `aclRevision` |

---

## 2. `BundleApply` 引擎（backend）

`packages/backend/src/services/bundle/`，从 `services/intent/applyChangeset.ts` 泛化而来。

### 2.1 Provider 接口

场景差异全部收进这一个接口，引擎本体不认识 intent 也不认识配置包：

```ts
export interface BundleApplyProvider {
  /** 幂等身份。package: (scope:'package', key:importId)。**必须由客户端持有并重放** */
  idempotencyKey: { scope: string; key: string }
  /** 解析 external ref → 本地资源 id（+ 类型校验）。`name:` 形态不经过这里。 */
  resolveExternal(ref: string, expectType: AclResourceType): Promise<string>
  /** 技能文件载体：package 从 zip 取。 */
  readSkillFile(ref: string): Uint8Array
  /** 执行身份。owner 归属与全部授权判据都从它出。 */
  actor: Actor

  // ── 事务钩子（AC-B4b）：本 RFC 的 package provider 全部留空实现；
  //    它们存在的理由是让后续 RFC 能把 intent 的 session 原子性迁进来而不重构引擎。
  //    R3 已证明缺了它们 intent 无法迁：intent 要把 draft/session claim 校验、
  //    pre-stage 后的 session 二次 fence、provenance、commitSeq/contextRevision/
  //    currentDraftId、receipt 投影**与资源写放在同一事务**，薄 adapter 在引擎前后
  //    补写会留下「资源已可见但 session 仍指向旧 draft」的崩溃窗口。
  claimInTx?(tx: DbTxSync): void
  revalidateInTx?(tx: DbTxSync): void
  finalizeInTx?(tx: DbTxSync, receipt: BundleReceipt): void
}
```

### 2.2 生命周期（保留既有全部不变量 · AC-B4）

```
① claim      journal 插入 phase='prepared'，UNIQUE(scope, key) 幂等
             ↳ 重复提交返回**原 receipt**，不重跑（设计门 A1：v2 缺这一条，
               响应丢失后重试会再建一个同名工作流）
② pre-stage  FS / 安装副作用，产出「DB 不可见」的成果，逐个记 artifacts：
             · 技能 create → stageManagedSkill(..., {id: 预铸})   reserve(不可见行+op锁)
             · 技能 update → §2.4 的可组合发布形态
             · 插件        → installPlugin，**失败时精确清理**（§2.5）
③ big tx     CAS prepared→applying；一个 dbTxSync 内：
             · 内容级 CAS（BundleExpectToken）
             · **owner 断言**（§5.4，新增）
             · commitSkillReadyInTx / 各 commit 内核 / 三类 CRUD
             · 按 BundleRef 回填全部引用
             · bundleCreatedNames 排除同 bundle 待建名字（设计门 B3）
             · journal → 'committed' + receipt
④ 幂等尾     清理 staging / backup。失败无害，收敛会重放
⑤ 收敛       启动 + 每小时：prepared/applying → 逆序补偿 → failed；committed → 重放尾
             ↳ **active set + freshness 下限**（`ACTIVE_APPLY_JOURNALS` +
               `CONVERGE_MIN_AGE_MS = 10min`）——v2 缺这两条，一个慢 npm 安装跨过小时
               tick 就会被判成崩溃任务
```

### 2.2b 不变量清单是开工前置（R3）

R3 对照 `applyChangeset.ts` 列出的承重不变量**至少 13 条**，v3 的生命周期描述只覆盖 6 条。
泛化前必须把它们逐条列出并标注「本 RFC 是否需要 / 由谁承载」：

| 不变量 | 锚点 | v4 归属 |
|---|---|---|
| 整个 apply 按 scope 串行 | `applyChangeset.ts:198` | 引擎（scope 由 provider 给） |
| claim 同事务校验身份 / in-flight / draft hash，且 duplicate 查询先于这些校验 | `:277` | 引擎骨架 + `claimInTx` |
| committed / failed / unsettled **三态** replay，不是统一「返回 receipt」 | `:357` | 引擎 |
| slot / secret waiver / human binding / finalName / copy-only / typed ref / cycle 校验 | `resolveChangeset.ts:345` | **intent 特有**，留在 intent（本 RFC 不迁） |
| 预铸 id、按类型与 agent `dependsOn` 排序 | `resolveChangeset.ts:651` | 引擎（§2.6 planner） |
| `pendingIds` / `pendingAgentNames` 让 preflight 接受未落库的同 bundle 目标 | `:428` | 引擎（§2.6） |
| prepared→applying CAS **之后**再次校验身份 | `:695` | 引擎 + `revalidateInTx` |
| commit kernel / 引用 ACL / 特权 principal / `bundleCreatedNames` 都在 big tx | `:727` | 引擎 |
| provenance / commitSeq / context epoch / currentDraftId / receipt / journal committed **与资源写同事务** | `:865` | 引擎 + `finalizeInTx` |
| DB 已提交后任何 tail 异常**都不得**补偿或把 journal 改 failed | `:922` | 引擎 |
| session mutation 在 unsettled apply 期间必须 409 | `session.ts:195` | **intent 特有**，留在 intent |
| active set + 10 分钟 freshness + 启动/小时收敛 | `:979` | 引擎 |

### 2.3 `bundleCreatedNames`（设计门 B3）

name 域的 ACL 校验必须排除**同 bundle 内待创建**的名字，否则：Alice 导入互相 call 的新工作流
A、B，而目标库已有 Bob 私有的同名 A、B —— 无论先写哪个，第一条 call 引用都只匹配到不可见
外部行，`assertRefsUsableInTx`（`resourceRefs.ts:263-318`）拒绝，**不存在可行拓扑序**。
`applyChangeset.ts:733,812,819` 已有该机制，泛化时原样带过来。

### 2.3b Dependency planner 与 pending seams（R3 / AC-B4c）

正式 prepare 跑在 big tx **之前**，此时同 bundle 新建的资源还没有 DB 行。可复现场景：一个
bundle 同时新建 skill / MCP / plugin / agent / workgroup，agent 引用前三者、workgroup 引用
新 agent —— 没有 seam 就会报 missing ref。`bundleCreatedNames` 只解决 workflow/workgroup 的
**name 域 ACL**，解决不了这些 **id 域 preflight**。

引擎因此必须带：

- `pendingBundleIds` / `pendingAgentNames`：preflight 接受同 bundle 内尚未落库的目标
  （`applyChangeset.ts:428` 已有，泛化时带过来）；
- **planner**：按资源类型 + agent `dependsOn` 排序（`resolveChangeset.ts:651` 已有）；
- **agent 环检测**：两个 agent 互相 `dependsOn` 的闭包必须有**确定拒绝点**——AC-4 说「导入不
  要求拓扑序」指的是 workflow/workgroup 的 call 环（靠 `name:` late-bound 化解），
  agent `dependsOn` 环则是非法输入。

### 2.4 `skill-update` 的可组合性（设计门 A3 / AC-25b）

**已核实的障碍**：`commitSkillVersion(db: DbClient, ...)`（`skillVersion.ts:474`）收的是
`DbClient` 且内部自开 `dbTxSync`（`:513-528`），**塞不进 big tx**。若照 v2 那样直接调用，
会出现「S1 的版本已由内部事务提交、随后 S2 的 token CAS 失败 → 整包判 failed，但 S1 已被改」。

拆成**三段**（在 `skillVersion.ts` 内新增），既有 `commitSkillVersion` 退化为三段的顺序组合、
其它调用方零改动：

| 段 | 做什么 | 何时 |
|---|---|---|
| `stageSkillVersion(...)` | 开 version-write op（拿 `skill_operation_locks`）、产 op-scoped staging、归档 `versions/vN/files`（**永久权威快照**）、算 content hash。`fs-staged` → `fs-versioned` | pre-stage |
| `commitSkillVersionInTx(tx, staged)` | 事务内写 `skill_versions` 行 + `skills.contentVersion` + 完整 composite precondition + `txExtra` / description / `versionState` + `advancePhase('db-committed')` | big tx |
| `publishStagedSkillVersion(staged)` | DB 提交后**立即** `unmarkSkillBootVerified` → `swapInStaged(filesDir, publishId)` **从 staging** 原子发布 live → 校验真实目录 + content hash → `cleanupOpDirs` → `advancePhase('fs-published')` + `finishOperation` 释放锁 → 重新 mark verified | ④ |

⚠️ **v3 在这里写错了**：v3 写的是「rename 候选目录到 live」。实测源码
（`skillVersion.ts:555,608`）live 是**从 op-scoped staging** 经 `swapInStaged`（两次同父
rename）发布的，而 `versions/vN/files` 是**永久权威快照**——`reconcileSkillLiveFiles()` 启动时
靠它重建 live、恢复 handler（`skillVersionOp.ts:64`）把 candidate 当**永久前滚源**。把它 rename
走会让 `skillBootVerify` 失败、版本历史读不到 vN、恢复无法前滚。

**必须一并保留的既有语义**：`fs-staged` → `fs-versioned` → `db-committed` → `fs-published` →
`done` 五相；**pre-commit 清理失败保留 op 作恢复 oracle，post-commit 失败绝不回滚**。

### 2.5 插件安装失败的精确清理（设计门 A1-3）

**已核实**：`installPlugin`（`pluginInstaller.ts:174`）在 npm 失败时直接
`throw new PluginInstallFailedError`（`:251-254`），调用方拿不到 `InstallResult.generationDir`，
而清理函数只接受成功结果；通用 GC 要等 24h 且**只要存在任一非终态 node run 就完全不清理**
（`pluginGenerationGc.ts`）。于是「持续有 `awaiting_human` 任务 + 反复导入坏 spec」会无限
积累目录。

**v3 的修法不够**（R3）：把目录挂到抛出的错误上，只能处理「函数正常抛回调用方」。
`installPlugin` 在**内部**生成 generation ULID 并 mkdir（`pluginInstaller.ts:188`），若进程在
mkdir 之后、返回或抛错之前被 `SIGKILL`，journal 里什么都没有，启动收敛只看得到 pluginId、
无法安全删除其中某一个精确 generation。

**正确修法是 record-before-act**：由**调用方预铸** generation / op id，**先把精确路径写进
journal artifacts**，再调 `installPlugin(pluginId, spec, { generationId })`。这样任何时刻
崩溃，journal 里都已经有可删除的精确路径。

---

## 3. intent：本 RFC **不迁移**（决策 26）

`applyIntentChangeset` 与 `intent_apply_journal` 原样保留，本 RFC 不碰它的生命周期，因此
**没有新旧 journal 并存问题**（R3 的 F-journal-coexistence 随范围收缩消失：跨表幂等、
in-flight 排他、session mutation guard、详情读取全都不受影响）。

唯一交集是 §2.4 的三段技能内核。它本就要为配置包建；建好后 intent 自己那条路径也能调用，
于是可以顺带解开 `copyOnlyTargetsFor`（`applyChangeset.ts:135`）里这一句：

```
if (op.resourceType === 'skill' || op.resourceType === 'plugin') {
  out.set(op.target, 'in-place update for this resource type is not supported yet')
```

**这是 intent 的能力扩张**（决策 27，AC-K1/K2）：自己拥有的 skill / plugin 从「只能 copy」
变成「可原地更新」。**外部 owner 的判据一字不动**——那段紧随其后的 `ownerUserId` 检查仍然把
他人资源强制为 copy，既有 copy 语义（slot derivation / copy rewiring / finalName / receipt
`fromCopy`）逐条保持。测试双向锁：自己的技能原地更新成功、他人的技能仍强制 copy。

**后续迁移 RFC 的前置条件**（写在这里供接手者参考）：§2.1 的三个事务钩子必须真正可用；
§2.2b 表里标「intent 特有」的两条（resolve 期的 slot/secret/finalName/copy-only 校验、
session mutation 409 守卫）要么留在 intent adapter、要么进 provider；MCP update 的 OAuth
carry-forward（`applyChangeset.ts:545`：模型不许输出 OAuth，apply 前把 existing OAuth 合并
回去）**不能**成为引擎默认——包的 overwrite 里「无 OAuth」可能是有意删除，必须由 intent
translator 在构造 bundle 前补齐。

## 4. 配置包 · 导出

`services/resourcePackage/export.ts`。流程：

```
loadRoot(actor, type, id) → assertExactRevision（AC-12，仅根）
  → walkClosure（纯函数，BFS + visited 去重去环）
  → 三道门（§4.1）
  → 序列化成 ResourceBundle（分配 local slug）+ 收集 requirements / builtins / secrets
  → buildManifest + buildReadme → assertWithinLimits → encodeZip
```

### 4.1 三道门

| 门 | 判据 | 失败 |
|---|---|---|
| **行级可见性**（读侧唯一） | 闭包内每个 id 域资源对 actor 可见，含传递依赖 | 422 `package-export-ref-unavailable`（AC-7 / AC-34） |
| **特权节点**（内容侧，分轴） | `lens.scripts && 含脚本节点` / `lens.codeHost && 含代码平台节点` 各自独立 | 422 `package-privileged-node-forbidden`（AC-8） |
| **体积** | `SKILL_ZIP_LIMITS` 四维 | 422 并点名资源与维度（AC-11） |

**显式不做第四道门**（决策 24 / AC-7d）：不逐类校验 `*:read`。用户原则「可见即有读权限」
——`isVisibleRow` 的 owner/public/grant 判定本身就是读权限模型；类型级权限点管的是「能不能
走这一类的列表/详情路由」。测试用**反向锁**钉住（可见但缺该类型权限点 → 必须导出成功），
防止未来有人以「补齐权限校验」为由把门加回去。

> 如实记录：这意味着缺 `mcps:read` 的 PAT 能通过导出间接读到该 MCP 的**非密钥**配置。缓解：
> ① 该 MCP 必须对令牌所属用户 ACL 可见才进闭包；② 密钥字段全部已脱敏（§4.2）。

### 4.2 脱敏必须产出 **schema-valid** 的文档（设计门 D1）

**已核实的反例**：`projectMcpForDump`（`intentSecretSlots.ts:85`）产出
`oauth: '‹redacted›'`（**字符串**），而 `McpRemoteConfigSchema`（`schemas/mcp.ts:135`）要求
`McpOAuthConfigSchema | false`；它还把 argv 改成 `‹redacted›-arg-N`、删掉整个 URL query。
那是给模型看的**展示投影**，**不是可导入投影**——直接复用会同时造成密钥泄漏面错配、合法
配置丢失、导入 schema 解析失败三种后果。

因此本 RFC 自建 `packages/shared/src/bundle/secrets.ts`，但**复用它的载体知识**：

| 载体 | 处理 | 借用 |
|---|---|---|
| MCP `config.env.*` / `headers.*` | 值 → `PACKAGE_SECRET_PLACEHOLDER`，键保留 | — |
| MCP `oauth.clientSecret` | 值 → 占位符，**`oauth` 仍是对象** | — |
| MCP `command[1..]`（argv 内嵌 token） | 只替换命中 `SECRET_KEY_RE` / 高熵的**那一个 token**，argv 结构与长度不变 | `SECRET_KEY_RE` / `looksHighEntropy` |
| MCP remote `url` 的 userinfo / 敏感 query 值 | 只替换值，**URL 仍是合法 http(s) URL** | `redactUrlForDump` 的 userinfo 判定逻辑 |
| plugin `spec`（含凭据的 git URL）/ `options` | 同上；`requirements.pluginSources.spec` 走同一条 | 同上 |
| agent `frontmatterExtra` / 工作流 passthrough | `SECRET_KEY_RE` 命中的值 → 占位符 | `maskFreeJsonSecrets` 的键判定 |
| 脚本节点 `env` | 值 → 占位符 | — |
| **兜底扫描** | `scanForCredentialPatterns` + `looksHighEntropy` 命中 → **同样替换成占位符**并记进 `manifest.secrets` | 该函数本体（v2 误以为它会改值，实际只返回 finding） |

**硬性回归**：每个 portable 文档在脱敏**之后**必须仍能通过它自己的严格 schema——测试对六类
逐条断言（AC-6）。**枚举字段绝不脱敏**（RFC-270 教训）。

### 4.3 name 域引用（设计门 C1 已堵上，AC-7c 本轮修正）

| 情况 | 行为 |
|---|---|
| 零匹配行 / 有行但全部不可见 | **逐字节相同**的 dangling 结果（堵预言机） |
| 有可见候选 | **与 `freezeCallClosure`（`execution/closure.ts:142-219`）逐字一致**：`workflowId` cache 优先（且该行仍带该选择器名字），其次最老可见 ULID |

⚠️ v2 写的是「总选最老可见行」，**与运行时不符**（设计门 E1-1）：节点若指向同名新行 W2 而另有
更老的 W1，现网启动的是 W2，v2 的导出却会导出 W1——包与实际执行的闭包不是同一个。

---

## 5. 配置包 · 导入

### 5.1 两步式

```
POST /api/resource-packages/preview   multipart: file                  → PackagePreview
POST /api/resource-packages/commit    multipart: file + decisions(JSON) → PackageImportReport
```

前端持有文件传两次（与技能 zip 导入同姿势），无服务端暂存态。**两次之间靠两个字段绑定**
（R3）：

- **`importId`**（AC-24e）：preview 下发的稳定幂等键，decisions / CLI plan 原样回传，作为
  引擎的 `idempotencyKey.key`。没有它，commit 成功但响应丢失后重传同一个 zip 会**再建一遍
  资源**——服务端每次新生成 id 等于没有幂等。
- **`packageDigest`**（AC-24d）：包内容的规范化摘要，preview 下发、decisions 回传、commit
  对重新上传的字节比对。没有它可以 preview 文件 A（普通 agent 节点）、commit 上传文件 B
  （同 slug 同 name 同 expect，但 definition 换成脚本节点）——服务端重算权限也证明不了用户
  确认的是 B。CLI `--plan` / `--apply` 同理。

### 5.2 预检

每条产出：`localSlug` / `type` / `name` / `ownMatches[]`（可能多个，AC-14b）/ `otherMatches[]` /
`allowedActions` / `defaultAction` / `suggestedName` / `missingPermissions` / `secretFields` /
**`expect`（内容级 token，AC-24b：由 preview 下发、由 decisions 原样回传）**。

v2 复用 `ImportRefCandidate` 是不够的——它只有 `id/owner/visibility/aclRevision`，没有内容
token；commit 若现场重读只会拿新值与新值自比，等于没有 CAS。

### 5.3 提交 = 翻译成 Bundle + 调引擎

决策表 → `ResourceBundle` 的**完整规则**（R3 指出 v3 这段有两个洞）：

| 决策 | 产生 | 指向它的引用怎么改 |
|---|---|---|
| `reuse` | **不产生 op** | 全部改写为 `external:<选定的本地 id>` |
| `new` | create op（带 `local:<slug>`） | 保持 `local:<slug>` |
| `overwrite` | update op（external `target` + `expect`） | **也要改写为 `external:<目标 id>`** —— v3 只写了 reuse 的改写，漏了这条：包里 agent A 被 overwrite、workflow W 引用 A 时，A 不再是 create op，W 的 `local:A` 没有 slug 可绑 |

两个边界：

- **`ops` 可以为空**：只有一个 agent 的包、目标已有同名且选 `reuse` ⇒ 零 op。
  `BundleSchema` 因此**不能**要求 `.min(1)`；引擎对空 bundle 走 **no-op 成功路径**
  （journal 直接 committed + 空 receipt），不是报错。
- **`rootRef` 可以指向 external**：根被 reuse / overwrite 时它没有 create slug。

A1 / A3 / B1 / B3 / A2 因此**不是被修好，而是不存在了**——那些都是引擎的属性。

### 5.4 owner 断言必须在最终事务里（设计门 E1-2 / 决策 25 / AC-15b）

**已核实**：`commitMcpUpdateInTx`（`mcp.ts:180`）只校验 `expectedConfigHash`，**不校验
owner**；owner 门在路由层 `routes/mcps.ts:375` 的 `requireResourceOwner`。插件同构
（`plugin.ts:409` / `routes/plugins.ts:56`）。

导入提交是**一条不经过那些路由的新写路径**，所以那道门不会被执行。若 commit 只做「内容 CAS +
ACL fence」：

1. Bob 有一个 **public** MCP `github`。Alice 能看见它（public），预检响应里**本来就带着**
   它的 id（要展示「本地已有同名候选」）。
2. Alice 把提交里那一条的 `action` 从 `reuse` 改成 `overwrite`（F12 或 curl，一个字段值）。
3. 内容 CAS 过（Bob 没动过，hash 对）、ACL fence 过（public，看得见）→ **UPDATE 执行**。
4. 结果：**同一行、同一个 id、owner 仍是 Bob**，但 `command` / `env` / `url` 变成 Alice 的。
   没有新行产生，任何「同名优先级」规则都不会介入；Bob 界面上看还是他自己的 MCP。若是
   local stdio MCP，`command` 被改写意味着 **Bob 的任务会执行 Alice 指定的可执行文件**。

**两道修法，缺一不可**：

- **服务端重算 `allowedActions`**：客户端传来的动作只是意向，commit 用与预检同一份纯函数
  重新推导一遍。UI 不是边界。
- **最终事务内断言 owner**：对每个 update 目标在 big tx 里断言
  `row.ownerUserId === actor.user.id`。放在事务里而非之前，是因为「检查」与「写入」之间
  权属可能变（转移 / 改私有）——这就是「线性化」的含义。

这不是新规则，是把决策 4（「覆盖只能覆盖自己的」）在新写路径上补齐。引擎层实现，
**intent 侧同样受益**。

---

## 6. 路由 · CLI · 前端

### 6.1 路由

| 方法 | 路径 | 权限 | tokenAccess |
|---|---|---|---|
| GET | `/api/{六类}/:id/export-package` | 对应 `*:read` | `'allow'` |
| POST | `/api/resource-packages/preview` | **仅身份准入**（无资源类型点） | `'allow'` |
| POST | `/api/resource-packages/commit` | **仅身份准入** + §5.2 逐条动态判据 | `'allow'` |
| ~~GET~~ | ~~`/api/workflows/:id/export`~~ | — | 下线（C1） |
| ~~POST~~ | ~~`/api/workflows/import`~~ | — | 下线（C2） |

⚠️ **路由门不能挂六类 `*:read` 的 AND**（R3）：那会与「逐条权限预检」自相矛盾——只有 agent
读/建权限的用户导入一个无依赖的单 agent 包，会在 middleware 直接被拒、根本看不到
`missingPermissions`。资源类型权限**按包内实际条目动态计算**（AC-30c）。

`TokenAccess` 合法值是 `'allow' | 'never'`（`registry.ts:62`）；`'never'` 只为 RFC-247 的 D6
（令牌不得再签令牌）与 D5（令牌不得改 owner/grants/visibility 的四种 URL 形态）存在，创建
资源不在其列，六类 create 端点全是 `'allow'`。**不新增权限点**（目录保持 67）。

### 6.2 CLI

```
agent-workflow export-package --as-user <u> (--id <id> | --type <t> --name <n> [--owner <u2>]) -o <file>
agent-workflow import-package <zip> --as-user <u>
        [--plan | --apply <plan.yaml>] [--on-conflict reuse|new|fail] [--dry-run]
```

两条都必须 `--as-user`（导出的 ACL 可见性与分轴特权门都需要 Actor）。**导出支持 `--id`**
（AC-26b）：工作流名不是 identity，同一 owner 可以有两个都叫「审计」的工作流
（`rfc264-unicode-names.test.ts:101` 锁住该行为），`--type --name` 选不中；二义时列候选并
要求 exact id。文档写明：**能访问
appHome / SQLite 的本机操作者本身就是 break-glass 管理员**，`--as-user` 是归属声明而非身份
认证。

### 6.3 前端

导出：六类详情/编辑页「更多操作」各加一条；工作流那条由「导出 YAML」原地改名。
导入：新 `components/ResourcePackageImportDialog.tsx`，`<Dialog size="full">` + `.segmented` +
`<Select>` + `<Field>/<TextInput>` + `<StatusChip>`，**零自写 chrome**。六类列表页各一个入口
+ 统一入口 + 类型不符自动跳转。

---

## 7. 数据与迁移

- 新表 `resource_bundle_applies`（journal，泛化自 `intent_apply_journal`）+ 一个迁移。
- **`intent_apply_journal` 一字不动**：intent 不迁移（决策 26），继续用它自己那张表与收敛器。
  因此**没有跨表幂等 / in-flight 排他 / session guard / 详情读取的并存期问题**——R3 的那条
  P1 随范围收缩自然消失，而不是被「修好」。
- 无其它 schema 变更、不新增权限点。

## 8. 失败模式

| 场景 | 行为 |
|---|---|
| 闭包内 id 域资源不可见（含传递） | 422 + 明确提示 |
| name 域零匹配 / 全不可见 | 逐字节相同的 dangling |
| name 域有可见候选 | 与 `freezeCallClosure` 逐字一致的解析 |
| 特权节点缺对应权限 | 422，分轴 |
| 超体积 | 422 并点名 |
| pre-stage 失败 | 各内核自补偿 + 插件 generation 精确删除 + journal → failed |
| big tx 失败 | SQLite 回滚 + 逆序补偿 |
| 进程被 SIGKILL | 启动收敛（带 active set + 10min 下限） |
| 重复提交同 idempotencyKey | 返回**原 receipt**，不重跑 |
| 并发导入同目标 | 内容 CAS 409 + 技能 op 锁 409 |
| **伪造 overwrite 他人资源** | **最终事务内 owner 断言拒绝**（§5.4） |
| `formatVersion` 更高 | 拒绝 |
| 包内未登记文件 | 422 `package-unlisted-entry` |
| 技能文件树里的硬编码密钥 | 不扫描、原样入包（决策 18，文档写明作者责任） |

## 9. 测试策略

### shared
- `bundle-ref.test.ts`：`local:` / `external:` 正反例；裸 id / 裸 name 被拒。
- `bundle-schema.test.ts`：重复 slug、悬空引用、悬空 `rootRef` 全拒（AC-4b）。
- `bundle-payload.test.ts`：六类 payload round-trip。
- `bundle-secrets.test.ts`：**逐 carrier** 验证 + **脱敏后仍过各自严格 schema**（AC-6，
  专门锁住 `oauth` 不得变成字符串、argv 结构不变、URL 仍合法）。
- `package-closure.test.ts`：六类根 × 九形态矩阵。

### backend
- `rfc271-bundle-engine.test.ts`：AC-B4 全部不变量（幂等重放返回原 receipt、active
  lease、bundleCreatedNames、pre-stage 不可见、逆序补偿、启动收敛注入中断）。
- `rfc271-bundle-owner-gate.test.ts`：**AC-15b 越权对照**——伪造 `overwrite + 他人 public
  资源 id + 正确 hash`，断言最终事务拒绝；且服务端重算的 `allowedActions` 不含 overwrite。
- `rfc271-skill-update.test.ts`：AC-25b——两个技能覆盖 + 第三个 op 失败，断言**两个技能都
  没被改**；导入后技能过 `skillBootVerify`。
- `rfc271-export-gates.test.ts`：AC-7 / AC-34 / **AC-7b 逐字节对照** / AC-7c（cache 优先，
  不是总选最老）/ **AC-7d 反向锁** / AC-8 分轴正反例 / AC-11。
- `rfc271-import-preview.test.ts`：AC-14 / AC-14b / AC-15 / AC-17 / AC-19 / **AC-24b
  token 下发与回传**。
- `rfc271-import-commit.test.ts`：AC-20 / AC-20b / AC-21 / AC-22 / AC-24 / AC-24c。
- `rfc271-package-antitamper.test.ts`：AC-2 / zip slip / 超深目录。
- `rfc271-routes.test.ts`：AC-30 / AC-30b / AC-31。
- `rfc271-cli.test.ts`：AC-26~29。
- **`rfc271-intent-skill-update.test.ts`**：AC-K1/K2——自己拥有的 skill/plugin 原地更新成功、
  他人拥有的仍强制 copy（既有 copy 语义 slot/rewiring/finalName/`fromCopy` 逐条保持）。

### frontend
- `rfc271-export-actions.test.tsx` / `rfc271-import-dialog.test.tsx` /
  `rfc271-capability-removal.test.ts`（C1–C3 源码层文本断言）。

### 显式改判的既有断言

| 文件 | 改判 | 原因 |
|---|---|---|
| `workflow-draft-export.test.ts` | 删本地草稿导出用例 | C3 |
| `workflow-import-dialog.test.tsx` | 整文件删除 | C2 |
| `workflows-pages.test.tsx` | 「导出 YAML」文案 | C1 |
| `rfc199-workflow-exact-operations.test.ts` | export hook 指向新端点 | C1 |
| `rfc243-call-refs-yaml.test.ts` | 迁到包导出 | C1 |
| RFC-270 的 export 出口用例 | 「遮蔽后可导出」→「按轴拒绝」 | C4 |
| **intent 测试套** | 仅 `copyOnlyTargetsFor` 的 skill/plugin 分支相关用例改判 | 决策 27 的能力扩张；其余零改判 |

⚠️ `route-error-code-coverage` 用 `git ls-files` 枚举，未追踪的新文件对它是盲的——新增文件
多，落地时先 `git add -N` 再跑门禁。

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 决策 27 误伤 intent 既有 copy 语义 | AC-K2 双向锁；`ownerUserId` 判据一字不动 |
| 泛化时丢掉某条既有不变量 | `rfc271-bundle-engine.test.ts` 逐条点名；泛化前把 `applyChangeset.ts` 的不变量列成清单对照 |
| 新旧 journal 并存期语义分裂 | 旧表只读收敛存量、新 apply 一律写新表；旧表删除留给后续 RFC |
| `skill-update` 拆两段引入回归 | 既有 `commitSkillVersion` 保留为两段的顺序组合，其它调用方零改动 |
| 盘子过大一次推不动 | §PR 拆分：表达层 → 引擎 → intent 迁移 → 导出 → 导入 → 前端/CLI → 下线，逐个独立可绿 |

## 11. 两轮设计门 findings 落点

| 轮次·编号 | 落点 |
|---|---|
| R1-A1 / R2-A1 无可见性屏障、journal 不同构 | §2.2 复用既有生命周期 + 幂等键 + active lease |
| R1-A2 / R2-A2 fence 只锁 ACL | §1.3 `BundleExpectToken` + §5.2 由 preview 下发回传（AC-24b） |
| R1-A3 / R2-A3 绕过技能/插件持久化协议 | §2.4 `skill-update` 两段拆分 + §2.5 插件失败精确清理 |
| R1-B1 / R2-B1 包内无稳定身份 | §1.1 `BundleRef` + 显式分配 slug + schema 拒重复/悬空 |
| R1-B2 project 技能无处承载 | `requirements.projectSkills` |
| R1-B3 / R2-B3 环形与拓扑序 | §2.3 `bundleCreatedNames` |
| R1-C1 存在性预言机 | §4.3（R2 确认已堵上） |
| R1-C2 特权门未按轴 | §4.1（R2 确认已堵上） |
| R1-C3 CLI 无 Actor | §6.2（R2 确认已堵上） |
| R1-D1 / R2-D1 脱敏面与投影语义 | §4.2 自建 schema-valid 投影 + 复用载体知识 |
| R1-D2 技能文件树密钥 | 决策 18 明确划出范围（R2 确认已堵上） |
| R1-E1 能力清单 | `proposal.md §5` 六条 |
| R2-E1-1 workflowId cache 优先 | §4.3 AC-7c 修正 |
| **R2-E1-2 伪造 overwrite 越权** | **§5.4 服务端重算动作 + 事务内 owner 断言** |
| R2 文档一致性（5 条） | v3 重写时统一：字段名、AC 编号、C 编号、条数 |
