# RFC-271 · 技术设计

配套 `proposal.md`。锚点均为本仓当前源码（2026-08-08）。

## 0. 设计要旨

三条承重线：

1. **闭包遍历是纯函数，IO 在外层**。「谁依赖谁」的推导（`collectClosure`）只吃已经取回内存的
   资源行，不自己查库；DB 读取由一个批量装载器负责。这样闭包规则可以脱离 DB 单测，也不会在
   递归里打出 N+1 查询。
2. **manifest 是权威清单，其余段是派生索引**。`resources` 决定导入读哪些文件；`graph` /
   `requirements` / `secrets` 只供人类与预检页阅读，**导入侧一律不消费**——否则就是 RFC-146
   禁止的假单一事实源。
3. **导入的原子性靠「FS 暂存 → DB 事务 → FS 原子入位」三段式**，唯一需要补偿的窗口是第三段
   （见 §5.3）。既有技能 zip 导入是逐个尽力而为（`commitSkillZipBuffer` 累加
   `created/updated/skipped/failed`），本 RFC **不复用那个语义**，因为配置包有依赖顺序，
   半成品会产出启动即报错的工作流。

## 1. shared 契约层

新文件 `packages/shared/src/resourcePackage.ts`（+ 从 `index.ts` re-export）。

### 1.1 常量

```ts
export const PACKAGE_FORMAT_VERSION = 1

/** 复用技能 zip 的同一套上限（proposal 决策 8）。导出与导入共用这一份判据。 */
export const PACKAGE_LIMITS = SKILL_ZIP_LIMITS   // 总 64MB / 单文件 10MB / 2000 条目 / 12 层

/** 目录名 ← 资源类型；同时是导入侧的合法顶层目录白名单。 */
export const PACKAGE_DIRS = {
  agent: 'agents',
  skill: 'skills',
  mcp: 'mcps',
  plugin: 'plugins',
  workflow: 'workflows',
  workgroup: 'workgroups',
} as const satisfies Record<AclResourceType, string>

/** 脱敏后的字段值。导入侧遇到它一律当「未提供」，绝不写成字面量。 */
export const PACKAGE_SECRET_PLACEHOLDER = '<REDACTED:SECRET>'
```

`AclResourceType` 已存在（`schemas/resourceAcl.ts`），六类与 `IMPORT_REF_TYPES`
（`schemas/importRef.ts`）逐字对齐，无需新枚举。

### 1.2 manifest schema

```ts
export const PackageResourceEntrySchema = z.object({
  type: AclResourceTypeSchema,
  name: z.string().min(1).max(256),
  /** zip 内路径。目录型（skill）以 '/' 结尾。 */
  path: z.string().min(1).max(1024),
}).strict()

export const PackageManifestSchema = z.object({
  formatVersion: z.literal(PACKAGE_FORMAT_VERSION),
  /** currentAppVersion()（services/backupManifest.ts）。仅供人类判断包多旧。 */
  platformVersion: z.string(),
  exportedAt: z.number().int(),
  root: PackageResourceEntrySchema,
  /** 权威清单：导入只读这里列出的文件。 */
  resources: z.array(PackageResourceEntrySchema).min(1),
  /** 派生索引 · 依赖边，仅供 README 与预检页展示。 */
  graph: z.array(PackageEdgeSchema).default([]),
  /** 框架内置依赖声明（不进包，导入时按名字绑本地内置件）。 */
  builtins: z.array(z.object({
    type: AclResourceTypeSchema, name: z.string().min(1),
  }).strict()).default([]),
  /** 环境要求：导入方需要自备什么。绝不含密钥。 */
  requirements: PackageRequirementsSchema,
  /** 派生索引 · 待填密钥。字段路径用点号，如 `config.env.GITHUB_TOKEN`。 */
  secrets: z.array(z.object({
    resourceType: AclResourceTypeSchema,
    resourceName: z.string().min(1),
    field: z.string().min(1),
  }).strict()).default([]),
}).strict()
```

`PackageRequirementsSchema` 四段，全部只放非敏感字段：

