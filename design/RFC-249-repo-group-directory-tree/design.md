# RFC-249 — 仓库组目录树 · 技术设计

> 对应 `proposal.md` D1–D22、AC-1…AC-22。本文写实现契约，不重复产品动机。

## 1. 现状断点

当前链路的权威表示均是「仓成员列表」：

- shared：`RepoGroupMemberInput[]`，路径字段在成员上；
- DB：`repo_group_members`，一行必为 repo 或 group；
- service：`FlattenableGroup.members` → `PlannedRepo[]`；
- preview/layout：只返回 `repos[]`；
- frontend：`RepoLayoutTree.buildLayoutTree(repos)` 从仓挂载路径反推父子关系；
- task：`task_repos` 是重跑时唯一冻结布局。

因此没有仓的目录在任意一层都无处保存。RFC-249 用一个规范表示贯穿定义、展开和
快照，避免前端另造「视觉目录」后在保存/重跑时丢失。

## 2. 共享模型

### 2.1 定义层

```ts
const RepoNodeAttachmentInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('repo'),
    cachedRepoId: z.string().min(1).optional(),
    repoUrl: z.string().min(1).optional(),
    ref: z.string().default(''),
    subdir: z.string().default(''),
    readonly: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('group'),
    childGroupId: z.string().min(1),
    readonly: z.boolean().default(false),
  }),
])

const RepoGroupNodeInputSchema = z.object({
  path: z.string(), // '' = root
  attachment: RepoNodeAttachmentInputSchema.nullable().default(null),
})
```

仓挂载继续执行 `cachedRepoId ⊕ repoUrl` XOR；子组不带 `ref/subdir`；纯目录的
`attachment` 为 `null`。Create/Update/Preview 改收 `nodes`：

```ts
CreateRepoGroup = {
  name: string
  description: string
  nodes: RepoGroupNodeInput[] // 1..128，必须含且只含 root
}

UpdateRepoGroup = CreateRepoGroup & { expectedVersion?: number }
```

三个写 schema 继续允许路由给出结构化业务错误，但路由在 parse 前调用
`assertNoRetiredRepoGroupKeys(raw)`；只要对象含自有属性 `members`，返回
`repo-group-members-retired`。不能让非 strict Zod 把它剥掉。

出网 `RepoGroupNode` 把 URL 改为 `repoUrlRedacted`，带 `schemaVersion: 2`。组 DTO
删除 `members`，增加 `nodes`、`directNodeCount`，保留 `flatRepoCount`、
`boundMemories` 与 OCC `version`。

### 2.2 展开层

```ts
interface PlannedDirectoryNode {
  path: string
  origins: Array<{
    groupId: string
    groupName: string
    viaGroups: Array<{ id: string; name: string }>
  }>
}

interface ResolvedRepoGroupLayout {
  nodes: PlannedDirectoryNode[]
  repos: PlannedRepo[]
  maxGroupDepth: number
}
```

`PlannedRepo` 保持 RFC-248 wire，`mountPath` 对应它所挂节点的 `path`。一个目录
可能由本组与多个子组投影合并，因此目录使用 `origins[]` 而不是伪造唯一
`viaGroups`。layout 响应为加法扩展：保留 `repos/totalRepos/maxDepth`，新增
`nodes/totalNodes`。这里保留 `repos` 是为了现有任务详情与外部只读客户端平滑升级；
写入则只接受 `nodes`，避免有损 round-trip。

`RepoLayoutTree` 接收 `nodes + repos`：节点来自后端，不再从 repo path 补父目录。
节点是否挂仓由同 path 的 `PlannedRepo` 映射；子组来源仍由 `viaGroups` 表示。

### 2.3 常量

```ts
MAX_GROUP_NODES = 128 // 单个定义，含根
MAX_FLAT_NODES = 256 // 子组展开后去重的目录节点
MAX_FLAT_REPOS = 32 // 沿用 RFC-248
MAX_GROUP_DEPTH = 5 // 沿用 RFC-248
```

现有独立 group-edge traversal budget 保留；节点预算不能取代它，因为大量空子组边仍
可能在不新增节点/仓的情况下放大遍历。

## 3. 路径与树不变量

### 3.1 规范化

