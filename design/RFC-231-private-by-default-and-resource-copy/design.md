# RFC-231 资源默认私有与工作流/工作组一键复制 — design

状态：Implemented（2026-07-27；用户已批准实施；设计门与实现门均 APPROVED / 0 open
P0-P2；实现与验证完成）。

## 1. 当前事实与约束

### 1.1 ACL 资源是严格六类

`packages/shared/src/schemas/resourceAcl.ts` 的 `ACL_RESOURCE_TYPES` 当前闭集为：

```text
agent / skill / mcp / plugin / workflow / workgroup
```

Task 走成员制私有；Schedule、Memory、Fusion、Runtime 等有各自授权模型，不能因为用户说“所有
资源”就擅自给没有 visibility 的对象发明第七套 ACL。

六张表都有 `owner_user_id + visibility + acl_revision`。当前物理列 default 仍是 `public`，
`AclRow`/共享 DTO 也把缺失 visibility 当成 public，以兼容 migration 前数据和旧 fixture。

### 1.2 当前生产创建写点

所有支持的用户创建最终收敛到六个 canonical service：

| 类型      | 唯一用户 INSERT                                 |
| --------- | ----------------------------------------------- |
| Agent     | `services/agent.ts#createAgent`                 |
| Skill     | `services/skill.ts#createManagedSkillWithFiles` |
| MCP       | `services/mcp.ts#createMcp`                     |
| Plugin    | `services/plugin.ts#createPlugin`               |
| Workflow  | `services/workflow.ts#createWorkflow`           |
| Workgroup | `services/workgroups.ts#createWorkgroup`        |

其中 Workflow YAML import、Skill ZIP import、dynamic-workflow 保存等都调用上述 service，因此
默认值必须落在 service，而不是只改六个 HTTP route。

当前 `services/workgroup/dwActions.ts#dwSaveAsWorkflow` 有一个必须随本 RFC 一并闭合的创建旁路：
它先用 actor 做异步 `assertNewRefsUsable`，随后调用 `createWorkflow` 时却只传
`ownerUserId`、漏传 `actor`，使最终 `assertRefsUsableInTx` 以 `actor=null` 的 system 语义
绕过 visibility。RFC-231 在统一 actor-owned private 创建时必须补传 actor，并用“preflight 后
ACL 收紧”的 race test 锁住；不能把它当成与默认值无关而继续保留。

另有四类 built-in 写点：

- `services/fusion.ts#seedFusionResources` 创建/修复 Skill Fusion Agent 和 Workflow；
- `services/agentLaunch.ts#ensureAgentHostWorkflow` 直接 INSERT Agent host Workflow；
- `services/workgroup/launch.ts#ensureWorkgroupHostWorkflow` 直接 INSERT Workgroup host Workflow。

两个 host INSERT 目前依赖数据库 `public` default；RFC-231 后必须显式写 public，避免系统语义
继续靠历史 fallback。

### 1.3 当前“复制”只是冲突救援

- `workflows.edit.tsx` 的 `save-copy` 从 reducer 捕获冻结本地 snapshot，打开
  `QuickCreateDialog`，再 POST `/api/workflows`；
- `workgroups.detail.tsx` 使用同一 autosave intent，打开 `RenameDialog`，再 POST
  `/api/workgroups`；
- 两个正常态 More Dialog 都没有 Copy action。

救援态 snapshot 可能根本没有可读取的源版本，因此不能拿它替代正常态精确复制；正常态复制也
不能复用客户端 POST create，因为服务端无法原子绑定源 ACL、源 revision、自动命名与目标 insert。

## 2. 新建 ACL 的单一不变量

新增后端叶子 helper（命名以实现时避免现有符号冲突为准）：

```ts
const DEFAULT_USER_RESOURCE_VISIBILITY = 'private' as const

function initialPrivateResourceAcl(ownerUserId: string | null) {
  return {
    ownerUserId,
    visibility: DEFAULT_USER_RESOURCE_VISIBILITY,
    aclRevision: 0,
  }
}

function initialBuiltinResourceAcl(ownerUserId: string | null) {
  return { ownerUserId, visibility: 'public' as const, aclRevision: 0 }
}
```