| 段 | 字段 | 来源 |
|---|---|---|
| `runtimes` | `name` / `protocol` / `model` | `runtimes` 表；**不含** `binaryPath` / `extraArgsJson` / `lastProbeJson` |
| `codeHosts` | `provider` | `code-host-call` 节点的 `provider`；**不含** base URL / token |
| `executables` | `command`（argv[0]） | MCP local 的 `config.command[0]` |
| `pluginSources` | `name` / `sourceKind` / `spec` | `plugins` 表 |

每段带 `usedBy: PackageResourceRef[]`，让预检页能说清「缺这个会影响哪个资源」。

### 1.3 可移植资源文档 schema

工作流与代理已有可移植形态，直接复用；MCP / 插件 / 工作组是新的：

| 类型 | 包内格式 | 复用 | 新增 |
|---|---|---|---|
| workflow | YAML | `stringifyWorkflowYamlDocument` + `WorkflowDefinitionSelectorSchema` | 去掉 `id`（决策 12：不记源资源 id） |
| agent | `.md` | `serializeAgentMarkdown` / `parseAgentMarkdown` | 无 |
| skill | 目录树 | `SKILL.md` 已是 frontmatter+body（`skill-md.ts`） | 无 |
| mcp | YAML | — | `PortableMcpSchema` |
| plugin | YAML | — | `PortablePluginSchema` |
| workgroup | YAML | — | `PortableWorkgroupSchema` |

```ts
/** 只有可移植配置；无 id / owner / visibility / aclRevision / 时间戳。 */
export const PortableMcpSchema = z.discriminatedUnion('type', [
  z.object({ name: McpNameSchema, description: z.string(), type: z.literal('local'),
             enabled: z.boolean(), config: McpLocalConfigSchema }).strict(),
  z.object({ name: McpNameSchema, description: z.string(), type: z.literal('remote'),
             enabled: z.boolean(), config: McpRemoteConfigSchema }).strict(),
])

export const PortablePluginSchema = z.object({
  name: PluginNameSchema, description: z.string(), spec: PluginSpecSchema,
  options: PluginOptionsSchema, enabled: z.boolean(), sourceKind: PluginSourceKindSchema,
}).strict()   // 决策 13：无 cachedPath / resolvedVersion / installedAt

export const PortableWorkgroupSchema = z.object({
  name: WorkgroupNameSchema, description: z.string(), instructions: z.string(),
  mode: WorkgroupModeSchema, switches: WorkgroupSwitchesSchema,
  maxRounds: z.number().int().positive(), completionGate: z.boolean(),
  clarifyBudget: z.number().int().min(0).max(50).optional(),
  fanOut: z.boolean().optional(),
  members: z.array(PortableWorkgroupMemberSchema),
  /** 成员 displayName；null = 无负责人。members 里的 id 是本地行 id，不可移植。 */
  leaderDisplayName: WorkgroupMemberDisplayNameSchema.nullable(),
}).strict()

export const PortableWorkgroupMemberSchema = z.discriminatedUnion('memberType', [
  z.object({ memberType: z.literal('agent'), agentName: z.string().min(1),
             agentOwnerUsername: z.string().min(1).optional(),
             displayName: WorkgroupMemberDisplayNameSchema,
             roleDesc: z.string(), sortOrder: z.number().int() }).strict(),
  z.object({ memberType: z.literal('human'), username: z.string().min(1),
             displayName: WorkgroupMemberDisplayNameSchema,
             roleDesc: z.string(), sortOrder: z.number().int() }).strict(),
])
```

工作组的 `leaderMemberId` 是本地行 id，改用 `leaderDisplayName` 承载
（`uq_workgroup_members_display` 保证组内 `displayName` 唯一，可以当组内稳定键）。

### 1.4 闭包遍历（纯函数）

```ts
export interface ClosureNode {
  type: AclResourceType
  id: string
  name: string
  ownerUserId: string | null
  builtin: boolean
}

/** 一个资源直接引用了谁。只吃已装载的行，绝不查库。 */
export function directRefsOf(node: LoadedResource): ClosureRef[]

/** 广度优先 + visited 去重去环；返回稳定顺序（类型 → 名字字典序）。 */
export function walkClosure(
  root: ClosureRef,
  load: (refs: ClosureRef[]) => LoadedResource[],   // 批量装载器，由后端注入
): ClosureResult
```