`normalizeMountPath` 重命名/包一层为更中性的 `normalizeRepoNodePath`，旧导出在本
RFC 内部调用迁完后删除。保持 RFC-248 的所有约束：

- 相对路径，`''` 只表示根；
- NFC；折叠重复 `/`；
- 拒绝 `.` / `..`、反斜杠、C0/C1、U+2028/U+2029、绝对路径；
- 根段不得是 `.agent-workflow-inputs`；
- 集合内按大小写不敏感判重。

`subdir` 继续复用同一安全字符规则，但不参与目录闭包。

### 3.2 定义闭包

`validateRepoGroupNodes(nodes)` 一次完成：

1. 规范化所有 path；
2. 恰好一个 `''`；
3. 规范 path 大小写不敏感唯一；
4. 每个非根 path 的 `dirname` 必须在集合中；
5. attachment 结构合法；
6. 节点/仓数量预算合法；
7. 返回按规范 path 排序的新数组，不原地修改调用方。

错误 detail 使用 `nodePath`，不再使用易漂移的 `memberIndex`；URL 导入逐项失败时
同时带原输入下标，便于批量粘贴定位。

### 3.3 纯树操作

shared 新增无 React/DB 依赖的纯函数：

- `parentNodePath(path)` / `nodeName(path)` / `joinNodePath(parent, name)`；
- `buildRepoNodeTree(nodes)`；
- `renameNodeSubtree(nodes, path, nextName)`；
- `moveNodeSubtree(nodes, path, nextParent)`；
- `deleteNodeSubtree(nodes, path)`；
- `attachAtNode(nodes, path, attachment)` / `detachAtNode(...)`；
- `allocateRepoNodePath(parent, repoUrl, occupied)`。

前端交互与后端校验共享路径代数；移动/重命名先生成完整候选树，任一冲突则返回错误，
不产生半套变更。

### 3.4 同级排序

`compareRepoNodePath` 逐段比较：先 `toLocaleLowerCase('en-US')`，再按原字符串兜底。
树 UI 按同级目录名排序；仓物化按 `mountDepth(path)`、再用该比较器排序。数据库
不保存 display order。

## 4. 展开算法

### 4.1 最小视图

```ts
interface FlattenableGroupV2 {
  id: string
  name: string
  nodes: ReadonlyArray<{
    path: string
    attachment: FlattenableAttachment | null
  }>
}
```

### 4.2 递归与合并

`flattenRepoGroupTree(rootId, load)` 维护：

- `nodeByFoldedPath`：展开节点；
- `repoByFoldedPath`：实际仓挂载；
- 当前 group chain：环检测与 `viaGroups`；
- group-edge traversal budget；
- `maxGroupDepth`。

访问组 G、前缀 P、继承只读 R：

1. 对 G 的每个节点 N 计算 `full = joinNodePath(P, N.path)`，把目录合并进
   `nodeByFoldedPath`；同路径纯目录可重复出现。
2. N 无 attachment：结束该节点。
3. N 挂 repo：若 `repoByFoldedPath` 已有仓，抛 `repo-group-attachment-conflict`，
   detail 带 `nodePath`、`firstViaGroups`、`secondViaGroups`；否则追加
   `PlannedRepo`，readonly 为 `R || attachment.readonly`。
4. N 挂 group：递归访问 child，前缀为 `full`，继承只读为
   `R || attachment.readonly`。
5. 每次新增唯一节点/仓和每次走 group edge 都立即检查各自预算。

这样子组根与挂载节点自然合并；外层本地子节点与子组子树也走同一冲突规则。最终
补断言：每个 PlannedRepo 的 path 必在 nodes 中，所有 nodes 仍满足祖先闭包。

### 4.3 保存时祖先复核

沿用 RFC-248 的事务内 `assertFlattenable + assertAncestorsStillFlattenable`，但查询
引用关系改读 node attachment。修改一个被多个父组引用的子组时，所有祖先都要在
同一事务提交前重新展开，防止节点/仓预算或路径碰撞在父组下才出现。

## 5. 持久层

### 5.1 `repo_group_nodes`

实现时取下一个可用 migration 编号，不在 RFC 写死：