合同：

- 六个 canonical create service 的非 builtin 分支必须展开
  `initialPrivateResourceAcl(...)`；所有 user route/生成器继续显式传 actor id，actor-backed
  service 断言 owner 与 actor 一致，不能把 ownerless private 行伪装成用户创建成功；
- Agent/Workflow 的 `builtin:true` 内部创建分支使用 `initialBuiltinResourceAcl(...)`；
- 两个 host Workflow 的直接 INSERT 显式使用 builtin helper；
- Fusion repair 的既有 public 写回保持显式；
- HTTP create/import/copy body 不接受 owner/visibility，owner 只能来自 server-resolved actor；
- `dwSaveAsWorkflow` 等 actor-backed generator 必须把同一个 actor 传播到 canonical service，
  让 owner stamp 与事务内 refs fence 绑定同一 principal；
- 新建目标没有 `resource_grants` INSERT，`aclRevision=0` 也由 helper 显式 stamp，不依赖列
  default。

这让“private”成为创建 service 的强制领域值，而不是 UI 默认值。任何新 route、importer 或
生成器只要复用 canonical service，就自动继承。

### 2.1 为什么不重建六张表

本 RFC **零 migration**，保留六列现有 SQLite `DEFAULT 'public'` 作为 legacy storage
fallback，但它不再定义受支持产品路径的默认语义。

SQLite 不能原地修改 column default。为了只改一个在生产 INSERT 中不再使用的 fallback，需要
关闭 FK 后重建六张高关联表、复制全部数据并重建 owner-name/index/FK，风险远高于所得收益。
尤其 Agents/Workflows/Workgroups 被 Task、成员、schedule、Fusion 等大量表引用；迁移错误会把
“默认值调整”升级为数据完整性事故。

防漂移方式不是放任 fallback：

1. 所有 production INSERT 都显式 stamp user-private 或 builtin-public；
2. `schema.ts` 注释明确物理 public 只是 legacy/raw-SQL fallback，不是产品默认；
3. 新增生产 writer inventory 测试，锁住六表所有 `.insert(...)` 写点及每个写点的 ACL 分类；
4. 六类 HTTP/派生路径行为测试直接断言 private 与跨用户不可见；
5. production source 中新增六表 INSERT 或新增 literal `visibility:'public'` 必须使守卫失败，除非
   被登记为 built-in。

Raw SQL、第三方直接写 SQLite 不属于受支持创建 API；backup/restore 则必须保留备份中的原 ACL，
不能套新默认值。

## 3. Copy API 合同

### 3.1 共享请求 schema

新增两个 strict schema：

```ts
CopyWorkflowRequest = {
  expectedVersion: positiveInt
  expectedSnapshotHash: WorkflowSnapshotHash
}

CopyWorkgroupRequest = {
  expectedVersion: positiveInt
  expectedSnapshotHash: WorkgroupSnapshotHash
}
```

新增端点：

```text
POST /api/workflows/:id/copy
POST /api/workgroups/:id/copy
```

成功均返回新建的 detail DTO 和 HTTP 201。body 有意不包含 name、description、definition、
members、owner、visibility、grants 或目标 id；这些全部来自事务内的精确源 snapshot 与服务端
规则。

不引入自动重试或 operation receipt：现有 create POST 也是一次 intent 一次创建，前端不会对
copy mutation 自动重放。同一个失败提示后的再次点击代表新的复制 intent。

### 3.2 授权与错误顺序

事务内按固定顺序处理，避免存在性/revision oracle 泄露：

1. 只读源 ACL 身份字段（id、owner、visibility、builtin）；缺失 →
   `workflow-not-found` / `workgroup-not-found` 404；
