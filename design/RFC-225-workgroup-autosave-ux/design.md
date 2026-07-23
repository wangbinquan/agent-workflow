# RFC-225 工作组版本化自动保存与一致性 UX — design

状态：In Progress（2026-07-23，用户以「开始」批准实施；页头对齐追加需求并入 §7.2）。
以 `proposal.md` 为产品合同。

## 1. 当前接缝与必须保留的不变量

### 1.1 前端

- `routes/workgroups.detail.tsx` 通过两个 `useOwnedEditScope` 分别拥有 config 与完整 members
  draft，再由 `buildCompositeUpdatePayload()` 捕获一个 full-document PUT；
- `edit-scope` 已有 submitted revision、late receipt、dirty-vs-remote、ambiguous outcome 等纯
  语义，不能退回 `setDirty(false)`；
- `reconcileWorkgroupSaveResponse()` 会校验请求/响应的每个语义字段，再把服务端重建的 member id
  映射回 local key；selection 以 local key 为准；
- 临时“新增成员”草稿由 `WorkgroupContextPanel` 持有并上报 dirty/valid/discard，不属于可直接
  持久化的 roster。

### 1.2 后端

- `UpdateWorkgroup` 是 config + members 整文档替换，事务内更新 `workgroups` 并替换
  `workgroup_members`；
- `workgroups` 有 `schema_version`、`acl_revision`、`updated_at`，但没有内容 version；
- launched task 冻结完整 config，资源更新只影响未来任务；
- member agent 引用在 RFC-223 后以 agent id 为内部 identity；本 RFC 不重新引入 name fallback。

### 1.3 设计不变量

1. 一个工作组内容只有一个前端 writer 与一个后端 save service；
2. 一次保存永远捕获 metadata + config + ordered members + leader 的完整语义快照；
3. `version` 是内容并发真值，`aclRevision` 仍只管 ACL，`schemaVersion` 仍只管 wire/schema 演进；
4. response-loss 只能用 matching mutation/revision/hash 对账，不能把普通 query refresh 当成
   某次请求的成功回执；
5. member local key、focus 和 selection 不以每次服务端生成的 row id 为 UI identity；
6. 任何真实冲突 fail closed，绝不静默覆盖。

## 2. 总体数据流

```text
字段编辑 / 成员动作 / RenameDialog
              │
              ▼
route-owned composite draft
  metadata + config + members + leader + transient validation
              │
      valid? ─┴─ no → blocked status（零请求）
              │ yes
      debounce 1s / discrete immediate
              │
              ▼
single-flight autosave coordinator
  localRevision + queuedRevision + clientMutationId + expectedVersion
              │
              ▼
PUT /api/workgroups/:id
  { expectedVersion, clientMutationId, snapshot }
              │
              ▼
dbTxSync: fresh auth → logical equality → CAS → group/member write
              │
      exact SaveWorkgroupReceipt
              │
              ├──────────────► /ws/workgroups frame
              ▼
settle captured revision; newer local revision remains dirty and flushes next
```

## 3. Shared wire 与 canonical revision

### 3.1 editable snapshot

以 RFC-223 完成后的 id-canonical schema 为基线，新增专用类型：

```ts
type WorkgroupDraftSnapshot = {
  name: string
  description: string
  instructions: string
  mode: WorkgroupMode
  leaderDisplayName?: string
  switches: WorkgroupSwitches
  maxRounds: number
  completionGate: boolean
  clarifyBudget: number
  fanOut: boolean
  members: WorkgroupMemberDraftInput[] // agentId / userId，ordered
}

type WorkgroupRevision = {
  workgroupId: string
  version: number
  snapshotHash: string
  updatedAt: number
}

type UpdateWorkgroup = {
  expectedVersion: number
  clientMutationId: string // ULID
  snapshot: WorkgroupDraftSnapshot
}

type SaveWorkgroupReceipt = {
  clientMutationId: string
  requestedBaseVersion: number
  revision: WorkgroupRevision
  snapshot: WorkgroupDraftSnapshot
  workgroup: WorkgroupDetail
  outcome: 'committed' | 'already-current'
}
```