```sql
CREATE TABLE repo_group_nodes (
  group_id          TEXT NOT NULL,
  path              TEXT NOT NULL,
  attachment_kind   TEXT,            -- NULL | repo | group
  cached_repo_id    TEXT,
  ref               TEXT NOT NULL DEFAULT '',
  subdir            TEXT NOT NULL DEFAULT '',
  child_group_id    TEXT,
  readonly          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, path),
  CHECK (attachment_kind IS NULL OR attachment_kind IN ('repo','group')),
  CHECK (
    (attachment_kind IS NULL AND cached_repo_id IS NULL AND child_group_id IS NULL
       AND ref = '' AND subdir = '' AND readonly = 0) OR
    (attachment_kind = 'repo' AND cached_repo_id IS NOT NULL AND child_group_id IS NULL) OR
    (attachment_kind = 'group' AND child_group_id IS NOT NULL AND cached_repo_id IS NULL
       AND ref = '' AND subdir = '')
  ),
  FOREIGN KEY (group_id) REFERENCES repo_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (cached_repo_id) REFERENCES cached_repos(id),
  FOREIGN KEY (child_group_id) REFERENCES repo_groups(id)
);
CREATE UNIQUE INDEX idx_rgn_path_ci
  ON repo_group_nodes(group_id, lower(path));
CREATE INDEX idx_rgn_cached_repo ON repo_group_nodes(cached_repo_id);
CREATE INDEX idx_rgn_child_group ON repo_group_nodes(child_group_id);
```

FK 仍不 cascade 删除 cached repo/child group，删除服务先锁内重查并显式 detach。
`repo_groups.schema_version` 更新为 2。

迁移每个旧组：

1. 插入 root `''`；
2. 用 recursive CTE 把每条旧 `mount_path` 拆成全部祖先路径，`INSERT OR IGNORE`
   纯目录；
3. 在终点节点写原 repo/group attachment；
4. SQL 内做可失败断言：旧 member 总数等于新 attachment 总数、每条旧 member 的
   cached id/ref/subdir/path/readonly/child group 在新表有唯一等价行、每组恰有 root、
   不存在缺父节点；
5. 计数、索引与 `foreign_key_check` 通过后，删除 `repo_group_members`。

SQL migrator 无法调用 TypeScript 展开算法；「旧算法 vs 新算法逐项等价」由 migration
集成测试在真实 v1 fixture 上、升级前后各运行一次完成，不能把测试承诺伪装成生产
migration 内的能力。

不能长期双写两张表；否则 pure directory 天生无法在旧表表达，读写事实源会分叉。

### 5.2 `task_space_nodes`

```sql
CREATE TABLE task_space_nodes (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  node_path      TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (task_id, node_path)
);
CREATE UNIQUE INDEX idx_task_space_nodes_path_ci
  ON task_space_nodes(task_id, lower(node_path));
```

只保存展开后的目录路径；仓的冻结来源/ref/subdir/readonly 仍由 `task_repos` 负责，
不复制。启动事务在写 `tasks` 与 `task_repos` 的同一事务内写全部 node rows。

旧任务不 backfill：历史组定义已可变，无法证明当时是否存在纯目录。读取/重跑时若
零 node rows，就只从冻结的 `task_repos.mount_path` 及其祖先构造最小闭包；这不会
虚构历史纯目录。

## 6. 服务与 API

### 6.1 CRUD

`materializeNodes` 取代 `materializeMembers`：

1. 先规范化/闭包校验；
2. 事务外 resolve 所有 `repoUrl`，避免 clone 占写锁；
3. 事务内重读 OCC version、全量替换 nodes、展开目标组及所有祖先；
4. 成功后 version +1；任一错误整笔回滚。

`GET /api/repo-groups` 与 `/:id` 返回定义 nodes；`/:id/layout` 返回展开 nodes+repos；
`POST /preview` 接受未保存 nodes，URL attachment 不导入，只计
`pendingImports` 并保留对应目录节点。

preview 中只给 URL 的仓使用**仅内存 pending 占位**：它不进入 `PlannedRepo[]`、不
暴露原 URL，但会占住所挂 path、计入 32 仓预算并参与与子组展开仓的 attachment
碰撞检查。否则「URL 仓与子组根仓撞在同一节点」会预览通过、保存导入后才 422。

### 6.2 删除引用

- `groupsReferencingRepo` 查询 `attachment_kind='repo'`；force 删除 cached repo 将
  对应 row 更新为纯目录：清空 kind/id/ref/subdir/readonly，不删 row。
