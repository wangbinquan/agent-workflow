# RFC-315 技术设计：统一事件自动化规则权限合同

- 状态：In Progress
- 对应：[`proposal.md`](./proposal.md)

## 1. 落位摘要

shared 权限目录提供唯一的标识、catalog metadata、role preset 与 PAT 分类；RouteMeta 承担方法级 AND 门；event-center 与 integration/Webhook 各自在自己的 application/service 内执行相同 owner 不变量。统一权限不引入跨 bounded context 的共享业务 service。

## 2. shared 权限与 preset

删除五个 `webhook-triggers:*`，在相同语义位置加入：

```text
event-automation-rules:{read,create,update,delete,override-owner}
```

权限总数净不变，`PermissionSchema` 不保留 alias。`PermissionGroup` 新增 `event-center`；read/CRUD 为 matrix-domain，override 位于 `SYSTEM_DOMAIN_POINTS`、PAT 永不持有。user baseline 仅 read；manager extra 为 create/update/delete；admin 动态拥有完整集合；guest 无默认点。

## 3. 路由合同

| 路由                                      | 方法   | permissions（AND）       | tokenAccess |
| ----------------------------------------- | ------ | ------------------------ | ----------- |
| `/api/webhook-triggers`                   | GET    | read                     | allow       |
| `/api/webhook-triggers`                   | POST   | create + `tasks:execute` | allow       |
| `/api/webhook-triggers/:id`、fires        | GET    | read                     | allow       |
| `/api/webhook-triggers/:id`               | PUT    | update                   | allow       |
| `/api/webhook-triggers/:id`               | DELETE | delete                   | allow       |
| `/api/webhook-triggers/:id/streams/reset` | POST   | update                   | allow       |
| `/api/event-center/response-rules`        | GET    | read                     | never       |
| `/api/event-center/response-rules`        | POST   | create + `tasks:execute` | never       |
| `/api/event-center/response-rules/:id`    | PUT    | update                   | never       |
| `/api/event-center/response-rules/:id`    | DELETE | delete                   | never       |

表中 read/create/update/delete 均指 `event-automation-rules:<verb>`。GET 收紧为 `never` 是有意的 channel fence：否则 READ_POINTS 会让所有 Webhook PAT 新获得来源无关规则读面。

## 4. Event Center write principal

来源无关规则命令接收 inbound adapter 从 effective actor 投影出的最小可信对象：

```ts
interface ResponseRuleWritePrincipal {
  readonly userId: string
  readonly canOverrideOwner: boolean
  readonly canLaunchDigitalEmployee: boolean
}
```

create 永远写 `principal.userId`。update/remove 在解析可变 body 和写副作用前读取行：不存在或非 owner 且无 override 时均抛 `event-response-rule-not-found`。create/update 的目标若为 `digital-employee` 且 principal 无 launch 能力，写库前 403。

请求 schema 为 strict；`ownerUserId` 等伪造字段返回 `event-response-rule-invalid` 422，而不是漏成 500。

Webhook service 继续接收既有 `Actor`，只把权限名替换为新族；原 owner 404、kind immutable、保存期 target 校验和 dispatch 语义不变。

## 5. 迁移 `0202`

`0201` 已为并发 RFC-310 migration 预留，本 RFC 使用 `0202_rfc315_event_automation_permissions.sql`。

### 5.1 账户 grant

同 verb 映射五个旧值，`INSERT OR IGNORE` 保留 `granted_by_user_id/granted_at`；若目标已存在，保留目标 provenance；随后删除旧值。再清理 role preset 已自带的冗余新 grant：admin 全部、manager CRUD/read、user read。`event-sources:*` 完全不参与映射。

### 5.2 PAT scope

只处理 `json_valid`、顶层 array、且每个元素均为 string 的 `scopes_json`。active/revoked/expired 全部 rename，按首次出现顺序去重；token hash、purpose、expiry、revocation 不变。非法 JSON 或混合类型数组保持原字节，由现有读取路径继续 fail closed。