2. 从事务内 owner/visibility/grants 重新判断 actor 可见性；不可见 → 同形 404；在此之前
   不解析 definition、不读取成员、不计算 hash，避免隐藏/损坏源产生不同错误或时序 oracle；
3. Workflow `builtin=true` → `builtin-readonly` 403；
4. 比对 expected version + canonical snapshotHash；不符 → `workflow-copy-stale` /
   `workgroup-copy-stale` 409，并只向已经通过可见性门的 actor 返回 current revision；
5. 全量复核目标直接引用；失败沿用 `acl-missing-refs`；
6. Workgroup 全量复核 human member active；失败沿用
   `workgroup-member-user-invalid`；
7. 分配名称并插入目标。

需要在 `resourceAcl.ts` 提供同步的 in-transaction view gate，直接查询
`resource_grants`。route 的预读只改善 UX，绝不能替代事务内授权。

### 3.3 为什么复制要检查全部引用

普通 update 的 D15 只检查“新增引用”，因为旧资源可 grandfather 已有引用。副本是全新资源，
所有引用对它而言都是新增：

- 能查看一个 public/granted Workflow，不等于能直接创建引用其隐藏 Agent 的新 Workflow；
- 能查看 Workgroup，不等于能把其隐藏 Agent roster 复制成自己可编辑的新资源。

因此 copy 必须把 Workflow definition 中全部 Agent id、Workgroup 中全部 Agent member id 交给
`assertRefsUsableInTx`。manager/admin 按既有 resource-admin 规则通过，普通用户缺任何一个都
fail closed。缺失/隐藏 id 使用现有不枚举错误形状。

## 4. 原子复制服务

新增 `copyWorkflow` / `copyWorkgroup` service。两者的 source read、ACL fresh gate、revision
gate、引用/成员 gate、名称分配、目标 INSERT 必须处于同一个 `dbTxSync` 中，不允许：

- 先 GET 源、再调用普通 create 形成 check-then-write；
- 在 transaction callback 中 `await`；
- 由客户端回传内容；
- 先插目标再补成员/ACL。

### 4.1 Workflow

事务内：

1. 读取 raw Workflow row 的 ACL 身份字段并通过事务内 fresh view / builtin gate；
2. 只有授权后才解析/迁移 definition 到当前 schema，计算
   `workflowDraftSnapshotOf` 与 `workflowRevisionOf`；
3. 通过精确 revision 和全量 Agent refs gate；
4. 在 actor owner namespace 内选择 copy name；
5. 插入新 row：
   - 新 ULID；
   - description 与 definition 来自源 exact snapshot；
   - definition 按当前 storage serializer 写入；
   - `version=1`、`builtin=false`；
   - `initialPrivateResourceAcl(actor.user.id)`；
   - 新 createdAt/updatedAt；
6. 从 `INSERT RETURNING` 构造 response。

commit 后发送一次 `workflow.created`。不读取/复制 `resource_grants`、Task、Schedule、版本历史。
Schedule 引用源 Workflow id，因此天然不会转到目标。

### 4.2 Workgroup

事务内：

1. 读取 raw Workgroup row 的 ACL 身份字段并通过事务内 fresh view gate；
2. 只有授权后才读取按 sortOrder 排序的全部成员，构造 `workgroupDraftSnapshotOf` 与 exact
   revision；
3. 全量检查 Agent refs 与 human active；
4. 选择 actor owner namespace 的 copy name；
5. 插入新 Workgroup row，使用 private ACL、version=1、新时间；
6. 为 snapshot 中每个成员生成新 member ULID，保持顺序、displayName、roleDesc、canonical
   agentId/userId；Agent 的存储 name 从当前 canonical row 刷新；
7. 由 `leaderDisplayName` 映射到新 leaderMemberId；
8. 目标 row 与全部 member rows 同事务完成后才返回 detail。

commit 后发送一次 `workgroup.created`。源 workgroup task、room、message、assignment、
completion gate state 与 runtime snapshot 都以源 id/task id 为锚，不会被复制。