`directRefsOf` 的每类规则（**全部有源码锚点**）：

| 资源 | 引用 | 提取自 |
|---|---|---|
| workflow | agent | `extractWorkflowAgentRefs`（`services/resourceRefs.ts:39`），`agent-single.agentId` |
| workflow | workflow | `extractWorkflowWorkflowRefs`（同上 `:64`），`call-workflow.workflowName` |
| workflow | workgroup | `extractWorkflowWorkgroupRefs`（同上 `:69`），`call-workgroup.workgroupName` |
| agent | skill | `agents.skills` 里 `kind:'managed'` 的 `skillId`（`kind:'project'` 是仓内技能，**不进包**，进 requirements 备注） |
| agent | mcp | `agents.mcp`（id 数组） |
| agent | plugin | `agents.plugins`（id 数组） |
| agent | agent | `agents.dependsOn`（id 数组） |
| workgroup | agent | `workgroup_members` 里 `memberType='agent'` 的 `agentId` |
| skill / mcp / plugin | — | 叶子，无下游依赖 |

`call-workflow` / `call-workgroup` 是**名字域**引用（RFC-243）：装载器按名字解析，命中 0 个
→ 记入 `dangling`（导出侧当作「本地就没有」，写进 README 的警示段，不算失败）；命中 2+ 个
→ 422 `package-export-ambiguous-ref`（导出方必须先把名字理清，包里不能有二义引用）。

## 2. 后端 · 导出

新文件 `packages/backend/src/services/resourcePackage/export.ts`。

### 2.1 流程

```
loadRoot(actor, type, id)                    ← ACL 可见性（沿用 loadVisibleXxx）
  → assertExactRevision(root, expectedVersion)  ← AC-12，仅根资源
  → walkClosure(root, batchLoader)
  → assertAllVisible(actor, closure)            ← AC-7，任一不可见 ⇒ 422
  → assertNoPrivilegedNodeWithoutPermission()   ← AC-8 / C4，见 §2.3
  → partition(closure) → { exportable, builtins }
  → serializeEach() → PackageFile[]             ← 脱敏在这一步
  → collectRequirements(closure)
  → buildManifest() + buildReadme()
  → assertWithinLimits(files)                   ← AC-11
  → zip(files)
```

`batchLoader` 每一层做一次 `inArray` 批量查询（每类型一次），层数 = 闭包深度，无 N+1。

### 2.2 脱敏（AC-6）

单一事实源 `PACKAGE_SECRET_FIELDS`，与 `services/tokenRedaction.ts:118` 的
`redactMcpRecord` 覆盖同一组字段（那里是读路径的规则，这里是包的规则，两者用同一份字段清单，
测试断言两边一致，防漂移）：

| 资源 | 字段 |
|---|---|
| mcp local | `config.env.*`（值 → 占位符，键保留） |
| mcp remote | `config.headers.*`、`config.oauth.clientSecret` |
| workflow | `script` 节点的 `env.*` |

**枚举字段绝不脱敏**——RFC-270 的教训：把枚举脱成占位符会让严格 schema 解析失败，而
validator 正是拿它们再解析的。这里同理，只脱字符串值字段。

每脱敏一处，向 `manifest.secrets` 追加一条索引。

### 2.3 特权节点门（C4 / AC-8）

```ts
const lens = workflowReadLensFor(actor)          // services/tokenRedaction.ts:75
if (!lensIsTransparent(lens.privileged) && closureHasPrivilegedNode(closure)) {
  throw new ValidationError('package-privileged-node-forbidden', ...)
}
```

`lensIsTransparent` / `PrivilegedNodeLens` 来自 RFC-270 的
`packages/shared/src/privilegedNodeRedaction.ts:41,43`。判定覆盖闭包内**每一个**工作流
（包括递归带出的子工作流），不只根。

这是对 RFC-270 的**显式改判**：那条路径今天是「遮蔽后仍可导出」，现在是「拒绝导出」。
`design/RFC-270-.../design.md §2.2` 里关于 export 出口的描述随之勘误。

