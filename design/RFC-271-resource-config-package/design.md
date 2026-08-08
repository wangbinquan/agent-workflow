# RFC-271 · 技术设计

配套 `proposal.md`。锚点均为本仓当前源码（`aa035f9c`）。本版已吸收 Codex 设计门 12 条 findings
（7×P1 + 5×P2），逐条核实属实；§10 列出每条的落点。

## 0. 设计要旨

四条承重线：

1. **闭包遍历是纯函数，IO 在外层**。`directRefsOf` / `walkClosure` 只吃已装载的行，不自己查库；
   批量装载器负责 DB 读取。闭包规则可脱离 DB 单测，递归里也不会打出 N+1。
2. **包内身份是 opaque key，不是名字**。`(owner, name)` 只对五类资源唯一、工作流连这个都没有，
   所以「名字 → id」的重绑在同名场景必然绑错。每个 manifest 条目带
   `packageResourceKey`，所有边 / 引用 / 决策 / 重绑一律按它工作。
3. **落地复用 RFC-234 已建成的 pre-stage + big-tx 管线，不自造持久化路径**。
   `stageManagedSkill`（`skill.ts:313`）的契约白纸黑字：*reserve（不可见行 + op 锁）→ 产文件 →
   归档 v1，技能在 `commitSkillReadyInTx` 之前一直 INVISIBLE，抛错即已补偿*；
   `commitSkillReadyInTx`（`skill.ts:304`）的存在理由就是「让 intent apply 事务把**许多**
   pre-staged 技能与 bundle 其余部分**原子地**翻可见」。插件同理：`installPlugin`
   （`pluginInstaller.ts:174`）产出不可变 generation，插入内核在其**之后**
   （`plugin.ts:84,105`）。
4. **manifest 是权威清单，其余段是派生索引**。`resources` 决定导入读哪些文件；`graph` /
   `requirements` / `secrets` 只供人类与预检页阅读，**导入侧一律不消费**——否则就是 RFC-146
   禁止的假单一事实源。

> **对第一版的纠正**：初稿写的是「FS 暂存 → DB 事务 → FS 原子入位」，声称第三段是唯一补偿
> 窗口。这个方向是反的，也因此留下了「DB 已提交、FS 未发布」的不可收敛窗口。既有内核的
> 正确顺序是 **FS 先落位但 DB 行不可见 → 一个事务里翻可见**，此时根本不存在那个窗口。
> `skill-zip.ts:415` 的注释还记着自造裸路径的代价：留下 `versionState='legacy-unbackfilled'`、
> 无快照，**单测能过但活 daemon 上每次 create 都失败**。

## 1. shared 契约层

新文件 `packages/shared/src/resourcePackage.ts`（+ `index.ts` re-export）。

### 1.1 常量

```ts
export const PACKAGE_FORMAT_VERSION = 1
/** 复用技能 zip 的同一套上限。导出与导入共用这一份判据。 */
export const PACKAGE_LIMITS = SKILL_ZIP_LIMITS   // 总 64MB / 单文件 10MB / 2000 条目 / 12 层
/** 目录名 ← 资源类型；同时是导入侧的合法顶层目录白名单。 */
export const PACKAGE_DIRS = { agent:'agents', skill:'skills', mcp:'mcps',
  plugin:'plugins', workflow:'workflows', workgroup:'workgroups' } as const
    satisfies Record<AclResourceType, string>
/** 脱敏后的字段值。导入侧遇到它一律当「未提供」，绝不写成字面量。 */
export const PACKAGE_SECRET_PLACEHOLDER = '<REDACTED:SECRET>'
```

### 1.2 包内身份（Codex B1）

```ts
/** 包内稳定身份。不含源实例信息（决策 12）：由 (type, name, ownerDisambiguator) 的
 *  出现序号派生，形如 'agent:worker#1' / 'agent:worker#2'。同名不同 owner 各自独立。 */
export const PackageResourceKeySchema = z.string().min(1).max(256)

export const PackageResourceEntrySchema = z.object({
  key: PackageResourceKeySchema,        // ← 权威身份
  type: AclResourceTypeSchema,
  name: z.string().min(1).max(256),     // 展示 + 匹配用，不是身份
  path: z.string().min(1).max(1024),    // 目录型（skill）以 '/' 结尾
}).strict()
```

