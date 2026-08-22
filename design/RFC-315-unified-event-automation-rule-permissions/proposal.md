# RFC-315：统一事件自动化规则权限合同

- 状态：In Progress（产品方向与实施已获批准；代码已完成，等待全量门禁与远端精确 SHA 验证）
- 日期：2026-08-22
- 关联：RFC-247、RFC-260、RFC-283、RFC-294、RFC-305、RFC-310

## 1. 背景

事件中心里有两类“某个事件发生后，自动启动一项工作”的配置：

1. Webhook 触发规则，存于 `webhook_triggers`；
2. 来源无关的事件规则，存于 `event_response_rules`。

它们是同一种用户能力——配置事件自动化——但原授权合同不一致：

| 能力      | Webhook 规则（原）                          | 来源无关规则（原）                  | 结果                                  |
| --------- | ------------------------------------------- | ----------------------------------- | ------------------------------------- |
| 读取      | `webhook-triggers:read`                     | `event-sources:read`                | 普通用户均可读                        |
| 创建      | `webhook-triggers:create` + `tasks:execute` | `event-sources:update`              | 普通用户只能创建后一种                |
| 更新/删除 | 专用 CRUD 点 + owner 门                     | `event-sources:update`，无 owner 门 | 普通用户可改删任意 owner 的后一种规则 |

根因在授权模型，不是单纯的前端按钮：`event-sources:update` 位于普通用户 preset，来源无关规则的写路由复用了它，application 命令也没有接收可信 actor/owner authority。

## 2. 命名裁决

本 RFC 使用来源与动作都中性的权限族：

```text
event-automation-rules:read
event-automation-rules:create
event-automation-rules:update
event-automation-rules:delete
event-automation-rules:override-owner
```

“automation”回答的是“事件发生后自动做什么”，不把规则误说成对事件作出“response/回答”。用户界面同步采用“事件自动化规则 / Event automation rules”。

现有 `/api/event-center/response-rules`、`event_response_rules`、`EventResponseRule*` 是已发布的兼容标识，本 RFC 不做破坏性 API/表/内部类型改名；它们不再作为权限或产品术语的来源。后续若要改 wire/storage 名称，须另立兼容迁移。

## 3. 产品裁决

### 3.1 默认角色矩阵

| 角色    | 查看全部 | 新建 | 更新/删除自己的 | 跨 owner |
| ------- | -------: | ---: | --------------: | -------: |
| admin   |       是 |   是 |              是 |       是 |
| manager |       是 |   是 |              是 |       否 |
| user    |       是 |   否 |              否 |       否 |
| guest   |       否 |   否 |              否 |       否 |

角色只是 RFC-305 preset，不成为授权分支。管理员仍可逐用户追加 CRUD；没有 `override-owner` 时，显式获授者只能操作自己的规则。

### 3.2 owner 不变量

两类规则统一遵守：

```text
create.ownerUserId = currentActor.userId
writeAllowed = row.ownerUserId == currentActor.userId
            || currentActor has event-automation-rules:override-owner
```

非 owner 的 update/delete/启停/reset 与不存在同形，返回 family-specific 404，避免写入口成为存在性探针。请求 body 不能指定 owner。

### 3.3 配置权不等于执行权

创建自动化规则仍须叠加 `tasks:execute`。目标为数字员工时，创建和把既有规则更新为该目标还须 `development-missions:launch`。规则 CRUD 权不替代未来启动工作的授权。

## 4. 目标

1. 两条规则通道只使用 `event-automation-rules:*`，退役生产态 `webhook-triggers:*`。
2. 来源无关规则不再引用 `event-sources:*` 作为 CRUD 粗门。
3. 两条通道共享权限与 owner 行为合同，但不合并表、领域模型或 bounded context。
4. 迁移历史账户 grant 与 PAT scope，不把 `event-sources:update` 错误扩散为新授权。
5. 前端只消费 effective permissions × owner，不读取角色做授权判断；权限变化期间的 mutation fail closed。

## 5. 非目标

1. 不合并 `webhook_triggers` 与 `event_response_rules`。
2. 不把 Webhook 仓库、分支、评论命令 selector 塞进来源无关规则。
3. 不改变 endpoint secret、URL token、delivery replay 的 `webhook-endpoints:*` 合同。
4. 不改变规则命中、投递、重试、dead-letter 与实际 WorkStart 语义。
5. 不新增 owner 转移或 orphan-owner 修复。
6. 不顺带收紧订阅、observation ingestion、自定义 source、observer worker 等 `event-sources:*` 残余入口；它们保留清单，后续变更须另行批准。