- force 删除 child group 同理清空 `group` attachment；`detachedReferences` 仍按挂载
  个数计。
- 更新后在同一事务校验所有受影响组。force 操作允许组展开为 0 仓，沿用现有
  `repo-group-empty` 启动拦截，但树闭包和节点预算仍必须合法。

### 6.3 API 与 MCP

路由与权限点不变。API 文档及 MCP `repo-groups` resource payload 更新为 v2。
管理写遇到 `members` 返回具名 422；读取仍保留 layout 的 `repos[]`，但组定义不再
返回 `members[]`。所有 URL 输出继续走 `repoUrlRedacted`。

## 7. 任务物化与重放

### 7.1 解析结果

`resolveRepoGroupLayout` 返回 `{ repos, nodes, maxDepth, groupName }`。
`loadFrozenLayout` 改为 `loadFrozenSpaceLayout`，同时读取：

- `task_repos` → PlannedRepo；
- `task_space_nodes` → node paths；若无行则从 repo mount paths 补最小闭包。

`sourceTaskId` 的可见性守卫保持在现有四个启动入口，不因本 RFC 绕过。

### 7.2 分支选择

```ts
const onlyRootRepo =
  repos.length === 1 &&
  repos[0].mountPath === '' &&
  repos[0].subdir === '' &&
  nodes.length === 1 &&
  nodes[0].path === ''
```

只有 `onlyRootRepo` 回落当前单仓分支。其它 repoGroup/sourceTask 布局都走
`materializeGroupSpace`，并传入完整 node paths。

### 7.3 组空间物化顺序

物化继续持有现有 `MaterializedSpaceCleanup` lease：

1. 解析所有仓来源；
2. 在建任何 worktree 前，对**仓挂载点**执行现有 git-tree 占用检查；纯目录不作为
   嵌套仓排除点；
3. 按路径深度/路径建仓 worktree，并在层间写现有 `.gitignore` 预置 commit；
4. 所有仓成功后，按深度创建**没有被仓 worktree 占据**的显式目录；展开结果不保留
   原始 attachment，但可用 repo mount path 集合精确判定；
5. 逐路径段 `lstat`：目录通过，缺失段逐个 `mkdir`，symlink 或非目录抛
   `repo-group-directory-occupied`；每一步都验证实际路径仍在 group root 内；
6. 返回的 `MaterializedSpace` 携带 `nodePaths`，启动事务据此写快照。

若纯目录位于已挂仓内且该目录已由仓 checkout 出来，步骤 5 幂等复用；若缺失则成为
空目录，后续文件天然进入该祖先仓。纯目录不会加入 `.gitignore`，只有真正的子仓
挂载点才排除。

### 7.4 失败与回收

目录创建发生在 lease 保护的 owned root/worktree 内；任一失败走现有 catch，按深度
逆序删除 worktree，再删除 owned root。测试注入 symlink、文件占用及第 N 个 mkdir
失败，断言无 task row、无注册 worktree、无 owned root 残留。

## 8. 前端结构

### 8.1 组件边界

- `RepoGroupEditor`：保留 Dialog/OCC/query/mutation 外壳，改持有 flat draft nodes。
- `RepoTreeEditor`：新公共编辑组件，负责树行、选择、多选、移动、重命名、attach/
  detach 与 inline settings；不发网络请求。
- `RepoBulkAddDialog`：已有仓多选与 URL 多行输入；返回一批 attachment 草稿。
- `RepoLayoutTree`：公共只读投影改收服务端 nodes+repos；组列表与任务详情继续复用。
- `OperationsExpandButton`：任务列表与仓库组列表共用的展开按钮；统一 chevron、命中区、
  focus ring 与 `aria-expanded/controls`。
- 路径变换全部调用 shared 纯函数，React 组件不自行拼字符串。

不引入新的 DnD 依赖。桌面用受控 HTML drag events 触发同一个
`moveNodeSubtree`；触摸/键盘走 `Select` 驱动的「移动到…」。如果原生拖放在 WebKit
验证不稳定，拖放降为渐进增强，但「移动到…」仍是完整交付路径。

### 8.2 编辑器布局

从上到下：