**所有**跨资源引用在包内都改用 key：
- 工作流 `agent-single` 节点：`agentPackageKey`（替代 `agentName + agentOwnerUsername`）
- `call-workflow` / `call-workgroup`：`targetPackageKey`（闭包内命中时）或保留裸名字（dangling）
- agent 的 `skills` / `mcp` / `plugins` / `dependsOn`：key 数组
- 工作组成员：`agentPackageKey`

包外引用（内置件、dangling 名字）保留名字形态，与 key 域不混。

### 1.3 manifest schema

```ts
export const PackageManifestSchema = z.object({
  formatVersion: z.literal(PACKAGE_FORMAT_VERSION),
  platformVersion: z.string(),          // currentAppVersion()（backupManifest.ts）
  exportedAt: z.number().int(),
  rootKey: PackageResourceKeySchema,    // 指向 resources 里的一条
  resources: z.array(PackageResourceEntrySchema).min(1),
  graph: z.array(PackageEdgeSchema).default([]),          // 派生索引
  builtins: z.array(PackageBuiltinRefSchema).default([]), // 内置依赖声明
  requirements: PackageRequirementsSchema,
  secrets: z.array(PackageSecretRefSchema).default([]),   // 派生索引
  /** AC-7c：name 域 call 引用有多个可见候选时的选定记录。 */
  ambiguousCallRefs: z.array(z.object({
    fromKey: PackageResourceKeySchema, nodeId: z.string(),
    name: z.string(), candidateCount: z.number().int().positive(),
    chosenKey: PackageResourceKeySchema.nullable(),   // null = 选中的行不在闭包内
  }).strict()).default([]),
}).strict()
```

`PackageRequirementsSchema` **五**段（Codex B2 补了第五段），全部只放非敏感字段：

| 段 | 字段 | 来源 |
|---|---|---|
| `runtimes` | `name` / `protocol` / `model` | `runtimes` 表；**不含** `binaryPath` / `extraArgsJson` / `lastProbeJson` |
| `codeHosts` | `provider` | `code-host-call` 节点；**不含** base URL / token |
| `executables` | `command`（argv[0]） | MCP local 的 `config.command[0]` |
| `pluginSources` | `name` / `sourceKind` / `spec`（**脱敏后**） | `plugins` 表 |
| `projectSkills` 🆕 | `name` | agent 的 `{kind:'project'}` 技能引用（仓内技能，不入包） |

每段带 `usedBy: PackageResourceKey[]`。

### 1.4 可移植资源文档 schema

| 类型 | 包内格式 | 复用 | 新增 |
|---|---|---|---|
| workflow | YAML | `stringifyWorkflowYamlDocument` | 无 `id`；引用改 key 域 |
| agent | `.md` | `serializeAgentMarkdown` / `parseAgentMarkdown` | 引用改 key 域 |
| skill | 目录树 | `SKILL.md`（`skill-md.ts`） | 无 |
| mcp | YAML | — | `PortableMcpSchema` |
| plugin | YAML | — | `PortablePluginSchema` |
| workgroup | YAML | — | `PortableWorkgroupSchema` |

```ts
export const PortableWorkgroupMemberSchema = z.discriminatedUnion('memberType', [
  z.object({ memberType: z.literal('agent'), agentPackageKey: PackageResourceKeySchema,
             displayName: WorkgroupMemberDisplayNameSchema,
             roleDesc: z.string(), sortOrder: z.number().int() }).strict(),
  z.object({ memberType: z.literal('human'), username: z.string().min(1),
             displayName: WorkgroupMemberDisplayNameSchema,
             roleDesc: z.string(), sortOrder: z.number().int() }).strict(),
])
```