普通 create 与 copy 应抽取共享的 sync INSERT primitive，避免两条路径对 defaults、serializer、
member id 或广播 response 逐渐漂移；但不能把现有 async create 整体嵌入另一个 transaction。

## 5. 自动命名

新增后端纯函数（Workflow/Workgroup 共用）：

```ts
nextResourceCopyName(sourceName, occupiedOwnerNames, maxLength = 128): string
```

规则：

1. 先把 source 规范为 create-safe base：转小写，连续 `[^a-z0-9_-]` 变成 `-`，去掉两端
   `-/_`；结果为空时按类型回退 `workflow` / `workgroup`。这是对历史自由格式 Workflow
   grandfathering 的必要兼容，不做语言相关 transliteration；
2. 若规范后的 source 符合 `<base>-copy`，起始序号为 2；
3. 若符合 `<base>-copy-N`（N >= 2），从 N+1 起；
4. 否则先尝试 `<source>-copy`；
5. 已占用则递增 N，直到找到空位；
6. 每个候选先按 suffix 长度截断 base，再清理截断边界的尾部分隔符；若清理为空则重新使用类型
   fallback，最终必须由 `WorkflowNameSchema`/`WorkgroupNameSchema` 复核；
7. `occupiedOwnerNames` 只查询 `owner_user_id=actor.user.id` 的同类资源。

名称读取、候选选择和 INSERT 同事务。Workgroup 的
`workgroups_owner_name_unique` 是最后一道数据库盾；若未来支持多 daemon 写同一 DB，唯一冲突
映射为可重试的 name allocation，而不是把 SQLite 原错泄露给客户端。当前单 daemon 的同步事务
内不会发生 JS 级交错。Workflow 没有 name unique index，但同一同步事务仍保证本服务产生的自动
副本不互撞；用户手工重名继续合法。

## 6. 前端接线

### 6.1 Workflow editor

- `EditorModalSurface` 不新增独立 copy modal；Copy 仍属于 `actions` Dialog。
- `exactActionRef` 增加 `copy`，与 validate/export/launch 互斥。
- 点击后保持 actions Dialog 打开，按钮显示 `editor.copying` 并禁用其它 exact action。
- 调用 `controller.ensureSaved({signal})`，使用返回的
  `server.version + server.snapshotHash` POST copy。
- 成功后更新/失效 Workflow query cache，关闭 surface，跳转新 id。
- 失败留在原页，在 Dialog 内用 `ErrorBanner`/现有 API error formatter 显示；unmount abort。
- phase 为 inaccessible/deleted 时禁用；autosave conflict 会让 ensureSaved 失败并继续暴露现有
  save-copy 救援 CTA。

### 6.2 Workgroup editor

- `headerSurface='actions'` 内增加 Copy；不增加新 surface。
- 点击后调用 `controller.ensureSaved()`，再用
  `controller.isSavedDraftCurrent(saved)` 防止复制已被新本地编辑取代的 receipt。
- POST exact revision，成功 publish detail/query cache 并跳转；失败保留 Dialog 和错误。
- incomplete transient member editor 会沿用 autosave block reason，不能静默遗漏成员。

### 6.3 现有救援态

`controller.requestCopy()` 与 `save-copy` Dialog 保留。它们仍走普通 create route，因此 canonical
create service 的 private 默认和 route actor owner 已经覆盖用户强调的 owner 规则。测试必须
分别锁正常 copy 与救援 save-copy，不能只测其中一条。

### 6.4 i18n / 可访问性

中英对称新增：

- `common.copy`（若已有则复用）；
- `editor.copyActionHint` / `workgroups.copyActionHint`；
- `editor.copying`；
- 两类 copy stale/失败的用户文案（优先复用统一 API error）。

Action item 是真实 button，有 pending/disabled 状态和可见 focus ring。操作成功后的导航由新页
标题承接焦点；失败时错误进入可读区域。More Dialog 继续使用现有公共 `Dialog` 与
`.workflow-editor-action-list`，不新增菜单/CSS 原语。