`WorkgroupDetail = Workgroup + { snapshotHash }`；`Workgroup` 增加 `version`。list row 不要求计算
hash，detail/create/save receipt 必须带 hash。

`leaderDisplayName` 沿用现有 group-unique addressing token，不把瞬时 local key 发上 wire。实施时
必须以 RFC-223 最终 `WorkgroupMemberDraftInput` 为准：agent member 的机器 identity 是
`agentId`，human 是 `userId`；name 只作 DTO 展示，不能重新成为引用键。

### 3.2 canonical bytes / hash

shared 新增：

```ts
serializeWorkgroupEditableSnapshotV1(snapshot)
hash = sha256('agent-workflow/workgroup-editable/v1\n' + canonicalJson(normalizedSnapshot))
```

规范化包含字段默认值、成员顺序、leader 关系和所有用户可编辑字段；排除：

- workgroup/member DB id；
- owner/visibility/aclRevision；
- createdAt/updatedAt/schemaVersion/version；
- agent/user 的展示型派生字段。

排除 member DB id 是 response-loss 幂等的必要条件：当前 full-replace 可能生成新 id，但相同用户
意图必须有相同 logical hash。前后端使用同一 serializer；不能一边 `JSON.stringify`、另一边另写
排序器。

## 4. 数据库与保存事务

### 4.1 migration

```sql
ALTER TABLE workgroups ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
```

迁移号取落地时 HEAD+1；journal/tag/when/statement-breakpoint 与 rolling-upgrade 守卫同批更新。
fresh DB 与升级 DB 都必须得到 version=1。

### 4.2 save service

`saveWorkgroup(db, id, input, principal)` 成为唯一内容写入口。actor/system principal 必须显式，
不保留 `actor?: Actor` 的隐式绕过。

算法：

1. transaction 外 parse/normalize snapshot、算 submitted logical bytes，做 human active 与新增
   agentId 可用性 preflight；
2. 进入 `dbTxSync`，按稳定 id 重读 workgroup + ordered members；
3. 基于 fresh row 重做 current owner/resource-admin 写门，防 owner transfer 与 preflight 交错；
4. 投影 current snapshot/revision，比较 logical bytes；
5. `current.version !== expectedVersion`：
   - bytes 相同：返回 `already-current`，用于提交成功但响应丢失后的同意图重试；
   - bytes 不同：`409 workgroup-version-conflict`，details 带 current revision；
6. version 相同且 bytes 相同：返回 `already-current`；不改 updatedAt、不重建成员、不 broadcast；
7. version 相同且内容变化：
   - 原子更新 workgroups 可编辑列、`version + 1`、`updatedAt`；
   - 只有 ordered roster/leader 的逻辑投影变化时才替换 `workgroup_members`；纯 metadata/config
     自动保存必须保留 member rows/id；
   - 同一 transaction 内读取刚写入的 row/member rows，构造唯一 committed receipt；
   - UPDATE 用 `WHERE id=? AND version=? RETURNING` 防御性锁 CAS，零行即冲突；
8. commit 后才发 WS；broadcast 失败不回滚 DB，HTTP receipt 仍是 authoritative。

禁止“写完后 transaction 外 GET 再返回”：另一 writer 可在间隙推进版本，导致 A 请求拿到 B 的
内容。名称唯一性、引用失败、权限失败和 CAS 失败均保证零内容写。

### 4.3 writer 收敛

- 主 `PUT /api/workgroups/:id` 只接新 fenced schema；
- Rename endpoint 若为兼容保留，必须要求 expectedVersion/clientMutationId，读取 exact snapshot、
  只替换 name/description 后调用同一 save service；frontend 不再使用它；
- create 返回 version=1 的 detail 并 broadcast created；
- delete body 增 expectedVersion/clientMutationId，在 fresh tx row 上做 confirm + version gate，再
  broadcast deleted；不能删除一个用户尚未看见的新内容版本；
- 所有直接 `update(workgroups)` 可编辑列或 `delete(workgroupMembers)` 的生产写入均由结构守卫
  限定在 save/delete service。