工作组的 `leaderMemberId` 是本地行 id，改用 `leaderDisplayName` 承载
（`uq_workgroup_members_display` 保证组内 `displayName` 唯一，可作组内稳定键）。

### 1.5 闭包遍历（纯函数）

`directRefsOf` 的每类规则（与既有提取器同源）：

| 资源 | 引用 | 提取自 |
|---|---|---|
| workflow | agent | `extractWorkflowAgentRefs`（`resourceRefs.ts:39`） |
| workflow | workflow | `extractWorkflowWorkflowRefs`（`:64`），**name 域** |
| workflow | workgroup | `extractWorkflowWorkgroupRefs`（`:69`），**name 域** |
| agent | skill | `agents.skills` 的 `kind:'managed'`；`kind:'project'` → `requirements.projectSkills` |
| agent | mcp / plugin / agent | `agents.mcp` / `.plugins` / `.dependsOn` |
| workgroup | agent | `workgroup_members` 里 `memberType='agent'` 的 `agentId` |
| skill / mcp / plugin | — | 叶子 |

`walkClosure` 是 BFS + visited，**去环**（AC-4），输出稳定顺序（类型 → key）。

## 2. 后端 · 导出

`packages/backend/src/services/resourcePackage/export.ts`。

### 2.1 两个引用域，两套可见性规则（Codex C1）

这是本 RFC 最容易写错的地方，单列：

| 域 | 谁 | 不可见时 | 理由 |
|---|---|---|---|
| **id 域** | `agent-single.agentId`、agent 的 skills / mcp / plugins / dependsOn、工作组成员 agentId | **422** `package-export-ref-unavailable`，文案「因存在你无权访问的依赖，无法导出」 | 调用方手里已经有 canonical id，不构成新的信息泄露；用户决策 3 |
| **name 域** | `call-workflow.workflowName`、`call-workgroup.workgroupName` | **必须与「零匹配行」逐字节同形**：dangling，导出成功，README 警示 | 否则构成存在性预言机：Alice 用一个尚不存在的名字保存工作流并周期导出，Bob 后来建了同名私有资源，Alice 的导出就从 200 变 422 ⇒ 精确得知 Bob 的私有资源名存在。这正是 `resourceRefs.ts:148-151` 那一位 bit，导出会把它变成可无限轮询、无写操作的预言机 |

name 域解析**只在 actor 的可见集合内**进行；2+ 可见候选时按 `freezeCallClosure`
（`execution/closure.ts`）的同一条规则「**最老可见 ULID 胜出**」选定，并写进
`manifest.ambiguousCallRefs`（AC-7c，消解 Codex C8）。

### 2.2 脱敏（Codex D1）

**不自造字段清单**——复用 `packages/shared/src/intentSecretSlots.ts` 的既有载体覆盖：

| 载体 | 复用函数 |
|---|---|
| MCP argv 内嵌 token / URL 内嵌凭据 / env / headers / oauth | `projectMcpForDump` + `redactUrlForDump` |
| plugin `spec`（含凭据的 git URL）/ `options` | `projectPluginForDump` |
| agent `frontmatterExtra` / 工作流 passthrough 自由字段 | `maskFreeJsonSecrets` + `SECRET_KEY_RE` |
| 脚本节点 `env` | `maskWorkflowScriptEnv` |
| 兜底 | `scanForCredentialPatterns` + `looksHighEntropy` 作为**第二层**，命中即写进 `manifest.secrets` |

`requirements.pluginSources.spec` 走**同一条**脱敏（AC-10：requirements 不含任何密钥——初稿
在这里把 plugin spec 原样复制了一份，与 AC-10 自相矛盾）。

**范围边界（决策 18）**：技能文件树内容**不扫描**。`proposal.md §3` 已把它列为非目标，
`docs/resource-packages.md` 写明「技能目录里硬编码的凭据属于技能作者的责任」。

**枚举字段绝不脱敏**（RFC-270 教训：脱成占位符会让严格 schema 解析失败）。

### 2.3 特权节点门 · 按轴判定（Codex C2）

