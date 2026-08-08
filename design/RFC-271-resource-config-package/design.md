# RFC-271 · 技术设计 v4

配套 `proposal.md`。锚点为本仓当前源码。

**v4 相对 v3 的范围变更（决策 26）**：表达层与引擎照建，但**本 RFC 只给配置包这一个消费者**；
**intent 不迁移**（`applyIntentChangeset` 与 `intent_apply_journal` 原样保留）。引擎的
provider 接口预留事务钩子，使后续 RFC 迁 intent 时不必重构引擎。唯一与 intent 的交集是
§2.4 的四段技能内核——它本就要为配置包建，建好后顺带解开 intent 的 skill/plugin 原地更新
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
   **核实为 14 条**（`invariants.md` I1–I14，11 条归引擎），泛化时**一条都不许丢**——开工前先列清单
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

### 1.1 统一引用模型 `ResourceRef`（决策 29）

> **用户观察（2026-08-08）**：「调度器的节点选择器和统一资源建模应该是一套东西。」
> 核实属实——「怎么指向一个资源」这一个概念，仓里有**六套各自为政的实现**：

| # | 机制 | 用在 | 今天的形态 |
|---|---|---|---|
| 1 | `node.agentId` **裸字段读** | scheduler 派发：`scheduler.ts:5187` / `:6943` / `:6997` / `:7226` **四处各读各的** | id |
| 2 | `workflowName` 权威 + `workflowId` cache | `freezeCallClosure` | name + id cache |
| 3 | `agents.skills[] / mcp[] / plugins[] / dependsOn[]` | runner 组装 config | id 数组（skills 是判别联合） |
| 4 | `IntentRef` | intent 的模型 wire | `res#<type>#<n>` handle / `$new:<slug>` tempRef |
| 5 | `ImportRefSelector` | agent.md 导入边界 | name + ownerUsername |
| 6 | `BundleRef` | 本 RFC 原方案 | local / external / name |

**这个 session 查出的 bug 有一半根因就在这里**：机制 2 内部就不一致（工作流分支认 id cache、
工作组分支压根不读 `workgroupId` —— 决策 28 修的正是它）；冻结闭包按 **name** 键控而节点带的是
**id**（R6-P1-3）；机制 1 在四处各写一遍，RFC-243 加 wrapper-fanout 时又抄了第五份。

**决策 29：六套合一。** 但合的是**命名与解析层**，不是事务层——这与已被砍回的决策 23
（把 intent 的 apply 引擎迁进来）是两个量级。

#### 1.1a 归一化 AST + 逐域 wire codec（R7-P1-1 修正）

⚠️ **v8 初稿把「归一化」和「wire」混成了一张形态表，那是错的。** 反例三条，各自致命：

1. intent 的 tempRef wire 是 `$new:<slug>`（`intentChangeset.ts:42-56`），bundle 的是
   `local:<slug>`。**同一语义、两种拼写**——选 `$new:` 破坏 bundle，选 `local:` 改 intent
   wire，两个都塞进一个无域 codec 的 schema 又让跨域 parse-fail 失效。
2. `ImportRefSelector` 的 `type` 是**必填且参与稳定 key**（`importRef.ts:25-37`）。我写的
   `{name, ownerUsername?}` 丢了 `type` ⇒ agent.md 里 `{type:'mcp',name:'github'}` 与
   `{type:'plugin',name:'github'}` 会归并成同一个 key。
3. 仓里**已有**另一个宽松的全局 `ResourceRefSchema`（`agent.ts:100-113`），create/import
   wire 还接受名字——「唯一 ResourceRef」这个说法必须先面对它。

**正解**：`ResourceRef` 是**归一化 AST**，各域各有一个 **wire codec**；AST 统一，编码不统一。

```ts
type ResourceRef =
  | { k: 'id';       type: AclResourceType; id: string }
  | { k: 'name';     type: AclResourceType; name: string }
  | { k: 'selector'; type: AclResourceType; name: string; ownerUsername?: string }
  | { k: 'handle';   type: AclResourceType; ordinal: number }
  | { k: 'local';    slug: string }
  | { k: 'external'; token: string }
  | { k: 'call';     ... }            // 见 1.1b
  | { k: 'project-skill'; name: string }   // 见 1.1b'
```

| 域 | wire 编码 | 逐字保留 |
|---|---|---|
| `IntentRef` | `res#<type>#<n>` / **`$new:<slug>`** | ✅ `intentChangeset.ts:42-56` 不动 |
| `BundleIdentityRef` / `BundleCallRef` | **`local:<slug>`** / `external:<token>` / `name:<type>/<name>` | ✅ 本 RFC 新定 |
| `ImportSelectorRef` | `{type, name, ownerUsername?}` **对象**（`type` 必留） | ✅ `importRef.ts` 不动 |
| `RuntimeRef` | 裸 ULID / 判别联合对象（见 1.1b'） | ✅ 存量 definition 与 `agents.*` 不动 |
| `CallRef` | `{nodeId, workflowName, workflowId?}` **复合记录** | ✅ 见 1.1b |

**T6b/T6c 只能 alias 域 codec，不能 alias 单一字符串形态。**

#### 1.1b `CallRef` 是**复合记录**，不是两种互斥形态（R7-P1-3 修正）

`WorkflowCallRef` 的真实形状是 `{nodeId, workflowName, workflowId?}`，注释写着
*name is authoritative, id is a cache*（`workflowCalls.ts:12-17`）。而 `freezeCallClosure`
的判据是**一条复合行为**：id hint 命中**且该行仍带该名字**才用它，否则**回退到最老可见同名行**
（`closure.ts:162-219`）。