### 2.4 zip 打包

复用 `services/skill-zip.ts:62` 的 `decodeZip` 的对偶方向。仓内目前**只有解 zip 没有打 zip**，
需要一个 `encodeZip(files: PackageFile[]): Uint8Array`：store-only（无压缩）实现，约 120 行，
放 `packages/backend/src/util/zip.ts`。选 store-only 是为了不引第三方依赖、且包里主要是文本，
压缩收益不抵审计成本；`PACKAGE_LIMITS` 的 64 MB 是对**未压缩**大小的约束，语义因此更直白。

## 3. 后端 · 导入

新文件 `packages/backend/src/services/resourcePackage/import.ts`。

### 3.1 两步式（无服务端暂存态）

沿用技能 zip 导入的既有姿势（`parseSkillZipBuffer` / `commitSkillZipBuffer` 都收 buffer，
前端持有文件、传两次），**不引入服务端临时存储**：

```
POST /api/resource-packages/preview   multipart: file       → PackagePreview
POST /api/resource-packages/commit    multipart: file + decisions(JSON) → PackageImportReport
```

`commit` 重新解析 zip；决策绑定预检时的 `resourceId + expectedAclRevision`，与
`ImportRefSelection`（`schemas/importRef.ts:39`）逐字同构，fence 校验直接复用
`assertImportRefsStableInTx`（`services/importRefs.ts:172`）。

### 3.2 预检（AC-14 / AC-15 / AC-17 / AC-19）

对包内每个资源产出一行：

```ts
export interface PackagePreviewEntry {
  type: AclResourceType
  name: string
  /** 本地匹配（决策 9）：先找 actor 自己拥有的同名，再列全部可见同名候选。 */
  ownMatch: ImportRefCandidate | null
  candidates: ImportRefCandidate[]
  /** 可选动作。'overwrite' 仅当 ownMatch !== null 才出现（AC-15）。 */
  allowedActions: Array<'reuse' | 'new' | 'overwrite'>
  defaultAction: 'reuse' | 'new' | 'overwrite'
  /** 'new' 时的建议名字，已避开本地冲突（AC-16）。 */
  suggestedName: string
  /** 缺失的权限点；非空 ⇒ 该行标红且整包不可提交（AC-17）。 */
  missingPermissions: PermissionKey[]
  /** 待填密钥（AC-18）。 */
  secretFields: string[]
}
```

`ImportRefCandidate`（`schemas/importRef.ts:55`）已带 `id / ownerUserId / ownerUsername /
visibility / aclRevision`，正好是候选选择器需要的全部信息，直接复用。

权限判据（AC-17）逐类：`reuse` 需要 `<type>:read`；`new` 需要 `<type>:create`；
`overwrite` 需要 `<type>:update`。工作流额外：包内任一工作流含 `script` 节点需
`scripts:author`、含 `code-host-call` 节点需 `code-host-calls:author`——这两个门今天就在
`prepareWorkflowSave` / `insertWorkflowInTx` 两个持久化原语上（RFC-270），预检只是把它**提前
可见**，不新增强制点，也绕不过。

内置依赖（AC-9 / 决策 6）单独一段 `builtins: PackageBuiltinCheck[]`，本地找不到同名内置件
→ 标红。

人类席位（AC-19）单独一段：`humanSeats: { workgroup, displayName, username, matchedUserId }`，
`matchedUserId === null` 时必须由用户选「指派本地用户」或「删除该席位」，未处理不可提交。

### 3.3 提交（AC-20 / AC-21 / AC-22）

**依赖顺序**（拓扑序，闭包遍历的逆序）：

```
skills → mcps → plugins → agents(按 dependsOn 拓扑) → workgroups → workflows(按 call 拓扑) → root
```

**三段式落地**：

1. **FS 暂存**：所有新建 / 覆盖的技能树写入 `${appHome}/skills/.import-<ulid>/<skillId>/`，
   只做路径与大小校验，不碰正式目录。失败 → 删暂存目录，零副作用。