```ts
const lens = privilegedNodeLensFor(actor)      // { scripts: boolean, codeHost: boolean }
if (lens.scripts  && closureHasScriptNode(closure))   throw forbidden('scripts:author')
if (lens.codeHost && closureHasCodeHostNode(closure)) throw forbidden('code-host-calls:author')
```

两个维度**本来就独立**（`privilegedNodeRedaction.ts:29`）。初稿写的
`!lensIsTransparent(lens) && closureHasPrivilegedNode(closure)` 会让「有 `scripts:author`、
闭包只含脚本节点」的合法 actor 也被 422。当前角色矩阵下两个权限同进同出，所以这是 latent
契约缺陷而非现网越权——但判据必须按轴写，并配独立权限矩阵测试（AC-32）。

判定覆盖闭包内**每一个**工作流，不只根。

### 2.4 zip 打包

仓内只有 `decodeZip`（`skill-zip.ts:62`），需要对偶方向：`encodeZip` 放
`packages/backend/src/util/zip.ts`，store-only（无压缩，约 120 行，不引第三方依赖）。
`PACKAGE_LIMITS` 因此约束的是**未压缩**大小，语义直白。

## 3. 后端 · 导入

`packages/backend/src/services/resourcePackage/`。

### 3.1 两步式（无服务端暂存态）

沿用技能 zip 导入的姿势（前端持有文件、传两次），不引入服务端临时存储：

```
POST /api/resource-packages/preview   multipart: file                  → PackagePreview
POST /api/resource-packages/commit    multipart: file + decisions(JSON) → PackageImportReport
```

`commit` 重新解析 zip；决策绑定预检时的身份 + **内容级** token（§3.3）。

### 3.2 预检

```ts
export interface PackagePreviewEntry {
  key: PackageResourceKey            // ← 决策按 key 索引，不按名字
  type: AclResourceType
  name: string
  /** 你自己拥有的同名资源。工作流无唯一约束 ⇒ 可能多个，必须显式选（AC-14b）。 */
  ownMatches: ImportRefCandidate[]
  /** 其余可见同名候选（带 owner）。 */
  otherMatches: ImportRefCandidate[]
  /** 'overwrite' 仅当 ownMatches 非空才出现（AC-15）。 */
  allowedActions: Array<'reuse' | 'new' | 'overwrite'>
  defaultAction: 'reuse' | 'new' | 'overwrite'
  suggestedName: string              // 'new' 时的建议名，已避开本地冲突
  missingPermissions: PermissionKey[]// 非空 ⇒ 标红且整包不可提交
  secretFields: string[]             // 待填密钥
}
```

`ImportRefCandidate`（`importRef.ts:55`）已带 `id / ownerUserId / ownerUsername / visibility /
aclRevision`，直接复用。

权限判据：`reuse` → `<type>:read`；`new` → `<type>:create`；`overwrite` → `<type>:update`。
工作流额外：含 `script` 节点需 `scripts:author`、含 `code-host-call` 节点需
`code-host-calls:author`——这两个门今天就在 `prepareWorkflowSave` / `insertWorkflowInTx` 上
（RFC-270），预检只是把它**提前可见**，不新增强制点也绕不过。

另有三段独立块：`builtins`（本地找不到同名内置件 → 标红）、`humanSeats`（未匹配的必须指派或
删除）、`requirements`（只展示，不阻断）。

### 3.3 提交 · 复用 RFC-234 的 pre-stage + big-tx 管线（Codex A1 / A2 / A3 / B3）

生命周期与 `intentApplyJournal`（`schema.ts:3491`，`applyChangeset.ts:9-23`）**逐条同构**：