```ts
{ k: 'call'; type: 'workflow'|'workgroup'; nodeId: string;
  authoritativeName: string; idHint?: string }
```

可复现（`id | name` 两形态表达不了）：W1 旧 / W2 新、都叫 `audit`，节点存
`{workflowName:'audit', workflowId:W2}`。W2 仍叫 `audit` 时应选 **W2**；W2 被改名后应**回退
W1**。name-only 一开始就错选 W1；id-only 会继续跟着已改名的 W2、也做不出回退。

#### 1.1b' `RuntimeRef` 必须表达判别联合（R7-P1-2 修正）

`agents.skills` 是判别联合：`{kind:'managed', skillId}` / `{kind:'project', name}`
（`agent.ts:115-128`），**project 技能没有 DB row**、runner 按 `m:<skillId>` / `p:<name>`
去重（`scheduler.ts:9276-9290`）、直接按名字透传给 CLI（`:9360-9382`）。

所以 `RuntimeRef = id` 是错的。两条出路，**本 RFC 取第一条**：

- ✅ **typed RuntimeRef**：`{k:'id'}` 承载 managed skill / mcp / plugin / dependsOn / agentId；
  新增 `{k:'project-skill', name}` 承载 project 技能——它**不是平台资源**（无 row、无 ACL），
  但它确实是一个「指向某物」的引用，放进 AST 才能让 resolver 完整、不留 special-case。

  ⚠️ **AST 有了还不够，Bundle 里也得有槽位**（R8-P1-1）。v9 只加了 AST 变体，却仍规定
  agent 的 `skills` 用 `BundleIdentityRef`（只允许 `local:` / `external:`）——而 `external:`
  兜不住：`resolveExternal` 必须按 `AclResourceType` 解析成资源 id，project 技能**恰好没有
  那种行**。净结果是**一个今天完全合法、能跑的代理无法 round-trip**。

  可复现：包里代理 A 引用 project 技能 `repo-lint`、代理 B 不引用。只写全局
  `requirements.projectSkills=['repo-lint']` 会**丢掉 A→skill 这条边**——导入后不给任何代理
  则 A 能力丢失，给所有代理则 B 拿到了它原本没有的能力。

  **修法**：agent 的 `skills` 槽单独一个域 codec

  ```ts
  BundleAgentSkillRef = BundleIdentityRef | ProjectSkillRef
  ```

  `project-skill` **只在这一个槽**合法（其余槽仍拒绝），并保留 `requirements.projectSkills`
  作为**环境要求声明**（导入方要自备该仓内技能），两者不是二选一：边在 payload 里，
  要求在 manifest 里。

  **并规定：T1 的三个 Bundle schema 是 T6a 域 codec 的 alias / re-export，不是第二套
  parser。**（否则「归一化」在自己 RFC 内部就分叉了。）
- ❌ 宣布 project 技能是「非资源 requirement」并退出「唯一 ResourceRef」承诺——那等于把
  归一化打了个洞，而洞正好在 runner 组装 config 的路径上。

#### 1.1c 解析契约（这才是合并的实质）

只统一「引用长什么样」是个空壳——运行期的解析带着三条 authoring 侧没有的属性，必须一并进
契约，否则合出来的东西表达不了 `freezeCallClosure`：

| 属性 | 含义 | 谁需要 |
|---|---|---|
| **freeze** | 启动时快照，之后对该任务终身不变（`tasks.refClosureJson`） | CallRef |
| **launch-ACL** | 可见性按**启动者**判定，而非保存者 | CallRef |
| **dangle** | 保存时允许解析不到，启动才 fail closed | CallRef 的 `name` 形态 |

**三条静态属性不够**（R7-P1-5）。同一个 ref、同一个域，行为仍随**调用目的**而变：

- `resolveDependsClosure` 默认 missing 硬失败，但 tolerant UI preview 传 `allowMissing:true`
  就静默跳过（`agentDeps.ts:8-13,40-46`）——一条域级 `dangle` 表达不了。
- **scheduler 四处的失败归属根本不同**：主 `agent-single` 直接返回
  `agent-identity-missing` / `agent-not-found`（`:5187-5200`）；而 wrapper-fanout 的 inner
  节点先在 hydration 里**跳过**缺失 ref（`:6982-7002`）、shard source 为空时 wrapper 仍
  **成功**（`:7135-7149`）、source 非空才把 wrapper row 标 failed（`:7192-7242`）。
  ⚠️ 我 v8 写的源码清单也不准：`:7226` 是 `markWrapperTerminal`，真正的读取在
  `fanoutInnerAgentKey`（`:6939-6944`）与调用点 `:7224`。

若统一 resolver 在这些位置直接 `throw`，`runScope` 没有局部 rejection 映射
（`:1629-1654`），异常会被归成**任务级** `"scheduler error"`（`:713-788`）——原本的
node / wrapper 级失败归属**整个丢掉**。

```ts
interface RefResolution<T> {
  // 域级静态属性
  freeze: 'per-task' | 'none'
  aclAt: 'launch' | 'save' | 'none'
  // 调用级：同域不同目的行为不同
  purpose: 'dispatch' | 'validate' | 'preview'
  onMissing: 'fail' | 'skip' | 'dangle'
  failureOwner: 'node' | 'wrapper' | 'task' | 'caller'
  /** parse 与 resolve 分开；resolve 返回 typed Result，**不 throw** ——
   *  各调用点自己把 Result 映射成它原有的错误码与 node_run 归属。 */
  resolve(ref: ResourceRef, ctx: ResolveCtx): Promise<RefResult<T>>
}
```