2. **DB 事务**：一个 `dbTxSync` 内插入 / 更新全部六类 DB 行，并在同一事务内
   `assertImportRefsStableInTx` 复核 fence（AC-24）。失败 → 事务自动回滚 + 删暂存目录，零副作用。
3. **FS 入位**：把暂存目录里的技能树 `renameSync` 到 `skillRootAbs(appHome, skillId)`
   （`services/skillIdentityPaths.ts:31`）。**这是唯一需要补偿的窗口**：中途失败则
   ① 把已入位的目录移回暂存、② 跑一个补偿事务删除第 2 步插入的行 / 恢复被覆盖行的旧内容、
   ③ 删暂存目录。补偿本身失败时写一条 `recovery_events` 并把错误原样抛给调用方（不吞）。

覆盖技能时，旧目录先移到 `.import-<ulid>/backup/`，补偿时从那里移回——与 `skillOperations`
（RFC-170 §6a）的 swap 姿势同源，但这里是**批量**语义，所以不复用它的单技能状态机，而是在
本服务里自持一份批量 backup 台账（写在暂存目录内，crash 后由启动期扫描清理）。

**owner / visibility（AC-21）**：新建一律 `ownerUserId = actor.user.id`、
`visibility = 'private'`、零 grants（RFC-231 硬规则）；覆盖**不写** owner / visibility /
grants 三列。

**引用重绑（AC-22）**：第 2 步在同一事务内，用「包内名字 → 本次落地 id」的映射表回填：
`agent-single.agentId`、`call-workflow.workflowId`、`call-workgroup.workgroupId`、
`agents.skills[].skillId`、`agents.mcp[]`、`agents.plugins[]`、`agents.dependsOn[]`、
`workgroup_members.agentId`。映射表优先本次导入结果，包外引用（内置件）才回退到本地按名解析。

### 3.4 防夹带（AC-2）

解 zip 后：路径必须落在 `PACKAGE_DIRS` 白名单顶层目录或是 `manifest.yaml` / `README.md`；
每个文件必须在 `manifest.resources[].path` 里登记（技能目录按前缀匹配）；出现未登记条目 →
422 `package-unlisted-entry`。zip slip（`..` / 绝对路径 / 符号链接）由 `decodeZip`
（`services/skill-zip.ts:62`）既有的归一化保证，本服务复用它而不是自己再写一遍。

