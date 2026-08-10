# RFC-274 · 技术设计

状态：Done（2026-08-10）。本文定义配置、迁移、模板 registry 与 viewer-localized projection。

## 1. 当前锚点

| 事实                   | 当前源码                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| resource config        | `packages/shared/src/schemas/workgroup.ts#workgroupConfigFields`                        |
| resource storage       | `packages/backend/src/db/schema.ts#workgroups`，当前无 output contract                  |
| task snapshot          | `packages/shared/src/schemas/workgroupRuntime.ts#WorkgroupRuntimeConfigSchema`          |
| launch projection      | `packages/backend/src/services/workgroup/launch.ts`                                     |
| zero-delta             | `services/workgroup/strategies/leaderWorker.ts#warnIfZeroDeltaDone`                     |
| message table          | `db/schema.ts#workgroupMessages`，只有 `bodyMd`                                         |
| row single constructor | `services/workgroup/messages.ts#buildRoomMessageRow`                                    |
| platform writers       | memberTurns/configActions/engine/lifecycle/freeCollab/leaderWorker/messages/taskActions |
| room DTO               | `services/workgroup/room.ts` 直投影 `bodyMd`                                            |
| frontend               | `components/workgroup/room/RoomTimeline.tsx` 直接渲染 `message.bodyMd`                  |

## 2. Output contract

### 2.1 Shared schemas

```ts
export const WORKGROUP_OUTPUT_CONTRACTS = ['files', 'discussion'] as const
export const WorkgroupOutputContractSchema = z.enum(WORKGROUP_OUTPUT_CONTRACTS)
```

`workgroupConfigFields.outputContract` 在 create parse 可 default files，但 update handler 必须和
clarifyBudget/fanOut 一样用 `patch ?? existing`；不能让 shared default 作用于 full-replace update。

`WorkgroupRuntimeConfigSchema` 用 `.optional()` 保持历史 JSON 可读；唯一 resolver：

```ts
resolveWorkgroupOutputContract(value): WorkgroupOutputContract
// value === 'discussion' ? 'discussion' : 'files'
```

所有运行读点必须用 resolver，不散落 `?? 'files'`。

### 2.2 DB / migration

下一可用 migration：

```sql
ALTER TABLE workgroups
ADD COLUMN output_contract TEXT NOT NULL DEFAULT 'files'
CHECK (output_contract IN ('files','discussion'));

ALTER TABLE workgroup_messages ADD COLUMN template_key TEXT;
ALTER TABLE workgroup_messages ADD COLUMN template_params_json TEXT;
```

SQLite 不能给既有表追加跨列 CHECK 而不 rebuild；组合不变量由唯一 row constructor + migration
回归 + 源码结构守卫承担。若设计门要求 DB hard check，则用 12-step rebuild，并逐条复核该表的
FK/index/历史 body 保留；不得临时 trigger 制造第二写入口。

Drizzle schema 增列，历史 workgroups 物理 default 回填 files；历史 messages 两列 null。

### 2.3 Round-trip consumers

outputContract 必须进入：row mapper、create/update/copy、resource bundle codec/export/import、launch
snapshot、task config dialog、read-only detail。RFC-271 payload schema 是正式序列化源，不能只改
HTTP DTO 后让 package 静默丢字段。

### 2.4 Runtime behavior

`warnIfZeroDeltaDone`：

```ts
if (resolveWorkgroupOutputContract(state.config.outputContract) !== 'files') return
```

放在读取 hook、done count、git 调用之前。prompt renderer 增一条 derived instruction；不写回
消息、不改 permission。

## 3. System message registry

### 3.1 Shared wire

```ts
const WorkgroupSystemTemplateKeySchema = z.enum([...closed keys...])

const WorkgroupSystemTemplateSchema = z.discriminatedUnion('key', [
  z.object({key:z.literal('zeroDeltaDone'), params:z.object({count:z.number().int().positive()}).strict()}),
  // ...
])
```

初始 key 清单按 callsite inventory 生成，命名表达语义而非当前英文，如：
`zeroDeltaDone`、`roundCapDispatchIgnored`、`completionAwaitingHuman`、
`assignmentFailed`、`messageTurnFailed`、`duplicateTasksDropped`、
`visibilityMessagesDropped`、`configUpdated`、`assignmentCanceledByMember`。

params 只含渲染需要的 string/number/boolean，逐字段长度/数量上限；不得塞整个 error/object。