```
① claim      新表插入 phase='prepared' 行（UNIQUE(importId) 幂等声明）
② pre-stage  FS / 安装副作用，全部产出「DB 不可见」的成果，逐个记进 journal artifacts：
             · 技能 → stageManagedSkill(..., { id: 预铸id })   reserve(不可见行+op锁)→产文件→归档v1
             · 插件 → installPlugin(...)                       不可变 generation 目录
             （抛错即已补偿，见各内核自身契约）
③ big tx     CAS journal prepared→applying；一个 dbTxSync 内：
             · 内容级 CAS（见下表）
             · commitSkillReadyInTx / commitSkillVersion / plugin 插入内核
             · agent / workflow / workgroup 的 insert / update
             · 按 packageResourceKey 回填全部引用
             · journal → 'committed' + receipt
④ 幂等尾     清理 staging / backup 目录。失败无害，收敛会重放
⑤ 收敛       启动期 + 每小时：prepared/applying → 逆序补偿 artifacts → 'failed'（零可见）；
             'committed' → 重放幂等尾
```

**「DB 已提交、FS 未发布」的窗口不存在**：FS 先落位但 DB 行不可见，`commitSkillReadyInTx`
是唯一线性化点。这也自然满足 AC-20b（journal 未 committed 前正式行对读 / 启动路径不可见）。

**预铸 id 消解拓扑序要求**（Codex B3）：`stageManagedSkill` 已支持 `meta.id`
（注释原文：*pre-minted bundle id so same-bundle refs resolve before insert*）。六类资源全部
在 ② 之前预铸 id，③ 里一次写入，因此 `A → B → A` 的 call 环**不需要**拓扑序，AC-4 的导出
承诺与导入不再冲突。

**内容级 CAS（Codex A2）**——只比 ACL 不够，两个并发导入串行执行会静默丢掉先完成那个的内容：

| 类型 | 决策必须携带的 token | 出处 |
|---|---|---|
| workflow | `expectedVersion` | `schemas/workflow.ts:410` |
| workgroup | `expectedVersion` | `schemas/workgroup.ts:391` |
| agent | `expectedUpdatedAt + expectedAclRevision` | `schemas/agent.ts:414` |
| mcp / plugin | `expectedConfigHash` | `schemas/mcp.ts:180` / `plugin.ts:83` |
| skill | `contentVersion + metaRevision + aclRevision` | `skill-zip.ts:376` |

技能目标同时取 `skill_operation_locks`（`skillOperations.ts` 的通用互斥原语），同目标第二个
导入 → 409 要求重新预检（AC-24b）。ACL fence 仍复用 `assertImportRefsStableInTx`
（`importRefs.ts:172`），与内容 CAS 是两道**并列**的门。

**owner / visibility（AC-21）**：新建一律 `ownerUserId = actor.user.id` + `visibility='private'`
+ 零 grants（RFC-231）；覆盖**不写** owner / visibility / grants 三列。

### 3.4 新表

```
resource_package_imports        -- 形态照抄 intent_apply_journal
  id                TEXT PK     -- ULID
  actor_user_id     TEXT NOT NULL
  state             TEXT NOT NULL   -- prepared | applying | committed | failed
  root_key          TEXT NOT NULL
  prepared_artifacts_json TEXT      -- [{kind:'skill'|'plugin', id, opId?, stagingPath?}]
  receipt_json      TEXT
  created_at / updated_at INTEGER NOT NULL
```

一个迁移。⚠️ 这推翻初稿「零新表零迁移」的说法，已在 `proposal.md` 决策 17 记明。
收敛逻辑若能与 `applyChangeset` 的那份抽出共用则共用；不能则同构实现并互相加断言锁。

### 3.5 防夹带（AC-2）

解 zip 后：路径必须落在 `PACKAGE_DIRS` 白名单顶层目录或是 `manifest.yaml` / `README.md`；
每个文件必须在 `manifest.resources[].path` 登记（技能目录按前缀匹配）；出现未登记条目 → 422
`package-unlisted-entry`。zip slip（`..` / 绝对路径 / 符号链接）由 `decodeZip` 既有的归一化
保证，复用而非重写。

## 4. 路由与权限

