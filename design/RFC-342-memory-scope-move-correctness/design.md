# RFC-342 技术设计 — Memory scope move 事务正确性

## 1. Wire contract

```ts
type MemoryPatchRequest = {
  title?: string
  bodyMd?: string
  tags?: string[]
}

type MemoryMoveRequest = {
  expectedVersion: number
  scopeType: 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global'
  scopeId: string | null
}
```

PATCH 对 `scopeType/scopeId` 采用显式 `never` 键，因此即使同时给合法内容也失败。Move schema 为 strict；global 必须
`scopeId=null`，其它 scope 必须有非空 id。

HTTP 接口：

```text
POST /api/memories/:id/move
permission: memory:update
token access: allow
response: { memory, moved }
```

现有 `MemoryEditDialog` 把一次 UI Save 拆成显式命令计划：无 scope 差异时只 PATCH；candidate 有 scope 差异时先用 seed
version 调 Move，再把 title/body/tags 差异作为 content-only PATCH。若第二步失败，所有 memory cache 立即失效重取，不能把已
committed 的 Move 隐藏在旧缓存下。approved/archived scope 控件禁用并显示 candidate-only 原因。

## 2. Trusted command context

`DirectOperationContextFactory` 增加 `resolveCommandContext`。factory 用 WeakMap 保存 authority claim 和 transport metadata；
Move 只接受 factory 铸造的 direct `CommandContext`。普通 JSON 无法携带 WeakMap claim，因此伪造对象报
`untrusted-operation-context`；delegated context 也不能冒充 direct request。

route 从已经认证的 Actor 只取 `user.id/source` 铸 context。role、permissions 与 resource grant 不进入 payload，也不从 route
snapshot 传给 service。

## 3. Transaction algorithm

```text
parse strict Move input
dbTxSync:
  resolve trusted RequestAuthority
  re-read active users row + current additional permission grants
  build current actor (PAT keeps token-safe memory:update and never regains account bypass)
  read memory
  compare expectedVersion
  require status=candidate
  load + authorize old scope
  load + authorize destination scope
  if identical scope: return no-op
  re-read memory, account permissions, old target and new target
  reject any drift
  UPDATE memories SET scope_type=?, scope_id=?, version=version+1
    WHERE id=? AND version=?
  require changes=1
  INSERT memory_scope_move_events
  return committed memory + receipt facts
after commit:
  publish memory.updated
  append structured log line
```

第二次读取不是为了绕开 SQLite 单 writer，而是使 transaction 内其它 participant/测试 mutation 也不能在首次授权后改变
目标或权限再继续写。

## 4. Authorization matrix

| scope      | existence         | view/write decision                           |
| ---------- | ----------------- | --------------------------------------------- |
| agent      | `agents.id`       | `canViewResourceInTx` + `canEditResourceInTx` |
| workflow   | `workflows.id`    | 同上                                          |
| repo       | `cached_repos.id` | `resource-acl:bypass`                         |
| repo_group | `repo_groups.id`  | `resource-acl:bypass`                         |
| global     | implicit          | `resource-acl:bypass`                         |

检查顺序对 old 和 destination 相同。没有 bypass 时，消失/不可见的 agent/workflow 统一为
`memory-scope-target-not-found`；看得见但不可写为 `memory-scope-forbidden`。bypass 可清理已经失去旧 target 的历史 memory，
但 destination 永远必须存在。

## 5. Durable event schema

`0221_rfc342_memory_scope_move_events.sql` 新增：

| column                               | meaning                                   |
| ------------------------------------ | ----------------------------------------- |
| `id`                                 | `CommandContext.operationId`，primary key |
| `memory_id`                          | 被移动 memory 的稳定 identity             |
| `actor_user_id/actor_source`         | transaction 内解析出的 authority          |
| `from_scope_type/from_scope_id`      | commit 前 scope                           |
| `to_scope_type/to_scope_id`          | commit 后 scope                           |
| `expected_version/resulting_version` | OCC step，DB CHECK 固定 +1                |
| `correlation_id/causation_id`        | request trace                             |
| `occurred_at`                        | context time                              |

约束关闭 scope enum/global-null invariant、no-op、actor source、正向时间和 version step；唯一索引
`(memory_id,resulting_version)`。表不挂 mutable aggregate FK。

## 6. Failure model

| fault                               | durable result                        | observer result            |
| ----------------------------------- | ------------------------------------- | -------------------------- |
| stale expectedVersion               | 无写                                  | 无 frame                   |
| target deleted before second read   | 整个 transaction rollback             | 无 frame                   |
| grant/account drift                 | 整个 transaction rollback             | 无 frame                   |
| memory drift                        | `resource-operation-stale` + rollback | 无 frame                   |
| receipt insert/constraint failure   | scope CAS rollback                    | 无 frame                   |
| injected fault after update+receipt | 两者 rollback                         | 无 frame                   |
| WS failure after commit             | memory+receipt 保持 committed         | durable query/refetch 恢复 |

## 7. Prompt audience proof

Move 只允许 candidate，因此 move 本身不改变任何 active prompt。测试随后走真实 promote，再分别按旧/新 scope 调
`loadInjectableMemories`：旧 audience 为零，新 audience 恰有该 id。历史 node-run snapshot 不重算。

## 8. File map

- shared contract：`packages/shared/src/schemas/memory.ts`
- identity authority：`packages/backend/src/modules/identity-access/{public,application}`
- command/transaction：`packages/backend/src/services/memory.ts`
- route/bootstrap：`packages/backend/src/routes/memories.ts`、`packages/backend/src/server.ts`
- frontend consumer：`MemoryEditDialog` command plan、`MemoryDialogShell` / `MemoryFormFields` scope freeze 与 i18n
- durable schema：migration `0221`、`packages/backend/src/db/schema.ts`
- proofs：shared schema、service/route、migration、RFC-342 mutation + injection tests