## 7. WS、缓存与信息边界

`workflow.created` / `workgroup.created` 帧已经在 `ws/registry.ts` 对每个连接按目标 row 重新跑
`canViewResource`。新 private 行在 broadcast 前已 commit：

- owner/grantee/resource admin 通过；
- stranger 被 frame gate 丢弃；
- 新 id 不存在旧 visibility cache。

本 RFC 不在 created frame 增加 owner/visibility，也不把 private name 发给未授权连接。新增 WS
测试用两个普通用户验证 created frame 与 list invalidation 都不泄露。前端成功导航依赖 HTTP
201 response，不依赖自己能否收到 WS。

## 8. 创建路径覆盖矩阵

| 路径                                 | 新建结果                                     | 特殊规则                          |
| ------------------------------------ | -------------------------------------------- | --------------------------------- |
| 六类普通 POST                        | actor owner + private                        | body 不接受 visibility            |
| Skill ZIP create / rename-as-new     | importer owner + private                     | overwrite 保留目标 ACL            |
| Workflow YAML new/fail-create        | importer owner + private                     | overwrite 保留目标 ACL            |
| Dynamic Workgroup 保存 Workflow      | action actor owner + private                 | 补传 actor，最终 refs gate 入事务 |
| Workflow/Workgroup 救援 save-copy    | 当前 actor owner + private                   | 客户端冻结本地 snapshot           |
| Workflow/Workgroup 正常 copy         | 当前 actor owner + private                   | exact source + server auto-name   |
| Fusion/其它 canonical user generator | 调用 actor owner + private                   | 只要进入 canonical service 即继承 |
| Skill Fusion built-ins               | system owner 语义 + public+builtin           | 明确例外                          |
| Agent/Workgroup host Workflow        | 既有 system/NULL owner 语义 + public+builtin | 明确例外、显式 stamp              |
| Backup restore                       | 原值                                         | 不是新建默认                      |

## 9. 测试策略

### 9.1 shared / pure

- Copy request schema strict：合法 exact revision 通过；name/owner/visibility/content 等多余键拒绝；
- `nextResourceCopyName`：首份、递增、copy-of-copy、手工占位、不同 owner 隔离、中文/空格/
  全非法的 grandfathered Workflow 名、128 字符边界；
- Workgroup snapshot 转新成员 id/leader 映射的纯函数测试。

### 9.2 backend 默认私有

六类 HTTP create matrix：

- response owner=alice、visibility=private、aclRevision=0；
- Alice GET/list 可见；
- Bob list 排除，detail 与真实 missing 404 同形；
- Alice 通过现有 ACL PUT 改 public 后 Bob 可见。

派生路径逐项覆盖 Skill ZIP create、Workflow YAML create、dynamic save Workflow、两类救援态
普通 POST payload；dynamic save 增加 preflight 后 Agent ACL 收紧的 race，证明最终事务仍拒绝；
overwrite 断言 ACL 未变。production writer inventory guard 锁住六表全部 INSERT 与 built-in
public 白名单。

升级兼容测试读取 migration 前后同一批 public/private 行，逐行 visibility 不变；不把旧
`rfc099-migration-0045` 的历史 default 断言错误改成 private。

### 9.3 backend copy

Workflow 与 Workgroup 共享场景：

- owner 复制自己的 public/private 源；
- grantee 复制他人 private 源：目标 owner=grantee、private、无 grants，源 owner看不到目标；
- manager/admin 复制：owner 是真实 actor，不是 source owner；
- public source 的普通 viewer 复制；
- missing/invisible 404 byte-equivalent；
- source ACL/revision 在 preflight 与 tx 间变化，事务内 fresh gate 正确拒绝；
- expected version 或 hash stale → 409 且无目标；
- 引用存在但 actor 不可用 → `acl-missing-refs` 且无目标；
- copy-of-copy 与并发 copy 命名；
- source grants/ACL revision/timestamps 不传播；
- created broadcast 只发生一次且在 commit 后。