| 方法 | 路径 | 权限 | tokenAccess |
|---|---|---|---|
| GET | `/api/{agents,skills,mcps,plugins,workflows,workgroups}/:id/export-package` | 对应 `*:read` | `'allow'` |
| POST | `/api/resource-packages/preview` | 六类 `*:read` | **`'never'`** |
| POST | `/api/resource-packages/commit` | 六类 `*:read` + §3.2 逐条判据 | **`'never'`** |
| ~~GET~~ | ~~`/api/workflows/:id/export`~~ | — | 下线（C1） |
| ~~POST~~ | ~~`/api/workflows/import`~~ | — | 下线（C2 / C6） |

工作流 / 工作组的导出接 `?expectedVersion=`（AC-12）。

**不新增权限点**（目录保持 67 条）。路由 permission 数组是 **AND**（`registry.ts:65`），当前三种
角色都带六类 read，所以粗粒度门只挡完全无关的调用方；精确判据在业务层——与 RFC-099
「保存时只校验新增引用」的分层姿势一致。

`TokenAccess` 的合法值是 `'allow' | 'never'`（`registry.ts`）——初稿写的 `'deny'` 不存在。
导入端点选 `'never'`：导入会新建资源并决定权属，不是令牌该做的事。这是 **C6** 的来源。

## 5. 前端

### 5.1 导出入口（AC-1）

六类详情 / 编辑页的「更多操作」抽屉各加一条：工作流把 `workflows.edit.tsx:1191` 的
「导出 YAML」原地改名；工作组抽屉新增；代理 / 技能 / MCP / 插件详情页各新增。

新 `lib/resource-package-download.ts`：抽出 `safeDownloadBaseName`（RFC-264 的 Unicode 安全
文件名）共用，然后**删除** `workflow-draft-export.ts` 的本地草稿导出路径（C3）。

### 5.2 导入预检页（AC-13 / AC-14）

新组件 `components/ResourcePackageImportDialog.tsx`，`<Dialog size="full">`；每一行用既有公共
原语，**零自写 chrome**：

| 元素 | 用什么 |
|---|---|
| 弹窗 | `components/Dialog.tsx` |
| 动作三选一 | `.segmented`（`styles.css`） |
| 候选资源选择（含多个 own match） | `components/Select.tsx` |
| 副本名 / 密钥输入 | `components/Form.tsx` 的 `<Field>` + `<TextInput>` |
| 状态标记 | `<StatusChip>` |
| 错误 / 空 / 加载 | `<ErrorBanner>` / `<EmptyState>` / `<LoadingState>` |

`WorkflowImportDialog.tsx` 删除（C2）；其三档冲突交互被新预检页吸收，是它的超集。

导入入口（AC-13）：六类列表页各一个 + 统一入口；读 manifest 的 `rootKey` 对应类型，与当前页
不符则 `router.navigate` 到对应列表页并透传已解析文件。

## 6. CLI

`packages/backend/src/cli/package.ts`，在 `cli/start.ts` 命令表注册：

```
agent-workflow export-package --as-user <u> --type <t> --name <n> [--owner <u2>] -o <file>
agent-workflow import-package <zip> --as-user <u>
        [--plan | --apply <plan.yaml>] [--on-conflict reuse|new|fail] [--dry-run]
```

- **两条命令都必须 `--as-user`**（Codex C3 / 决策 20）：导出的 ACL 可见性、闭包判据、§2.3 分轴
  门都需要 Actor。缺了就只有三条坏路：用 `--owner` 构造 Actor = 无声明 impersonation；用
  system principal = 绕开网页判据；不构造 Actor = AC-26「与网页完全相同」不可实现。
- 解析成真实 `users` 行并构造与 HTTP 同构的 `Actor`（含权限矩阵），全部判据走**同一套服务
  函数**（AC-29）。
- 文档明确写：**能访问 appHome / SQLite 的本机操作者本身就是 break-glass 管理员**
  （`cli/user.ts` 既有边界），`--as-user` 是**归属声明**而非身份认证，不要把 CLI 描述成
  终端用户认证通道。