## 5. WebSocket 多标签同步

新增 `/ws/workgroups` 与 `WS_PATHS.workgroups`：

```ts
type WorkgroupsWsMessage =
  | { type: 'workgroup.created'; workgroupId: string; name: string; version: number }
  | {
      type: 'workgroup.updated'
      workgroupId: string
      clientMutationId: string
      version: number
      snapshotHash: string
      updatedAt: number
    }
  | {
      type: 'workgroup.deleted'
      workgroupId: string
      clientMutationId: string
      deletedVersion: number
    }
  | { type: 'workgroup.acl.updated'; workgroupId: string }
```

registry 复用 workflows channel 的 ACL 语义：

- per-frame visibility gate + cache；
- ACL frame 先 bust 再 gate，使刚获授权的连接能收到；
- delete 在 transaction 内捕获 audience context，row 删除后仍只投递给原 owner/grantee/public
  audience；
- actor/credential revalidation 与 RFC-212 保持一致；
- 新 frame 类型默认 drop，不能默认放行。

前端 `useWorkgroupSync`：

- 自身 `clientMutationId` 回声不结算、不重复 invalidate detail；
- clean 收到更高版本：GET 后 adopt；
- dirty/saving/error 收到 foreign 更高版本：保留 local，进入 conflict；
- 每次物理 WS open、browser online、visibility→visible、window focus 都触发节流 GET；
- WS 是 wake hint，不是 authoritative snapshot。

## 6. 前端 autosave controller

### 6.1 状态

保留 config/members edit-scope 的成熟结算语义，在 route 上增加一个 document coordinator：

```ts
type WorkgroupDraftPhase =
  | 'clean'
  | 'dirty'
  | 'blocked'
  | 'saving'
  | 'reconciling'
  | 'error'
  | 'conflict'
  | 'inaccessible'
  | 'deleted'

type WorkgroupAutosaveState = {
  localRevision: number
  savedRevision: number
  serverRevision: WorkgroupRevision
  inFlight: WorkgroupSaveAttempt | null
  queuedRevision: number | null
  phase: WorkgroupDraftPhase
  transport: 'online' | 'degraded' | 'offline'
  blockReason: 'invalid' | 'transient-member' | null
}
```

config、metadata、members 任一 semantic edit 递增 document revision。attempt 必须捕获：

- exact config/members/metadata draft；
- 两个 edit-scope submitted revision；
- document revision；
- expected server revision；
- payload/hash/clientMutationId。

mutation function 禁止读取最新 render closure。

### 6.2 调度

- valid 连续编辑：清旧 timer，以最新 revision 重新计 1000ms；
- structural action：清 timer 并请求立即保存；
- in-flight 时只设置 `queuedRevision=latest`，不发第二个请求；
- committed receipt 只结算 captured revisions；若当前 revision 更高，保留 dirty 并立即 flush latest；
- definitive 4xx 保持 dirty/error；409 单独进入 conflict；
- timeout/status 0/5xx/receipt semantic mismatch 进入 reconciling，禁止盲发 queued revision；
- reconciling GET：
  - remote hash = submitted hash：合成成功；
  - remote version = attempt.expectedVersion 且 hash 不同：用同一 mutation id 重发原 attempt；
  - remote version 前进且 hash 不同：conflict；
  - 403/404：inaccessible；
- reconcile backoff 与工作流一致为 1s/2s/4s/8s/15s，online/WS/focus/visible 可立即唤醒。

### 6.3 validation 与 transient draft

`buildCompositeUpdatePayload` 仍是同步 schema net：

- invalid 或 transient dirty 时 phase=`blocked`、零 timer/零 request；
- status 区分“字段不合法”与“成员尚未添加完成”；
- transient “添加成员”确认后先 reset transient，再把完整 row commit 进 members draft，触发
  immediate save；
- 修复最后一个错误或清空 transient 时，如 composite dirty，则自动恢复 scheduling；
- blocked 也属于 unsafe-to-leave。

### 6.4 member id reconciliation

server receipt 必须先按 submitted snapshot 验证每个语义字段与顺序，再映射 member id。旧回执仅能：