### 5.3 审计与规则行

`user_access_audit` 是 append-only 历史，迁移不触碰其权限 JSON。两张规则表不 backfill、不改 owner/enabled/target/timestamp。迁移可重跑且第二次零语义变化。

## 6. 前端

共享 helper `eventAutomationRulePermissions.ts` 提供：

```text
canCreate = has create
canUpdate(row) = has update && (me == owner || has override-owner)
canDelete(row) = has delete && (me == owner || has override-owner)
```

`TriggersPanel` 与 `EventResponseRulesPanel` 都只调用该 helper。来源无关面板新增 owner identity / id fallback、“我的规则”、own-row switch/edit/delete；无权行只显示状态。用户可见文案统一为“事件自动化规则”，内部兼容 API 名不外溢为权限名。

写操作绑定 actor authority signature 与 write-session generation。发请求前和应用 success/error 前，都从当前 token 对应的 settled `/api/auth/me` cache 重验权限与 owner；切账号、后台 refetch、撤权或 pending actor 都 fail closed，并关闭已失效编辑态。

## 7. RFC-294 边界

| owner/layer                          | 责任                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| shared / identity authority contract | enum、catalog、preset、grant/PAT 迁移                |
| event-center application             | 来源无关规则 owner 与数字员工 launch policy          |
| integration/Webhook service          | 保留既有 Webhook owner/target policy，消费新权限名   |
| inbound routes                       | RouteMeta、token channel、可信 principal 投影        |
| frontend                             | effective permission × owner 展示与 mutation fencing |

禁止 event-center 引 integration internal、integration 引 event-center internal、任一 context 直接读另一方表、shared 引 backend Actor/Hono/Drizzle。本 RFC 的共享只有 permission contract 与前端纯投影 helper。

## 8. `event-sources:*` 残余 inventory（行为不改）

| route family                                          | operation / side effect             | tokenAccess | row constraint                             |
| ----------------------------------------------------- | ----------------------------------- | ----------- | ------------------------------------------ |
| catalog/deliveries/events/subscriptions/observers GET | 全局目录与运行态读取                | allow       | 全局只读                                   |
| subscriptions POST/DELETE                             | 建立/取消 durable subscription      | allow       | 无 owner ACL                               |
| observations POST                                     | 写 immutable observation 并 fan-out | allow       | source/event exact-ref 校验，无 owner ACL  |
| observers/run-due POST                                | 主动运行一个 observer cycle         | never       | 全局操作                                   |
| sources GET list                                      | 自定义 source 全局列表              | allow       | 全局只读                                   |
| sources POST                                          | 建 draft + observer program         | never       | 当前 actor 成 owner；另需 `scripts:author` |
| sources/:id GET/PUT/validate/publish                  | 读写/执行/发布 observer program     | never       | 另需 `scripts:author`；当前无 owner ACL    |
| sources/:id/retire POST                               | 退役 source                         | never       | 全局 archive，无 owner ACL                 |

来源无关自动化规则已从此 inventory 移除。表中残余全局写面需独立 capability-impact RFC，不能在本次授权修复中静默收紧。

## 9. 测试与棘轮

1. shared：五新五旧、metadata、role preset、token/system/delete 派生。
2. migration：grant provenance/conflict/redundancy、PAT 全状态/合法性/去重、audit 字节、幂等、event-sources 不映射。
3. HTTP：默认四角色、显式 CRUD、显式 override、own/other 404、owner 伪造、owner-before-body、session/PAT、数字员工 create/update launch 门。
4. frontend：manager own/other 控件、user 全量只读、owner label、两面板共享 helper。
5. regression：RFC-257/260/283/305/310 定向套件、typecheck、全量 `bun run gate:local`、hosted exact-SHA CI/visual attribution。

## 10. 回滚

新二进制与 migration 原子发布。降级必须恢复升级前数据库备份；不手工反向批量改权限字符串，不维持旧新双写。恢复后用 manager session 与存量 Webhook PAT 各做一次真实读写验证。