- `--plan` 输出 = `PackagePreview` 的 YAML + 每条 `action` 默认值；`--apply` 读回校验后喂给
  commit 服务。`--on-conflict` 是「全部设成同一档」的语法糖，与 `--plan` 互斥。
- 与 `cli/restore.ts:23` 的 `--dry-run` / `--yes` 两段式风格一致。

## 7. 数据与迁移

**一张新表 + 一个迁移**（§3.4）。除此之外零 schema 变更、零新权限点。资源写入全部走既有内核
与 CRUD 服务，不绕过任何既有校验或门。

## 8. 失败模式与取舍

| 场景 | 行为 | 理由 |
|---|---|---|
| 闭包内 **id 域**资源不可见 | 422 + 明确提示「无法导出」 | 决策 3；已知这是新增收缩（C7） |
| 闭包内 **name 域**引用无可见候选 | 导出成功，dangling，README 警示 | 与「零匹配」同形，堵预言机（C1） |
| name 域 2+ 可见候选 | 按最老可见 ULID 选定 + manifest 标注 | 与 `freezeCallClosure` 逐字一致（消解 C8） |
| 闭包内特权节点且缺**对应**权限 | 422，按轴 | C4 / Codex C2 |
| 超体积上限 | 422 并点名资源 + 维度 | AC-11 |
| pre-stage 阶段失败 | 各内核自补偿 + journal → failed | 零可见副作用 |
| big tx 失败 | SQLite 回滚 + 逆序补偿 artifacts | 零可见副作用 |
| 进程被 SIGKILL | 启动收敛：prepared/applying → 补偿 → failed；committed → 重放幂等尾 | AC-20 |
| 并发导入同目标 | 内容 CAS 409 + 技能 op 锁 409 | AC-24 / AC-24b |
| `formatVersion` 更高 | 拒绝，提示升级 | AC-23 |
| 包内未登记文件 | 422 `package-unlisted-entry` | AC-2 |
| agent 的 `project` 技能 | 不入包，进 `requirements.projectSkills` | 仓内技能属代码仓 |
| 技能文件树里的硬编码密钥 | **不扫描、原样入包** | 决策 18；文档写明是作者责任 |

**已知不对称（显式承认，不修）**：包不携带版本号 / 修改时间 / ACL 授权名单，所以
「导出→导入→再导出」不是字节幂等的。这是决策 4 与决策 12 的直接后果。

## 9. 测试策略

### shared（纯函数，无 DB）
- `resource-package-closure.test.ts`：六类根 × {无依赖 / 线性链 / 菱形共享 / 自环 / 互环 /
  含内置件 / 同名不同 owner}；断言去重、去环、key 分配稳定且唯一。
- `resource-package-manifest.test.ts`：schema 正反例；`formatVersion` 高低版本判定。
- `resource-package-portable.test.ts`：三个新 Portable schema round-trip；工作组
  `leaderDisplayName ↔ leaderMemberId` 换算。
- `resource-package-secrets.test.ts`：**逐 carrier** 验证（MCP argv / URL 内嵌凭据 / headers /
  oauth / plugin spec / plugin options / frontmatterExtra / 工作流 passthrough / 脚本 env），
  **不**只断言「与 `redactMcpRecord` 一致」；断言 `requirements.pluginSources.spec` 同样脱敏；
  断言枚举字段不被脱敏。

### backend
- `rfc271-export-closure.test.ts`：AC-3 / AC-4 / AC-4b / AC-5 / AC-9 / AC-10 / AC-12。
- `rfc271-export-gates.test.ts`：AC-7（含 **AC-33 传递不可见**）、**AC-7b 预言机对照**
  （零匹配 vs 全不可见，断言响应逐字节相同）、AC-7c、AC-8 + AC-32（**分轴权限矩阵**）、AC-11。
- `rfc271-import-preview.test.ts`：AC-14 / AC-14b（多个 own match）/ AC-15 / AC-16 / AC-17 /
  AC-19。
- `rfc271-import-commit.test.ts`：AC-20（journal 各 phase 边界注入中断 + 重启收敛）/ AC-20b /
  AC-21 / AC-22（**复用+新建混合的同名重绑**）/ AC-24 / AC-24b（并发 409）。