- 推进对应 baseline；
- 在 scope revision 仍等于 submitted revision 时更新 draft；
- 对在途新 revision 保持 local key/field 不动。

纯 config save 后服务端不替换成员，现有 serverId 应原样保留。成员确实变化时沿用
`reconcileWorkgroupSaveResponse` 的 fail-closed 映射，不按 displayName 或旧 id 猜。

## 7. UX 接线

### 7.1 共享状态外壳

从 `WorkflowDraftStatus` 提取 presentation-only 的 `VersionedDraftStatus` 外壳（或等价的共享公共
组件），统一：

- phase/transport StatusChip；
- NoticeBanner 位置、动作布局、live region、compact/mobile 行为；
- retry/load/overwrite/save-copy action slots。

Workflow 保持现有文案和行为的 wrapper；新增 `WorkgroupDraftStatus` 提供 workgroup 文案与
blocked 分支。状态组件不发请求、不拥有 reducer。

### 7.2 页面

- workflow/workgroup 的 `PageHeader` 均挂 `editor-page-header`，共享 compact heading 与可横向到达的
  action rail 响应式规则；
- workgroup 页头标题使用 composite draft name，meta 固定为
  `<code>workgroup.id</code> · v<serverRevision.version>`，与 workflow 的
  `name / workflowId / version` 信息层级一致；
- workgroup 右侧保留一个 primary Launch 与一个 secondary More；Rename / ACL / Delete 复用
  workflow action-list 结构进入 dialog，避免多个同权按钮挤压编辑区；
- workgroup 不渲染 primary Save；
- 删除 `workgroup-save-button`、`workgroup-member-save` 与 `savedFlash`；
- 成员字段持续可编辑，saving 不 blanket-disable 输入；真正危险的 delete/owner transfer 仍按
  exact-state gate 禁用；
- status 放在 PageHeader 下、split 上方，390px 不挤进顶栏 action cluster；
- conflict/inaccessible/deleted 使用持久 Notice，不用 toast；
- invalid status action 聚焦 `firstInvalidTarget`；transient status action切到当前 add panel；
- 成功态不在 2 秒后消失。

### 7.3 exact actions

- `ensureSaved()`：取消普通 debounce，等待 300ms input idle，直到 latest
  `localRevision === savedRevision` 且无 in-flight；blocked/error/conflict/offline 返回结构化错误；
- Launch：调用 `ensureSaved` 后再导航任务向导，并携 exact workgroup id/version；向导重新读取时
  版本不符则要求刷新；
- RenameDialog：校验通过后 commit metadata 到同一 controller；RFC-223 id URL 完成前，clean
  receipt 后以 `replace` 跟随当前 name 路由，编辑器 identity、WS 与 CAS 始终使用 id；
- Delete：只在 clean exact revision 打开，body 带 expectedVersion + mutation id + typed confirm；
- Save copy：`QuickCreateDialog` 发送冲突时冻结的 local snapshot；创建成功导航新 id；
- ACL：仍是独立显式 scope；ACL frame 触发 access reconciliation。

## 8. 冲突动作

### 8.1 载入远端

确认后 fresh GET，替换 metadata/config/members baseline+draft，清 queued/inFlight 与 conflict；
member selection 若能按 response mapping 保持则保持，否则回 config panel 并把焦点送标题。

### 8.2 覆盖远端

确认时 fresh GET；用用户确认时冻结的 local snapshot + fresh version 发 CAS。期间本地继续编辑则
冻结版本只覆盖已确认 snapshot，新 revision 保持 queued/dirty；再次 409 仍留在 conflict。

### 8.3 另存副本

复制 snapshot 不携 workgroup/member id、owner/ACL/version/timestamps。新名称走正常 create
唯一性与 reference ACL；失败保持 dialog 和原冲突草稿。

## 9. 测试策略

### 9.1 shared/backend

- canonical serializer：键序/默认值稳定，成员顺序/leader/每个可编辑字段改变都会变 hash，DB id/
  ACL/time 不影响；