1. 紧凑元数据行：名称；说明默认折叠为「添加说明」，已有说明则展开。
2. 工具条：添加仓库、粘贴 URL、新建目录；右侧显示 `N 个仓 · M 个目录`。
3. 单棵树：root 常驻；普通行 36px；hover/focus 才显快捷操作。
4. 选中节点后的 inline panel：
   - 目录段名称与 breadcrumb；
   - 挂载来源（已有仓/URL/子组）；
   - repo 的 ref/subdir/readonly；
   - 解除挂载、移动到、删除目录。
5. 批量选择后工具条替换为批量 readonly/移动/detach/delete + 取消选择。
6. footer 保留取消/保存；保存被本地未完成项、preview 422 或 mutation pending 阻断。

### 8.3 平铺批量添加

`RepoBulkAddDialog` 的已有仓页支持搜索与多选；确认后基于当前选中目录调用
`allocateRepoNodePath`。URL 页一行一条：

- 空行忽略；
- 非 URL、非 Git SSH/scp-like 地址就地标红；
- 重复行合并并提示；
- 每行预览生成目录名；
- 确认只更新草稿，真正导入发生在保存。

### 8.4 子组投影

定义树只允许编辑本组的节点。挂子组的行可展开服务端 preview 返回的只读 ghost
子树，带「来自 <group>」标识；ghost 节点不可直接移动/删除，操作入口是打开对应组。
本组本地子节点与 ghost 节点同屏，碰撞由 preview 在对应 path 上显示错误。

### 8.5 响应式与 a11y

- ≥ 768px：36px 常态行，inline panel 使用紧凑 grid；
- < 768px：行点击目标 ≥44px，工具条主操作 + overflow，inline panel 单列；
- 深度 > 4 后固定 8px 缩进并在选中面板显示完整 breadcrumb；
- 长 URL/组名允许换行或在展开面板完整显示，常态行可以短名 + title，但不能只有
  无法查看全值的 ellipsis；
- tree/treeitem、level/expanded/selected/multiselectable 完整；移动后 focus 回到节点，
  删除后回到最近可见父节点；错误与批量结果写 `aria-live="polite"`。

### 8.6 资源页与任务启动

`/repos` 用现有 `TabBar` 的页面级下划线形态承载「远端仓库 / 仓库组」，并给两块
内容显式 `tabpanel` 语义。组列表展开目录树时直接使用 `OperationsExpandButton`。

任务向导的 remote 空间始终挂载一个 `RepoSourceRow`：缓存仓与仓库组同列；组布局
作为该行 details 展开。默认状态不渲染 URL、ref 或自动同步说明；选择「输入新的
Git URL…」后才渲染 URL，且仅在缓存仓已选中或手工 URL 非空时渲染 ref。这样既保留
手工地址逃生口，也避免在尚未做来源决策时提前展示第二、第三个输入框。

## 9. 错误契约

沿用路径/结构错误，并新增：

| code                             | 含义                          | detail                             |
| -------------------------------- | ----------------------------- | ---------------------------------- |
| `repo-group-members-retired`     | v1 `members` 写入已退役       | `replacement: 'nodes'`             |
| `repo-group-root-missing`        | 没有 root                     | —                                  |
| `repo-group-multiple-roots`      | 多个 root                     | `count`                            |
| `repo-group-parent-missing`      | 非根节点父目录未显式保存      | `nodePath`, `parentPath`           |
| `repo-group-node-limit`          | 直接或展开节点超限            | `limit`, `actual`, `phase`         |
| `repo-group-attachment-conflict` | 展开后同一路径两个仓          | path + 两条 via group 链           |
| `repo-group-directory-occupied`  | 纯目录路径被文件/symlink 占用 | `nodePath`, `occupiedPath`, `kind` |

大小写重复继续使用现有 path collision 类错误；错误文案从「member」改成「node」。

## 10. 测试设计

### 10.1 shared

- 定义闭包：root、缺父、多根、大小写/NFC、保留路径、128/256 边界；
- attach/detach、rename/move/delete subtree 的不变性与原子失败；
- URL slug 与 `-2/-3` 分配；
- 子组根合并、纯目录合并、纯目录+repo 合并、双 repo 冲突来源链；
- group edge、node、repo 三种预算相互独立；
- 排序与同源仓分支后缀稳定。