`WorkgroupMessageSchema` 增：

```ts
templateKey: WorkgroupSystemTemplateKeySchema.nullable().default(null)
templateParams: z.record(z.string(), z.unknown()).nullable().default(null)
```

superRefine 要求二者同 null/非 null且只有 authorKind system 可非 null。`bodyMd` wire 名保持。

### 3.2 Backend constructor

新增唯一 helper：

```ts
buildSystemMessage(template: WorkgroupSystemTemplate): {
  authorKind: 'system'
  bodyMd: string
  templateKey: Key
  templateParamsJson: string
}
```

helper strict parse、canonical JSON params、调用 exhaustive English fallback renderer。普通
`postMessage` 接受可选已构造 template projection，但不接受裸 key/json。`buildRoomMessageRow`
是最终组合 gate：

- templated ⇒ system + key/params/fallback；
- non-templated ⇒ key/params null；
- dynamic system original 必须显式 `{localization:'original'}`，便于源码 guard 盘点。

### 3.3 Fallback renderer

fallback 不能从 frontend en-US 文件反向 import。backend 以 typed switch 生成稳定英语；前端 en-US
translation 有测试对同 params 的语义快照，而不要求标点逐字相同。错误/summary 参数先走现有
mask/clip，再入 registry。

## 4. Frontend projection

纯函数：

```ts
resolveWorkgroupMessageBody(message, t): string
```

1. key/params 都 null ⇒ bodyMd；
2. safeParse discriminated template；
3. `t(key, {...params, defaultValue: bodyMd})`；
4. 结果非字符串/等于 unresolved key ⇒ bodyMd；
5. catch ⇒ bodyMd。

RoomTimeline 在建立 message index 时预计算 viewer body map。主行、`MessageReference.body`、任何搜索
preview/copy action都读 map；agent-facing backend context 永远读 DB `bodyMd`。

locale 切换导致 map 重算，不请求/改写 DB。React 仍以 text child 渲染，params 中 Markdown/HTML
不执行。

## 5. Callsite migration

先用 `rg` 产出 reviewed inventory，逐条分类：

1. platform-enumerable ⇒ registry；
2. agent-generated summary/result ⇒ original；
3. human/member input ⇒ 非 system 或 original；
4. internal diagnostic with unbounded text ⇒ 固定 template + masked clipped detail param。

结构测试扫描 workgroup backend：新增 `authorKind:'system'` 且附近出现英文 template literal、却没有
`buildSystemMessage` 或 annotated original 时失败。allowlist 以 file#semantic-id，不用脆弱行号。

## 6. Failure modes

- unknown key（新 backend/旧 frontend）：DTO 若 enum strict 会整页失败，因此 wire key 必须是
  `string|null` + frontend registry safeParse，或 API 版本化。选择前者：shared DTO接受 bounded string，
  typed insert union仍 closed。这样 rolling deploy fallback 可用。
- malformed params：fallback，不 throw；backend 新写路径永不产生。
- missing translation：fallback；i18n coverage test fail build。
- migration rollback：旧 binary 忽略新 columns，继续 bodyMd；output_contract 新列不影响旧 SELECT
  明确列集合。回滚前创建的 discussion 组在旧 binary 会按旧无维度逻辑告警，这是明确降级。

## 7. 测试策略

- shared：output contract create/update polarity、runtime legacy resolver、message combination；
- migration：历史 workgroup/message、列 default/null、所有 index/FK/body bytes；
- service：discussion hook 调用数 0、files 全旧矩阵、prompt/tool 面；
- round-trip：CRUD/copy/resource package/task snapshot/mid-run edit；
- registry：每 key good/bad params、fallback、mask/clip、canonical JSON；
- callsite guard：全量分类与 mutation（裸英文 system literal 必红）；
- frontend：zh/en、locale switch、unknown/malformed/missing translation fallback、reference/search/copy；
- browser：390/1536、light/dark、长 assignment/error 参数、screen reader label。

## 8. 权限、隐私与审计

无新权限点。template params 与 bodyMd 权限完全一致，不额外外泄；authorUserId 仍不进入 agent
prompt。params 是 body 的结构化重复，仍须走相同 masking/clip。系统消息 raw row 在 API 中保留
fallback + template metadata，便于审计“平台当时表达了哪一语义”，但不持久化观看者 locale。