## 4. 路由与权限

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/agents/:id/export-package` | `agents:read` | 下同，六类各一条 |
| GET | `/api/skills/:id/export-package` | `skills:read` | |
| GET | `/api/mcps/:id/export-package` | `mcps:read` | |
| GET | `/api/plugins/:id/export-package` | `plugins:read` | |
| GET | `/api/workflows/:id/export-package` | `workflows:read` | `?expectedVersion=` 沿用 AC-12 |
| GET | `/api/workgroups/:id/export-package` | `workgroups:read` | `?expectedVersion=` |
| POST | `/api/resource-packages/preview` | 六类 `*:read` 的并集 | 只读预检 |
| POST | `/api/resource-packages/commit` | 同上 + 逐条按动作校验 | 见 §3.2 |
| ~~GET~~ | ~~`/api/workflows/:id/export`~~ | — | **下线**（C1 / AC-29） |
| ~~POST~~ | ~~`/api/workflows/import`~~ | — | **下线**（C2 / AC-29） |

**不新增权限点**（目录保持 67 条）。预检 / 提交端点的粗粒度权限取六类 `*:read`，真正的
授权判据在 §3.2 的逐条校验里——这与 RFC-099「保存时只校验新增引用」的分层姿势一致：路由门
挡住完全无关的人，业务门做精确判据。

`tokenAccess`：导出 `'allow'`（与现有 export 一致）；导入两个端点 `'deny'`——导入会新建资源并
决定权属，不是令牌该做的事（与 `POST /api/workflows/import` 今天的 `'allow'` 相比是收紧，
一并写进 §能力影响，但因为端点本身就下线，不单列一条）。

## 5. 前端

### 5.1 导出入口（AC-1）

六类详情 / 编辑页的「更多操作」抽屉各加一条，复用现有 `.btn` / `<Dialog>` 结构：
- 工作流：`routes/workflows.edit.tsx:1191` 的「导出 YAML」**原地改名**为「导出配置包」，
  `downloadWorkflowServerExport` 换成 `downloadPackage`；
- 工作组：`routes/workgroups.detail.tsx` 的动作抽屉新增（今天没有导出）；
- 代理 / 技能 / MCP / 插件详情页各新增一条。

新 `lib/resource-package-download.ts`：把 `workflow-draft-export.ts` 的
`safeDownloadBaseName`（RFC-264 的 Unicode 安全文件名）抽出来共用，然后**删除**该文件的
本地草稿导出路径（C3 / AC-30）。

### 5.2 导入预检页（AC-13 / AC-14）

新组件 `components/ResourcePackageImportDialog.tsx`，走 `<Dialog size="full">`；每一行用既有
公共原语，**不自写 chrome**：

| 元素 | 用什么 |
|---|---|
| 弹窗 | `components/Dialog.tsx`（overlay / portal / focus trap / ESC 全自带） |
| 动作三选一 | `.segmented`（`styles.css`，2–N 短选项互斥的既有约定） |
| 候选资源选择 | `components/Select.tsx`（RFC-036 自带 popover，禁止原生 `<select>`） |
| 副本名 / 密钥输入 | `components/Form.tsx` 的 `<Field>` + `<TextInput>` |
| 状态标记 | `<StatusChip>` |
| 错误 / 空 / 加载 | `<ErrorBanner>` / `<EmptyState>` / `<LoadingState>` |

`WorkflowImportDialog.tsx` 的 YAML 路径**删除**（C2）；其冲突对话框的交互模式（fail / new /
overwrite 三档 + revision 展示）被新预检页吸收，是它的超集。

导入入口（AC-13）：六类列表页各一个「导入配置包」按钮 + 一个统一入口；上传后先读 manifest 的
`root.type`，与当前页不符则 `router.navigate` 到对应列表页并把已解析的文件透传过去继续预检。

## 6. CLI

`packages/backend/src/cli/package.ts`，在 `cli/start.ts` 的命令表注册两条：

```
agent-workflow export-package --type <t> --name <n> [--owner <username>] -o <file>
agent-workflow import-package <zip> --as-user <username>
        [--plan | --apply <plan.yaml>] [--on-conflict reuse|new|fail] [--dry-run]