**硬性要求**：合并后各调用点的**错误码、空 source 行为、node_run 归属逐条不变**——这四处
不是「看起来一样」，是实测不同。批次 A′ 要为四处各留一条归属回归。

`freezeCallClosure` 因此不再是一份独立实现，而是 `CallRef` 域的 resolver 实例——决策 28 的
「id 优先 + 按节点键控」就落在这一处，不用在别处再抄一遍。

#### 1.1c' 决策 28 落在 `CallRef` resolver 上（含 R7-P1-4 修正）

**背景**：`freezeCallClosure` 的工作组分支只收 `workgroupName`、按名取最老可见行，
`workgroupId` **从头到尾没被读过**（`closure.ts:269-309`）；而冻结**结果**本身也是按名字
键控的，同名两节点因此落到同一条。这个冲突状态**今天用普通编辑器就能造**——
`CallWorkgroupEdit.tsx:133` 已在写 `{workgroupName, workgroupId}` 并专门处理同名候选。

**用户决策 28**：跑我选的那个，且同名两节点各自生效。落法：

| 项 | 内容 |
|---|---|
| 判据 | 与工作流分支同构：id hint 命中**且该行仍带该选择器名字**才用，否则回退最老可见行。即 §1.1b 的复合 `CallRef` 语义，**不在别处再抄一份** |
| 形状 | **`Record<sourceScopedKey, FrozenXxxRef>`**，key = `` `${sourceWorkflowId}#${nodeId}` ``。⚠️ **不能只用 nodeId**（R7-P1-4）：节点 id 只在**单份 definition 内**唯一（`workflow.validator.ts:574-588` 只查单份内重复），传递闭包里两个不同工作流都用 `call-1` 是合法的，扁平 `Record<nodeId,…>` 必有一条被覆盖 |
| 消费者 | **五处**（R8-P1-2；v8 写两处、v9 写三处，都少了）——见下表 |
| 存量兼容 | `parseCallClosure` 带 `closureVersion` 判别，无该字段即 v1 name-keyed；**三个消费者全部双读** v1/v2 ⇒ 存量任务零影响、零迁移 |
| 快照 | grants + workgroup row + member rows 必须在**同一个 `dbTxSync`** 里读（R6-P2-1），否则「判据通过时它还叫 audit、冻结的却已改名」 |
| **归属** | 完整落在**批次 A′ 的 T6e**。⚠️ v8 里 T17b 与回滚说明把它归批次 C，与「scheduler 热路径独立可回滚」自相矛盾，已移除重复所有权 |

#### 1.1c'' 边身份契约：`resolveEdge(sourceWorkflowId, CallRef)`（R8-P1-2）

**只换 `Record` 的 key 兑现不了 C7。** 图上的每一条 call 边都要能被独立定位，而现在有两条
生产路径仍在**按名字折叠**：

| # | 消费者 | 现状 | 必须改成 |
|---|---|---|---|
| 1-2 | `scheduler.ts:2966-2968` 主消费 ×2 | 按 name 取 | 按 `sourceWorkflowId#nodeId` |
| 3 | `childClosureSubset`（`closure.ts:103-131`） | 只收 definition、内部按 name BFS | 收 `sourceWorkflowId`，按边遍历。调用点已持有 `frozen.id` 却没传（`scheduler.ts:3732,3811,3851`） |
| **4** | **`detectCallCycles`（`workflowCalls.ts:88-101`）** | resolver 签名是 **`(name: string)`**，把 `nodeId` 与 `workflowId` **整个丢掉** | 签名收完整 `CallRef` + source id——否则**表示不了「同名两条指向不同目标的边」** |
| **5** | **`loadCallWorkflowClosure`（`workflow.validator.ts:207-255`）** + 其消费点（`:563-571` / `:830-840` / `:2709-2719`） | 按 name 取**最老行** | 采用与启动**同一条** id-hint-first 判据 |

**第 5 条是硬约束，不是可选项。** 该函数的注释写明了一个不变量：

> *Duplicate names resolve DETERMINISTICALLY: oldest row wins — **the exact rule
> freezeCallClosure applies, so editor preview and launch bind the same row.***

决策 28 把启动改成 id 优先，**就破了这条不变量**——除非 validator 一起改。不改的后果可复现：
W1（旧）/ W2（新）都叫 `audit`，根 R 有 `c1={name:'audit',idHint:W1}`、
`c2={name:'audit',idHint:W2}`；W1 输出 `old`、W2 输出 `new` 且 W2 回调 R。启动会为 `c2`
冻结 W2，而 validator 固定读 W1 ⇒ **对 `new` 端口报错**、且**看不见 W2→R 这个环**。

**统一契约**：所有图操作走 `resolveEdge(sourceWorkflowId, CallRef)` —— 冻结生成、cycle
walk、child subset、validator / 端口推导五处同源。source id 在两层都是现成的：根层
`task.ts:138-151` 已经把 `root.id` 传给冻结器，子层调用点持有 `frozen.id`，**只是没写进
helper 签名**。

回归必须含：「同名双 id、其中一支成环」与「同名双 id、端口不同」两条。

⚠️ 仍是**执行期行为变更**（C7）：无冲突时目标从「最老可见行」变成「你当初选的那个」；
有冲突时两节点从「都跑同一个」变成「各跑各的」；**编辑器预览的绑定规则同步改变**。

#### 1.1d `local:` 的稳定性