- `rfc271-import-kernels.test.ts`：**AC-25** —— 导入后的技能能通过 `skillBootVerify`、
  有 `skill_versions` v1 与 content hash；插件 `cached_path` 非空。这是 `skill-zip.ts:415`
  那个「单测能过、活 daemon 上必挂」的坑的专门防线。
- `rfc271-package-antitamper.test.ts`：AC-2 未登记文件、zip slip、超深目录。
- `rfc271-routes.test.ts`：AC-30（两条旧路由不再注册 + 新导入端点 `tokenAccess:'never'`）。
- `rfc271-cli.test.ts`：AC-26 ~ AC-29（含「CLI 不是权限旁路」对照）。

### frontend
- `rfc271-export-actions.test.tsx`：六类详情页都有「导出配置包」；工作流那条不再叫「导出 YAML」。
- `rfc271-import-dialog.test.tsx`：三档动作渲染、标红阻断提交、多 own match 选择器、密钥输入、
  副本改名、类型不符跳转。
- `rfc271-capability-removal.test.ts`：源码层文本断言锁住 C1–C3。

### 显式改判的既有断言（预计）

| 文件 | 改判 | 原因 |
|---|---|---|
| `workflow-draft-export.test.ts` | 删本地草稿导出用例 | C3 |
| `workflow-import-dialog.test.tsx` | 整文件删除 | C2 |
| `workflows-pages.test.tsx` | 「导出 YAML」文案断言改判 | C1 |
| `rfc199-workflow-exact-operations.test.ts` | `operation:'export'` hook 断言改指新端点 | C1 |
| `rfc243-call-refs-yaml.test.ts` | YAML 导出断言迁移到包导出 | C1 |
| `route-error-code-coverage` | 新增错误码族登记 | 新路由 |
| RFC-270 的 export 出口用例 | 「遮蔽后可导出」→「按轴拒绝导出」 | C4 |

⚠️ `route-error-code-coverage` 用 `git ls-files` 枚举源文件，**未追踪的新文件对它是盲的**——
本 RFC 新增文件多，落地时必须先 `git add -N` 再跑门禁（`docs/dev-gotchas.md` 已有该定式）。

## 10. Codex 设计门 findings 落点

| # | 级别 | 落点 |
|---|---|---|
| A1 无持久化批次状态与可见性屏障 | P1 | §3.3 改为 pre-stage + big-tx（窗口本身消失）+ §3.4 新表 + 启动收敛 |
| A2 fence 只锁 ACL 不锁内容 | P1 | §3.3 内容级 CAS 表 + `skill_operation_locks` |
| A3 绕过技能版本状态机 / 插件预安装 | P1 | §0 要旨 3 + §3.3 复用既有内核；AC-25 + `rfc271-import-kernels.test.ts` |
| B1 包内无稳定身份 | P1 | §1.2 `packageResourceKey`；§3.2 `ownMatches[]` |
| B2 `project` 技能无处承载 | P2 | §1.3 `requirements.projectSkills` |
| B3 导出容环 / 导入要拓扑序 | P2 | §3.3 预铸 id，一次写入，不要求拓扑序 |
| C1 存在性预言机 | P1 | §2.1 两域两规则表 + AC-7b 逐字节对照测试 |
| C2 特权门未按轴 | P2 | §2.3 分轴 + AC-32 权限矩阵 |
| C3 CLI 导出无 Actor 来源 | P2 | §6 两条命令都要 `--as-user` + break-glass 边界说明 |
| D1 结构化密钥面不全 | P1 | §2.2 复用 `intentSecretSlots.ts` + 逐 carrier 测试 |
| D2 技能文件树密钥 | P1 | 按用户决策 18 **明确划出保证范围**（非目标 + 文档写明责任归属） |
| E1 能力清单漏项 | P2 | `proposal.md §5` 补 C6 / C7，拆 C5a / C5b，修正 C4 |