```

- `--as-user` **必填**（AC-26）：解析成一个真实 `users` 行，构造与 HTTP 同构的 `Actor`
  （含其权限矩阵），全部授权判据走**同一套服务函数**，CLI 不是旁路（AC-28）。
- `--plan` 输出的决策文件就是 `PackagePreview` 的 YAML 形态 + 每条的 `action` 默认值；
  `--apply` 读回来做 schema 校验后直接喂给 commit 服务。
- `--on-conflict` 是「把每条 `action` 一次性设成同一档」的语法糖，与 `--plan` 互斥。
- 与 `cli/restore.ts:23` 的 `--dry-run` / `--yes` 两段式风格保持一致。

## 7. 数据与迁移

**零迁移、零 schema 变更、零新表、零新权限点。** 包是纯文件产物，导入走既有 CRUD 服务的
写入路径（`createAgent` / `createWorkflow` / `createWorkgroup` / …），不绕过任何既有校验或门。

## 8. 失败模式与取舍

| 场景 | 行为 | 理由 |
|---|---|---|
| 闭包内有不可见资源 | 422，不产半包 | 决策 3；沿用 `workflow-export-ref-unavailable` 的 fail-closed |
| 闭包内有特权节点且无权限 | 422 | 决策 7 / C4 |
| `call-workflow` 名字命中 0 个 | 导出成功，README 警示 | 名字域引用本来就 dangle-tolerant（RFC-243） |
| `call-workflow` 名字命中 2+ 个 | 422 `package-export-ambiguous-ref` | 包里不能有二义引用，否则导入无从选择 |
| 超体积上限 | 422 并点名资源 + 维度 | AC-11 |
| 导入中途失败 | 全回滚 | 决策 10 / AC-20 |
| 第 3 段补偿也失败 | 写 `recovery_events` + 原样抛错 | 不吞错误；留下可追的现场 |
| `formatVersion` 更高 | 拒绝，提示升级 | AC-23；不猜未来格式 |
| 包内出现未登记文件 | 422 `package-unlisted-entry` | 防夹带（AC-2） |
| 技能是 `kind:'project'`（仓内技能） | 不进包，进 requirements 备注 | 仓内技能属于代码仓，不属于平台资源 |

**已知不对称（显式承认，不修）**：包不携带资源的版本号 / 修改时间 / ACL 授权名单，所以
「导出→导入→再导出」不是字节幂等的。这是决策 4 与决策 12 的直接后果，不是缺陷。

## 9. 测试策略

### shared（纯函数，无 DB）

- `resource-package-closure.test.ts`：六类根 × {无依赖 / 线性链 / 菱形共享 / 自环 / 互环 /
  含内置件}；断言去重、去环、稳定顺序。
- `resource-package-manifest.test.ts`：manifest schema 正反例；`formatVersion` 高低版本判定。
- `resource-package-portable.test.ts`：三个新 Portable schema 的 round-trip；工作组
  `leaderDisplayName` ↔ `leaderMemberId` 的换算。
- `resource-package-secrets.test.ts`：**锁住脱敏字段清单与 `redactMcpRecord` 一致**（防漂移）；
  断言枚举字段不被脱敏。

### backend

- `rfc271-export-closure.test.ts`：AC-3 / AC-4 / AC-5 / AC-9 / AC-10 / AC-12。
- `rfc271-export-gates.test.ts`：AC-7（不可见依赖 422）、AC-8 + AC-31（特权节点 422，**含无
  权限者的显式改判用例**）、AC-11（四个维度各一条）、二义引用 422。
- `rfc271-import-preview.test.ts`：AC-14 / AC-15（他人资源无 overwrite 选项）/ AC-16 /
  AC-17（逐权限点）/ AC-19（人类席位三种结局）。
- `rfc271-import-commit.test.ts`：AC-20（三段式各注入一个故障点，断言 DB 与 FS 都干净）/
  AC-21 / AC-22（引用绑到本次结果而非本地同名）/ AC-24（fence 409）。
- `rfc271-package-antitamper.test.ts`：AC-2 未登记文件、zip slip、超深目录。
- `rfc271-routes.test.ts`：AC-29 断言两条旧路由**不再注册**。
- `rfc271-cli.test.ts`：AC-25 / AC-26 / AC-27 / AC-28。

### frontend

- `rfc271-export-actions.test.tsx`：六类详情页各有「导出配置包」；工作流那条不再叫
  「导出 YAML」。
- `rfc271-import-dialog.test.tsx`：预检页三档动作渲染、标红阻断提交、密钥输入、副本改名、
  类型不符跳转。
- `rfc271-capability-removal.test.ts`：**源码层文本断言**锁住 C1–C3——
  `downloadWorkflowLocalDraft` 不得再出现在任何源文件；`WorkflowImportDialog` 不再存在;
  `/api/workflows/:id/export` 与 `/api/workflows/import` 不得出现在 `client.ts`。

### 显式改判的既有断言（预计）

| 文件 | 改判 | 原因 |
|---|---|---|
| `workflow-draft-export.test.ts` | 删除本地草稿导出用例 | C3 |
| `workflow-import-dialog.test.tsx` | 整文件删除 | C2 |
| `workflows-pages.test.tsx` | 「导出 YAML」文案断言改判 | C1 |
| `rfc199-workflow-exact-operations.test.ts` | `operation: 'export'` 的 hook 断言改指新端点 | C1 |
| `rfc243-call-refs-yaml.test.ts` | YAML 导出断言迁移到包导出 | C1 |
| `route-error-code-coverage` | 新增错误码族登记 | 新路由 |
| RFC-270 的 export 出口用例 | 「遮蔽后可导出」→「拒绝导出」 | C4 / AC-31 |

**注意**：`route-error-code-coverage` 用 `git ls-files` 枚举源文件，未追踪的新文件对它是盲的
——本 RFC 新增文件多，落地时必须先 `git add -N` 再跑门禁（`docs/dev-gotchas.md` 已有该定式）。