slug 由**导出侧显式分配并写进 manifest**，不是从声明顺序派生的序号（设计门 B1）；
`BundleSchema` 拒绝重复 slug、拒绝悬空引用、拒绝悬空 `rootRef`。

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

// ⚠️ 这是**规范代码**（R4-P1-4）：必须是 12 分支 discriminated union，不能是一个
//    optional 字段全开的对象。反例：{kind:'mcp-update', target, payload} 不带 expect
//    能通过宽松 schema，而 commitMcpUpdateInTx(mcp.ts:180) 只在 expect !== undefined
//    时 CAS ⇒ 无栅栏覆盖。
const createOp = <K extends string, P extends z.ZodTypeAny>(kind: K, payload: P) =>
  z.object({
    opId: OpIdSchema, kind: z.literal(kind),
    slug: BundleSlugSchema,                       // 必需
    target: z.never().optional(),                 // 禁止
    expect: z.never().optional(),                 // 禁止
    payload,
  }).strict()

const updateOp = <K extends string, P extends z.ZodTypeAny, E extends z.ZodTypeAny>(
  kind: K, payload: P, expect: E) =>
  z.object({
    opId: OpIdSchema, kind: z.literal(kind),
    slug: z.never().optional(),                   // 禁止
    target: BundleExternalRefSchema,              // 必需，且只许 external
    expect,                                       // 必需，且是该类型专属 token
    payload,
  }).strict()

export const BundleOpSchema = z.discriminatedUnion('kind', [
  createOp('agent-create', BundleAgentPayloadSchema),
  updateOp('agent-update', BundleAgentPayloadSchema, AgentExpectSchema),
  createOp('skill-create', BundleSkillPayloadSchema),
  updateOp('skill-update', BundleSkillPayloadSchema, SkillExpectSchema),
  createOp('mcp-create', BundleMcpPayloadSchema),
  updateOp('mcp-update', BundleMcpPayloadSchema, McpExpectSchema),
  createOp('plugin-create', BundlePluginPayloadSchema),
  updateOp('plugin-update', BundlePluginPayloadSchema, PluginExpectSchema),
  createOp('workflow-create', BundleWorkflowPayloadSchema),
  updateOp('workflow-update', BundleWorkflowPayloadSchema, WorkflowExpectSchema),
  createOp('workgroup-create', BundleWorkgroupPayloadSchema),
  updateOp('workgroup-update', BundleWorkgroupPayloadSchema, WorkgroupExpectSchema),
])