- migration：fresh、rolling upgrade、version=1、journal/when/SQL tag、foreign_key_check；
- 两 writer 同 v1 不同 payload：恰好一个 v2 committed，一个 409，回执不串；
- response lost exact replay：already-current，版本/timestamp/member id/frame 不变；
- current-version semantic no-op：零写；
- config-only：member id 全保留；member change：事务一致并可映射；
- owner transfer / name collision / invalid human / new agent ACL / CAS 交错均零半写；
- create/update/rename adapter/delete writer inventory 全 fenced；
- `/ws/workgroups` created/updated/deleted/acl，owner/grant/public/admin/manager、冷缓存 delete audience、
  credential/role revalidation。

### 9.2 pure frontend / hook

用 fake scheduler 与 deferred promises 覆盖：

- 1s debounce reset、structural immediate、single-flight、queued latest；
- request variables 冻结，old receipt 不清 newer edit；
- invalid/transient pause→修复后 resume；
- ambiguous committed/base-unchanged/foreign-advanced 三分支；
- offline edit→online GET→save；reconcile capped backoff + wake；
- own echo、clean foreign adopt、dirty foreign conflict、ACL loss、deleted；
- load/overwrite/save-copy/ensureSaved cancellation；
- member id remap保持 local key/selection/focus。

### 9.3 component / browser

- 页头和 member panel 零 Save 按钮，持续状态文案与 ARIA live；
- 字段错误聚焦、transient add 定位、Retry、三冲突动作；
- 输入期间可切 member/card，不被 saving 锁死；
- Launch 在慢 PUT 前不导航，失败/离线/冲突不导航；
- 两个 browser context 真实并发编辑；
- 模拟 PUT commit 后断响应、WS frame 先于 HTTP、WS reconnect 漏帧；
- 1536/1080/390、短视口、light/dark、axe、body 无横向 overflow；
- 已运行 task 的 frozen config 不随资源 autosave 改变。

## 10. 改动面

```text
packages/shared/src/schemas/workgroup.ts
packages/shared/src/schemas/ws.ts
packages/shared/src/workgroupRevision.ts                    (new)
packages/backend/src/db/schema.ts
packages/backend/drizzle/<next>_rfc225_workgroup_version.sql
packages/backend/src/services/workgroups.ts
packages/backend/src/routes/workgroups.ts
packages/backend/src/routes/resourceAcl.ts
packages/backend/src/ws/{broadcaster,registry}.ts
packages/frontend/src/lib/workgroup-form.ts
packages/frontend/src/lib/workgroup-autosave.ts              (new, pure)
packages/frontend/src/hooks/useWorkgroupAutosave.ts           (new)
packages/frontend/src/hooks/useWorkgroupSync.ts               (new)
packages/frontend/src/components/VersionedDraftStatus.tsx     (new/shared)
packages/frontend/src/components/workflow-editor/WorkflowDraftStatus.tsx
packages/frontend/src/components/workgroup/WorkgroupDraftStatus.tsx
packages/frontend/src/components/workgroup/WorkgroupContextPanel.tsx
packages/frontend/src/components/DetailHeaderActions.tsx
packages/frontend/src/routes/workgroups.detail.tsx
packages/frontend/src/i18n/{en-US,zh-CN}.ts
packages/frontend/src/styles.css
packages/{shared,backend,frontend}/tests/...rfc225...
e2e/workgroups.spec.ts
e2e/visual-regression.spec.ts
```

最终路径以 RFC-223 落地后的 live tree 为准；不得为了匹配本文文件名而绕开已形成的公共模块。

## 11. 实现门

- 用户已于 2026-07-23 以「开始」批准本 RFC；
- 开工时重新读取 RFC-223 最终 schema/route/migration，确认 id-canonical 接缝；
- 所有 production 改动随测试同批；
- 提交前跑仓库完整 `typecheck / lint / test / format:check / build:binary`，以及 workgroup
  Playwright/visual/axe；
- 实现评审重点：CAS 原子性、writer 穷尽、response-loss、member id churn、WS ACL/delete audience、
  queued revision、invalid/transient pause、exact action barrier 与 390px 状态可达性。