## 6. 能力影响

| 编号 | 实施前                                                 | 实施后                                                 |
| ---- | ------------------------------------------------------ | ------------------------------------------------------ |
| C1   | 默认 user 可用 `event-sources:update` 创建来源无关规则 | 默认 user 只读，POST 403                               |
| C2   | 默认 user 可改删任意 owner 的来源无关规则              | 默认无写权；显式 CRUD grant 也仅 own-write             |
| C3   | manager 对来源无关规则可全局写                         | 两类规则均 only-own，cross-owner 404                   |
| C4   | admin 依赖两套粗门                                     | 使用统一权限族，仍可全局管理                           |
| C5   | `event-sources:update` 隐含规则写权                    | 该隐含能力删除                                         |
| C6   | 附加授权可存 `webhook-triggers:*`                      | 同 verb 迁移为 `event-automation-rules:*`              |
| C7   | PAT 可存旧 scope 并访问 Webhook 规则                   | scope 同义迁移，Webhook PAT 能力保持                   |
| C8   | 来源无关规则 GET 允许 PAT                              | 该规则族 GET/POST/PUT/DELETE 全部 `tokenAccess: never` |
| C9   | API 接受旧权限名                                       | 旧名退出 wire enum，调用方改用新名                     |
| C10  | access audit 记录可能含旧名                            | append-only 历史字节不改写                             |
| C11  | 现存规则 owner/enabled/selector/target                 | 数据不改，仅后续写入开始执行 owner 门                  |

明确不扩权：不映射任何 `event-sources:*`；CRUD 不隐含 override；manager 不因规则写权获得 endpoint 管理；来源无关规则不因统一 read 点向 PAT 开放。

## 7. 权限目录合同

| 权限                                    | group        | risk     | token                    | constraint        | 默认 preset        |
| --------------------------------------- | ------------ | -------- | ------------------------ | ----------------- | ------------------ |
| `event-automation-rules:read`           | event-center | standard | matrix/read              | 全量只读          | admin/manager/user |
| `event-automation-rules:create`         | event-center | elevated | matrix                   | owner-or-override | admin/manager      |
| `event-automation-rules:update`         | event-center | elevated | matrix                   | owner-or-override | admin/manager      |
| `event-automation-rules:delete`         | event-center | critical | matrix + explicit delete | owner-or-override | admin/manager      |
| `event-automation-rules:override-owner` | event-center | critical | never                    | 跨 owner 能力本身 | admin              |

## 8. 验收标准

- **AC-1** shared 权限闭集中只有新五点；生产代码零旧权限引用。
- **AC-2** Webhook 与来源无关规则的所有方法使用统一权限族；后一类不再使用 `event-sources:*`。
- **AC-3** 默认角色矩阵逐格成立，授权消费者无角色分支。
- **AC-4** create 强制当前用户 owner；body owner 伪造被 strict schema 拒绝。
- **AC-5** manager/显式 CRUD grant own-write 成功、other 404；admin 或显式 override 可跨 owner。
- **AC-6** create 叠加 `tasks:execute`；数字员工目标在 create/update 均叠加 `development-missions:launch`。
- **AC-7** grant 与所有结构有效的 PAT scope 同 verb 迁移、去重；角色冗余清理；audit 不变；迁移幂等。
- **AC-8** Webhook PAT 仍可达；来源无关规则所有路由对 PAT 返回 `token-forbidden-route`。
- **AC-9** 两前端面板共享 owner-aware helper；普通用户只读、manager own-write、owner 信息可见。
- **AC-10** actor 未稳定或权限被收回时，不发起/不应用陈旧 mutation。
- **AC-11** RFC-294 边界不因统一权限而新增 event-center ↔ integration 内部依赖。
- **AC-12** `event-sources:*` 残余入口形成可复跑 inventory，且响应规则不在其中。

## 9. 发布与回滚

权限 rename、数据迁移、后端粗门/owner 门和前端切换必须同一版本发布。迁移单向执行：发布前按现有流程备份数据库；若必须降级，恢复升级前备份并搭配旧二进制。不得长期双写旧/新权限名，也不得把未知权限 fail-open。