export const BundleSchema = z.object({
  bundleVersion: z.literal(1),
  /** ⚠️ **允许为空**（R4-P1-3）：全 reuse 的包翻译结果就是零 op。 */
  ops: z.array(BundleOpSchema).max(BUNDLE_MAX_OPS),
  /** 该 bundle 的「主角」。可以是 local slug（新建/副本），**也可以是 external**
   *  （被 reuse / overwrite 时它没有 create slug）。 */
  rootRef: BundleRefSchema.optional(),
  /** rootRef 是 external 时，receipt 需要它才能报出根的类型（external token 不自带 type）。 */
  rootType: AclResourceTypeSchema.optional(),
}).strict().superRefine(assertBundleRefsClosed)
```

`assertBundleRefsClosed` 拒绝：重复 slug、悬空 `local:` 引用、`rootRef` 指向不存在的 slug
（**external 形态的 rootRef 不算悬空**）、`rootRef` 为 external 但缺 `rootType`、
`name:` 出现在 call 目标槽之外的槽位（R4-P2-9）。

**槽位分层**（R4-P2-9）：不存在一个「全局都能用」的 `BundleRefSchema`。三个子 schema：

| 子 schema | 允许形态 | 用在 |
|---|---|---|
| `BundleIdentityRefSchema` | `local:` \| `external:` | agent 的 `dependsOn` / `mcp` / `plugins` / `skills`，工作组成员，工作流 `agentRef` |
| `BundleCallRefSchema` | `local:` \| `external:` \| **`name:`** | 仅 `call-workflow` / `call-workgroup` 的目标槽 |
| `BundleExternalRefSchema` | 仅 `external:` | update op 的 `target` |

⚠️ 正式 `WorkflowNodeSchema` 是 `.passthrough()` 的宽松形态（`schemas/workflow.ts:105-131`），
**靠它自动得不到 call-slot 限制**——必须显式 walker/refine，并配负例测试
（在 `dependsOn` 里放 `name:workflow/audit` → parse 失败）。

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
  /** 幂等身份（namespace + key）。package: (scope:'package', key:importId)。
   *  **必须由客户端持有并重放** */
  idempotencyKey: { scope: string; key: string }
  /** ⚠️ **串行键，与幂等 namespace 是两回事**（R5-P2-E）。源码按 `sessionId` 串行
   *  （`applyChangeset.ts:201` `withSessionApplyLock`）——即**按资源实例**，不是按命名空间。
   *  package 若直接拿 `scope:'package'` 当串行键，所有导入会全局串行：Alice 一个慢 npm
   *  安装会堵住 Bob 完全无关的纯 agent 包。粒度由 provider 自己定（建议按目标资源集合）。 */
  serializationKey: string
  /** 解析 external ref → 本地资源 id（+ 类型校验）。`name:` 形态不经过这里。 */
  resolveExternal(ref: string, expectType: AclResourceType): Promise<string>
  /** 技能文件载体：package 从 zip 取。 */
  readSkillFile(ref: string): Uint8Array
  /** 执行身份。owner 归属与全部授权判据都从它出。 */
  actor: Actor

  // ── 事务钩子（AC-B4b）。⚠️ **不是全部留空**：package provider 必须实现
  //    `revalidateInTx` 来执行 §5.3 的 selectedExternalFence（reuse 目标的内容复核）。
  //    `claimInTx` / `finalizeInTx` 本 RFC 留空，它们存在的理由是让后续 RFC 能把
  //    intent 的 session 原子性迁进来而不重构引擎。
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
             ↳ 重复提交按 **I3 三态**处理（`committed` → 返回原 receipt；`failed` → 409；
               `prepared`/`applying` → 409 未结）。**不是「总是返回 receipt」**
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

**已完成**：`invariants.md` 是 2026-08-08 逐条读源码核实的完整清单（**14 条**，含锚点与原文
引用），**不是转述注释**。批次 B 落地后按其末尾的对照表逐条打勾。

它当场查出：**14 条里 11 条归引擎**，而初稿**只有 1 条（I5 pending seams）是完整的**——
I1 / I3 / I8 完全没写，I2 / I4 / I6 / I7 / I9 写了但缺关键细节。以下五条是本节据此补写的：

- **I1 按 scope 串行**：`applyChangeset.ts:198` 的 `applyLocks` 链式 Promise 锁。
  ⚠️ 注释明写它依赖「单 daemon 平台」，**是 in-process 锁不是跨进程锁**。
- **I2 claim 顺序是承重的**：单事务内 `读身份（不存在与 owner 不符同形 404）` →
  **duplicate 查询** → 业务状态校验 → provider `claimInTx` → `insert prepared`。
  duplicate 若排在状态校验之后，一次已 committed 的重放会因为 scope 此后关闭而报错，
  而不是返回原 receipt。
- **I3 replay 是三态**：`committed` → 返回**原 receipt**；`failed` → 409
  `bundle-apply-failed-replay`；`prepared`/`applying` → 409 `bundle-apply-unsettled`
  （原文：*Refuse rather than guess*）。**本设计此前只写了三分之一。**
- **I6 CAS 之后必须二次校验**：`revalidateInTx` 的调用时机 = journal CAS
  `prepared→applying` **之后**、任何 commit kernel **之前**。pre-stage 窗口（npm 安装 /
  技能 staging）里外部状态可能已变。
- **I8 post-commit 绝不补偿**：`committedReceipt !== null` 是错误处理的分水岭——DB 已提交后
  任何 tail 异常只记日志并原样抛出，**不得**补偿、**不得**把 journal 改 failed，由收敛重放
  幂等尾。这是重构里最容易丢的一条（写 catch 块时把补偿逻辑放进去太自然了）。

另两条细节补正：**I4** 的类型序照抄 `resolveChangeset.ts:656`
（`skill → mcp → plugin → agent(dependsOn) → wf/wg`），别自己重排；**I9** 收敛把
`prepared/applying` 改 `failed` 的 CAS **必须带 `state = row.state` 条件**，否则会与活事务竞争。

下表是归属速查，完整证据见 `invariants.md`：

| 不变量 | 锚点 | v4 归属 |
|---|---|---|
| 整个 apply 按 scope 串行 | `applyChangeset.ts:198` | 引擎（scope 由 provider 给） |
| claim 同事务校验身份 / in-flight / draft hash，且 duplicate 查询先于这些校验 | `:277` | 引擎骨架 + `claimInTx` |
| committed / failed / unsettled **三态** replay，不是统一「返回 receipt」 | `:357` | 引擎 |
| slot / secret waiver / human binding / finalName / copy-only / typed ref / cycle 校验 | `resolveChangeset.ts:345` | **intent 特有**，留在 intent（本 RFC 不迁） |
| 预铸 id、按类型与 agent `dependsOn` 排序 | `resolveChangeset.ts:651` | 引擎（§2.3b planner） |
| `pendingIds` / `pendingAgentNames` 让 preflight 接受未落库的同 bundle 目标 | `:428` | 引擎（§2.3b） |
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

拆成**四段**（在 `skillVersion.ts` 内新增），既有 `commitSkillVersion` 退化为四段的顺序组合、
其它调用方零改动：

| 段 | 做什么 | 何时 |
|---|---|---|
| `stageSkillVersion(...)` | 开 version-write op（拿 `skill_operation_locks`）、产 op-scoped staging、归档 `versions/vN/files`（**永久权威快照**）、算 content hash。`fs-staged` → `fs-versioned` | pre-stage |
| `commitSkillVersionInTx(tx, staged)` | 事务内写 `skill_versions` 行 + `skills.contentVersion` + 完整 composite precondition + `txExtra` / description / `versionState` + `advancePhase('db-committed')` | big tx |
| `publishStagedSkillVersion(staged)` | `swapInStaged(filesDir, publishId)` **从 staging** 原子发布 live → 校验真实目录 + content hash → `cleanupOpDirs` → `advancePhase('fs-published')` + `finishOperation` 释放锁 → 重新 mark verified | ④ |
| `abortStagedSkillVersion(staged)` 🆕 | **pre-commit 补偿**：删除未提交的候选 `versions/vN` 与 staging、释放 `skill_operation_locks`；清理无法证明时**保留 op 作 recovery oracle** | 补偿路径 |

⚠️ **v3 在这里写错了**：v3 写的是「rename 候选目录到 live」。实测源码
（`skillVersion.ts:555,608`）live 是**从 op-scoped staging** 经 `swapInStaged`（两次同父
rename）发布的，而 `versions/vN/files` 是**永久权威快照**——`reconcileSkillLiveFiles()` 启动时
靠它重建 live、恢复 handler（`skillVersionOp.ts:64`）把 candidate 当**永久前滚源**。把它 rename
走会让 `skillBootVerify` 失败、版本历史读不到 vN、恢复无法前滚。

**必须一并保留的既有语义**：`fs-staged` → `fs-versioned` → `db-committed` → `fs-published` →
`done` 五相；**pre-commit 清理失败保留 op 作恢复 oracle，post-commit 失败绝不回滚**。

**三处 R4 修正**：

- **`unmarkSkillBootVerified` 不在 publish 段里**（R4-P1-5）。现有实现在 DB commit 返回后
  **立刻** unmark，且在测试 fault hook **之前**（`skillVersion.ts:601-606`：
  `committed = true; unmarkSkillBootVerified(...); commit.__afterDbCommitForTest?.()`）。
  批量场景必须照此：**big tx 成功返回后、进入任何逐项 publish 之前，一次性 unmark 本次提交
  的全部技能**。否则「DB 已指向新版本、live 仍是旧树，而技能还在 `bootVerifiedSet`」，
  运行路径会继续注入旧树。
- **必须有 `abortStagedSkillVersion`**（R4-P1-6）。现有那些细致的补偿语义全在单体函数的
  catch 里（`skillVersion.ts:634-655`）；拆开后引擎没有合法 API 就只能复制状态机内部逻辑。
  create 侧本就专门提供了 `compensateManagedSkillStage`（`skill.ts:386-401`），说明这不是
  可省略的辅助函数。
- **stage 要能返回 `noop`，但 `noop` 仍必须进 big tx 做 fence**（R4-P2-12 + **R5-P1-C 修正**）。
  现有行为：内容完全相同的保存**不创建新版本**、abandon op、返回原 latest
  （`skillVersion.ts:538-550`），且那次判定是在**独立事务**里校验 composite token 后做的。

  v5 初稿写「`noop` 时 big tx 不产生该 op」——**这会破坏整包的同一确认基线**。可复现：
  S 在 stage 阶段判定与当前 v1 相同、释放锁；同 bundle 后续在跑一个慢 npm 安装；期间并发
  编辑把 S 改成 v2；big tx 跳过 S，却提交了引用 S 的 agent / workflow ⇒ **导入成功，但绑定
  的是用户从未确认过的 v2**。

  正解：`noop` 成为 **fence-only PreparedOp** —— big tx 内**照样重验**
  content/meta/ACL/owner 四道 token，**只跳过版本写入与 publish**。
  `stageSkillVersion` 返回 `{ kind:'staged', ... } | { kind:'noop', fence }`，两种都进
  big tx，只是 `noop` 分支不调 `commitSkillVersionInTx`。⚠️ `skill_versions.source` 现有枚举是
  `initial/editor/fusion/restore`——**包导入的 update 复用 `editor` 还是扩枚举，是一处必须
  在批次 B 之前定下的决定**；扩枚举则 §7「无其它 schema 变更」要相应勘误。

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

## 3. intent：不迁移主流程，但决策 27 有**显式例外**

`applyIntentChangeset` 的**生命周期**（journal / claim / 收敛 / session 原子性）原样保留，
因此没有新旧 journal 并存问题。但用户决策 27 选择「skill 与 plugin **两个都开**」，而
**plugin 那半边不是「顺手」**——它要动 intent 的 prestage 循环与收敛。这是决策 26
「不碰 intent 生命周期」的**显式例外**，在此写明而不含糊。

### 3.1 skill 半边（真的顺手）

四段内核为配置包而建，intent 直接调用即可。改动面：`copyOnlyTargetsFor`
（`applyChangeset.ts:135`）里 skill 分支的 `'not supported yet'` 移除 + update switch 里
接上四段调用。

⚠️ **必须显式传 `expectedOwnerUserId`**（R4-P1-8）。该 fence 在 `commitSkillVersion` 里是
**optional**（`skillVersion.ts:381`，判据是 `!== undefined && ...`，**不传即不检查**），
而 intent 的 skill manifest token 只绑 `skillId / contentVersion / metaRevision`
（`skillToken.ts:23-27`），**不绑 owner**。可复现场景：Alice preflight 时拥有 S → pre-stage
期间管理员把 S 转给 Bob → 若新调用方没传 owner fence，最终写入仍会通过。
普通调用方都显式传了（`skill.ts:662`、`skill-zip.ts:466`），新路径也必须传。
技能 ACL 路由不取 `skill_operation_locks`，所以 owner 转移**不会**被 stage 锁挡住。

### 3.2 plugin 半边（决策 26 的显式例外）

**已核实的现状**：`applyChangeset.ts:641-647` 的 prestage 循环**只有 `plugin-create`**，
intent 根本没有 plugin-update 接线；而 plugin 的发布协议与 skill **完全不同**——
`commitPluginPublishInTx`（`plugin.ts:407`）用的是 **full-captured-row 身份栅栏**
（`samePluginRow` + `fullPluginRowWhere`，任何并发变化 → `resource-operation-stale`）。

因此「删掉一个分支」是不够的，要补的是一条完整链路：

| 步骤 | 内容 |
|---|---|
| resolve | `copyOnlyTargetsFor` 移除 plugin 分支；新增 `PreparedOp` kind `plugin-update` |
| baseline | **先用 session manifest 的 `configHash` 验原始基线**，且**必须从同一次读到的完整 row 投影计算**（R6-P2-2：若先 `getPlugin` 读 H1、再第二次读 full row，两次之间变成 H2 ⇒ captured=H2、commit kernel 只防 capture 之后的漂移 ⇒ 原漏洞原样复现）。只读一次 row → 从它投影算 `configHash` 与 manifest H1 比 → **同一个 row** 交给 commit kernel。测试分别覆盖「capture 前变化 → baseline stale」与「capture 后变化 → full-row stale」（R5-P1-D）：`manifest.ts:22` 存的是 dump 时刻的 hash。只捕获当前 row 是不够的—— dump 得 H1、同 owner 在普通插件页改成 H2、intent apply 随后捕获 H2 并以 H2 为栅栏，**H1 从未参与判断**，用户确认的基线被静默跳过。PreparedOp 因此必须同时携带 manifest 的 `expectedConfigHash` 与授权时的 owner |
| capture | 捕获**完整** plugin row（`commitPluginPublishInTx` 的栅栏靠它防 capture **之后**的漂移；与上一行是**两道**不同的门，缺一不可） |
| prestage | **spec 变了才**预安装；**record-before-act**：调用方预铸 generation id、先写 artifact 再 `installPlugin` |
| big tx | `commitPluginPublishInTx(tx, captured, set)` |
| 补偿 | artifact 带**精确** generation 路径，逆序删除 |
| 收敛 | `convergeIntentApplyJournal` 的 artifact 分支要能处理 `plugin-install` 的精确路径（现有实现对它**什么也不做**，注释写明「崩溃后拿不到 InstallResult，靠 GC 回收」——而 GC 会被任一非终态 node run 无限阻挡） |

**这条链路同时修好了 intent 侧一个既有缺口**：今天 intent 的 plugin-create 在崩溃后也只能
靠被阻塞的 GC 回收孤儿 generation。record-before-act 一并解决。

### 3.3 验收与范围声明

- **AC-K1/K2** 覆盖 skill 与 plugin 双向锁（自己的可原地更新、他人的仍强制 copy）。
- **`ownerUserId` 判据一字不动**，既有 copy 语义（slot derivation / copy rewiring /
  finalName / receipt `fromCopy`）逐条保持。
- ⚠️ **「intent 测试套零改判」这条承诺作废**（R4）：真正实现 plugin update 必须改 `PreparedOp`、
  artifact、收敛行为，相关断言必然变。改判范围限定为「prestage 循环 / artifact / 收敛 /
  copyOnlyTargetsFor 四处的相关用例」，其余零改判。

**后续迁移 RFC 的前置条件**：§2.1 的三个事务钩子；§2.2b 表里标「intent 特有」的两条；
MCP update 的 OAuth carry-forward（`applyChangeset.ts:556-563`）**不能**成为引擎默认——
配置包的 overwrite 里「无 OAuth」可能是有意删除。

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
| **同名重复** 🆕 | 闭包内出现两个同 `(类型, 名字)` 的资源 | 422 `package-duplicate-resource-name`，点名是哪两个、各自被谁引用（AC-2b） |

**为什么在导出侧拒绝**（R6-P1-2，用户点破）：包**不带任何权属信息**（决策 4 / 12）。源实例上
两个同名资源之所以能共存，是因为名字是 `(owner, name)` 复合唯一；进了包，owner 没了，
**就剩两个都叫 `lint` 的条目，导入方无从分辨**。这种包在语义上不可表示——与其让导入侧去
猜、或者搞一套「显式合并」的交互，不如根本不产出。构造场景真实存在：工作流引用代理 A
（用 Alice 的 `lint`）和代理 B（用 Bob 的 `lint`），闭包把两个插件都拉进来。

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
- **`previewToken`**（AC-24d，**R4-P1-1 / R5-P1-A 修正**）：**不是**客户端自报的 digest，
  也不只签包内容。
  v4 初稿写「preview 下发 digest、commit 比对重算值」——那证明不了任何事：客户端可以同时
  换掉文件**和**摘要（preview 包 A 拿到 `DA`，commit 传包 B 并把 decisions 里的摘要改成
  `hash(B)`，commit 重算 B 得到同一个值，比对通过）。
  正解是把**整套确认基线**签进去。R5 指出只签 `packageDigest` 仍可绕：preview 时目标
  plugin 是 `H1`，另一标签页改成 `H2`，客户端把 decision 里的 `expect` 换成 `H2` —— 包没变、
  签名仍有效、owner 与 allowedActions 也仍通过，于是 CAS 覆盖了用户从未确认的 `H2`。

  **签名覆盖面**（`previewBaseline`）：

  ```
  previewToken = sign(daemonSecret,
      importId ‖ actorUserId ‖ packageDigest ‖ exp ‖
      canonical(previewBaseline))
  previewBaseline = 每个条目的 { localSlug, candidateIds[], expectByCandidateId{}, allowedActions[] }
  ```

  关键在于**用户的「选择」是自由的，但可选项与它们的基线是签死的**。commit 时除了验签，
  还要断言「用户提交的 `(target, expect)` 组合**是该条目 baseline 里的一对**」——H2 不在
  baseline 里，于是被拒。

  **校验顺序**（R5 指出的第二个复现：commit 成功但响应丢失、过期后重试，若先查 expiry 会
  409 而进不了 replay，违反 I3 三态）：

  ```
  ① 验签（签名不符 → 400，与 replay 无关）
  ② duplicate lookup（命中 → 按 I3 三态处理，**不再检查 expiry**）
  ③ 仅首次 claim 才检查 exp（过期 → 409，要求重新预检）
  ```

  **TTL 与 wire**：`exp` 是 envelope 的一部分（不是独立字段，否则可被单独篡改），
  默认 30 分钟，随 `previewToken` 一起原样回传。
  ⚠️ **`SecretBox` 现有 API 只有 AES-GCM `seal/unseal`、没有 HMAC**
  （`auth/secretBox.ts:16`）——用 authenticated sealed payload（把 envelope 直接 seal，
  unseal 成功即证明未被篡改）还是给 `SecretBox` 扩一个 HMAC helper，是**实现期的局部选择**，
  语义已由本节定死。

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
| `reuse` | **不产生 op**，但**必须产生一条 `selectedExternalFence`** | 全部改写为 `external:<选定的本地 id>` |
| `new` | create op（带 `local:<slug>`） | 保持 `local:<slug>` |
| `overwrite` | update op（external `target` + `expect`） | **也要改写为 `external:<目标 id>`** —— v3 只写了 reuse 的改写，漏了这条：包里 agent A 被 overwrite、workflow W 引用 A 时，A 不再是 create op，W 的 `local:A` 没有 slug 可绑 |

#### `selectedExternalFence`（R6-P1-1）

**`reuse` 不产生 op，但绝不等于「不需要校验」。** v6 之前的写法有一个洞：`reuse` 不产 op、
package provider 的三个事务钩子又写着「全部留空」⇒ **没有任何 commit kernel 会核对被复用
目标的内容**。可复现：Alice preview 时候选 `P` 的签名基线是 `configHash=H1`，选 `reuse P`；
commit 验签与重算 `allowedActions` 都过了，**随后在 big tx 之前** Bob 把 `P` 改成 `H2`；
导入成功，包内引用绑定到用户从未确认过的 `H2`。全 reuse 的根若在同一窗口被删，还会提交一个
指向不存在 external root 的空 receipt。

`previewToken` 只证明「用户当时看到的是 H1」，**它不是提交的线性化点**。因此每个 `reuse`
目标都要产出一条 fence，在 **journal CAS 之后、任何 commit kernel 之前**、同一个 big tx 内
复核：目标仍存在、类型相符、**内容 token 仍等于签名基线里的那个**、当前仍对 actor 可见。

```ts
interface SelectedExternalFence {
  localSlug: string
  type: AclResourceType
  resourceId: string
  expect: BundleExpectToken     // 来自签名基线，不是现场重读
}
```

落点是 package provider 的 **`revalidateInTx`** —— 因此 §2.1 那句「package provider 的
钩子全部留空实现」**作废**：`revalidateInTx` 是实打实要实现的。既有先例是
`importRefs.ts:160-180` 的最终事务 selection fence，形状可直接借鉴。

**`ops` 为空时也必须走这道 fence 才能把 journal 标 committed** —— 否则「全 reuse 的包」
恰恰是完全没有任何校验的那一档。

两个边界：

- **`ops` 可以为空**：只有一个 agent 的包、目标已有同名且选 `reuse` ⇒ 零 op、但**非零
  fence**。`BundleSchema` 因此不要求 `.min(1)`；引擎对空 bundle 走 no-op 成功路径
  （fence 通过 → journal committed + 空 receipt），不是报错、也不是免检。
- **`rootRef` 可以指向 external**：根被 reuse / overwrite 时它没有 create slug；
  该 external 根**同样在 fence 集合里**（覆盖「根被并发删除」）。

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
| 重复提交同 idempotencyKey | **三态**（I3）：`committed` → 原 receipt；`failed` → 409；`prepared`/`applying` → 409 未结 |
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
| **intent 测试套** | 改判限定在 prestage 循环 / artifact / 收敛 / `copyOnlyTargetsFor` **四处**；其余零改判 | 决策 27「两个都开」（plugin 半边动到 prestage 与收敛） |

⚠️ `route-error-code-coverage` 用 `git ls-files` 枚举，未追踪的新文件对它是盲的——新增文件
多，落地时先 `git add -N` 再跑门禁。

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 决策 27 误伤 intent 既有 copy 语义 | AC-K2 双向锁；`ownerUserId` 判据一字不动 |
| 决策 27 的 plugin 半边动到 intent prestage / 收敛 | §3.2 完整链路 + 独立 commit + 改判范围显式限定四处 |
| 泛化时丢掉某条既有不变量 | `rfc271-bundle-engine.test.ts` 逐条点名；泛化前把 `applyChangeset.ts` 的不变量列成清单对照 |
| ~~新旧 journal 并存~~ | **不存在**：决策 26 下 `intent_apply_journal` 一字不动，intent 继续用它自己那张表 |
| `skill-update` 拆分引入回归 | 既有 `commitSkillVersion` 退化为四段顺序组合、保留 `noop` 分支，其它调用方零改动 |
| 盘子过大一次推不动 | `plan.md` 的「PR / commit 拆分」：表达层 → 引擎 → intent 迁移 → 导出 → 导入 → 前端/CLI → 下线，逐个独立可绿 |

## 11. 四轮设计门 findings 落点

| 轮次·编号 | 落点 |
|---|---|
| R1-A1 / R2-A1 无可见性屏障、journal 不同构 | §2.2 复用既有生命周期 + 幂等键 + active lease |
| R1-A2 / R2-A2 fence 只锁 ACL | §1.3 `BundleExpectToken` + §5.2 由 preview 下发回传（AC-24b） |
| R1-A3 / R2-A3 绕过技能/插件持久化协议 | §2.4 `skill-update` 四段拆分 + §2.5 插件 record-before-act |
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