Workflow 额外断言 definition storage/current schema、version 1、builtin source 拒绝、Task/Schedule
不复制。Workgroup 额外断言全配置、顺序、leader 映射、所有 member id 新、inactive human
原子拒绝、Task/room/messages 不复制。

### 9.4 frontend

- More Dialog action 顺序、copy pending/disabled、成功导航；
- Workflow/Workgroup 都先调用 ensureSaved 并发送精确 version+hash；
- pending 期间不能连点；失败保留原页并显示错误；
- phase inaccessible/deleted 禁用；
- conflict/incomplete member 不静默创建；
- 救援 save-copy 仍开命名表单，正常 copy 不开；
- i18n key 对称与键盘 focus/restore。

### 9.5 WS / 真浏览器

- 两个普通用户的 `/ws/workflows`、`/ws/workgroups`：private created 只到 owner，改 public 后 ACL
  更新与后续 updated 正常送达；
- desktop light：Workflow 从改动草稿 → More → Copy → 新页，核对 name/owner/private；
- 390px dark：Workgroup 含长成员名复制，核对 action list、pending、跳转、无横向溢出；
- 键盘完成 More→Copy，检查焦点；两条 scene 均跑 axe critical/serious。

### 9.6 门禁

按改动风险执行 shared/backend/frontend 定向与相关全量、typecheck、lint、format、depcheck、
`bun run build:binary` + test-only binary smoke。declare done 前跑 Codex 实现门并闭合所有
P0/P1/P2。

## 10. 失败模式与回滚

| 失败                      | 行为                                                    |
| ------------------------- | ------------------------------------------------------- |
| autosave invalid/conflict | 不发 copy；保留现有状态说明与救援 CTA                   |
| source 删除/ACL 收紧      | 事务内 404；不留下目标                                  |
| source revision 漂移      | 409 stale；重新保存/重试                                |
| hidden/missing ref        | fail closed；不复制可见源的隐含能力                     |
| inactive human member     | Workgroup 整体失败，不部分复制 roster                   |
| name 冲突                 | 同事务递增；DB unique 为最终盾                          |
| broadcast listener 失败   | 已有 best-effort 语义；HTTP 201 仍返回 committed detail |
| UI 网络错误               | 留在源页、显示错误；不自动重放 mutation                 |

回滚生产代码可恢复旧 create helper 与移除 copy endpoint/UI；因为没有 migration、没有新表列，
数据库无需降级。已经按新规则创建的 private 资源仍保持 private，回滚不得擅自把它们改 public。

## 11. 设计裁决

| 编号 | 决策                                             | 被拒方案                              |
| ---- | ------------------------------------------------ | ------------------------------------- |
| D1   | 六类用户资源 canonical create 默认 private       | 只改 Workflow/Workgroup               |
| D2   | 现有行零 backfill                                | 全库收紧（会破坏既有分享）            |
| D3   | built-in 显式 public                             | 跟随用户默认变 private                |
| D4   | 副本 owner=请求 actor、零 grants                 | 继承源 owner/ACL                      |
| D5   | 正常 copy 一键、服务端自动命名                   | 先开命名表单                          |
| D6   | copy 精确保存版本，源/ACL/ref/name/insert 同事务 | 客户端 GET 后 POST create             |
| D7   | 可查看源即可复制，但目标全部引用重新授权         | 只允许 owner；或盲目继承隐含引用      |
| D8   | 保留救援 save-copy 为独立路径                    | 用 normal copy 替换，丢失本地冲突草稿 |
| D9   | 零 migration，显式 writer + inventory guard      | 为 SQLite default 重建六张高关联表    |

本 RFC supersede RFC-099 D18/D20 中“其它资源默认 public”的部分；RFC-099 的读取兼容、404
不枚举、ACL 管理、Task 成员制私有与 D15 普通 update 语义继续有效。