### 10.2 migration/backend

- 造根仓、无根仓、三层嵌套、同仓两份、group member、readonly/sparse 的 v1 数据；
  migration 前后展开结果逐字段相等；
- schema CHECK、索引集合、FK、计数与闭包断言；
- CRUD/preview/OCC/祖先复核；URL preview 零导入；
- `members` retired 锁，防 Zod 静默 strip；
- force delete repo/group 只 detach、目录与后代仍在；
- task snapshot 同事务、current group drift/delete 后 sourceTask 重放；旧任务 fallback；
- 纯目录在 neutral/root repo/nested repo 三类位置落盘；tracked dir 复用；文件/symlink
  占用与中途失败全量回收；
- degenerate root-only 单仓 exact baseline 与「多一个目录」组分支分界；
- RFC-248 全部 runtime/diff/readonly/sparse tests 保持绿。

### 10.3 frontend

- 20/32 仓批量添加、冲突后缀、URL 逐行错误与 pending import；
- 默认紧凑行、单节点 inline edit、切换焦点；
- detach 保目录、delete 子树确认计数；
- 多选 readonly/move/detach/delete 原子语义；
- drag 与 Select move 同构，非法目标禁用；
- root 不可删除/移动且无「主仓」文案；
- ghost child group 只读、碰撞错误锚到 path；
- 390/736/desktop 无 overflow，移动端 touch target；
- keyboard-only、focus restore、aria tree/live region；
- zh-CN/en-US key parity；公共组件源码守卫继续防止自造 Dialog/Field/QueryState chrome。

### 10.4 浏览器与视觉

Playwright Chromium + WebKit 覆盖：新建平铺组、整理层级、root 挂仓+子节点、批量
readonly、移动、detach、保存重开、任务详情目录树。视觉基线至少：

- 1440px：20 仓平铺与三层树；
- 736px：inline edit；
- 390px：批量模式与移动选择器；
- hosted Ubuntu 与本地 macOS 对比。

## 11. 实施顺序与兼容门

1. 先落 shared v2 model/纯函数与 DB nodes migration；迁移必须可在现有 v1 数据上
   独立验证。DB 从此只存 nodes，但 API 边界暂时把 v1 `members` 无损翻译为
   「attachment nodes + 自动祖先闭包」，读响应也只投影 attachment nodes，因而当前
   UI 仍可用。这个过渡层不是第二张事实表，且此阶段不接受/产生纯叶目录。
2. 在公开 wire 仍是 v1 时完成 task snapshot/materialize/replay；此时所有现有布局都
   已经经过 node runtime，但用户尚不能创建旧 UI 无法表示的纯目录。
3. 新编辑器、API/MCP v2 `nodes`、`members` 退役 422 在**同一批**原子切换，随后
   删除边界翻译层。这样不存在「后端只认 nodes、前端仍发 members」或「旧 UI 编辑
   后吞纯目录」的共享-main 窗口。
4. layout 的 `repos[]` 始终保留为 additive compatibility；删除旧存储表、旧定义类型、
   旧 UI 与所有 `memberIndex` 用户文案，源码锁确保没有双模型残留。

任一中间提交都必须完整编译、测试可运行；不允许出现「后端只认 nodes、前端仍发
members」的共享 main 中间态，具体切分见 `plan.md`。

## 12. 未采用方案

### A. 只重写前端，把纯目录继续压成 mountPath 前缀

无法保存空叶目录，任务快照/重跑必丢，违背用户确认的树模型。

### B. 保留 members，再加一个 `directories[]`

同一棵树被拆成两个可独立漂移的数组；attach/detach、子组合并与 force delete 都要
跨数组维护，仍不是「仓挂在节点」的模型。

### C. `parent_id + node_id` 的邻接表

可提供稳定节点 id，但本功能所有运行时/审计 key 都是规范路径，PUT 也是 OCC 下的
全量替换。引入跨行 parent FK、递归删除与 id round-trip 增加复杂度，却没有当前
消费方需要节点级独立寻址。规范 path + 显式父闭包更贴合现有系统。

### D. 永远使用组空间，删除单仓 baseline

会让最小的「root 上一个整仓」相对 RFC-248 发生无必要路径漂移；D19 保留严格退化
分支，同时保证任何真实目录树都走完整组物化。
