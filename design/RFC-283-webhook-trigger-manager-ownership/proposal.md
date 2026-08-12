# RFC-283 · Webhook 触发规则下放 manager 与 owner 写权限

- 状态：Approved（2026-08-12；用户已批准实现；Codex 设计门第三轮 findings 已修订，待第四轮复审）
- 作者：Codex
- 关联：RFC-257（Webhook 触发器与 owner 字段）、RFC-260（全员只读、写面 admin-only）、RFC-222（manager 角色）、RFC-247（权限矩阵与 PAT）

## 1. 背景

当前 `/webhooks` 的读面已经全员开放，但触发规则的新增、编辑、启停、删除和熔断重置仍由
`admin` 独占：三个写权限点不在 `manager` 基线，前端 `TriggersPanel` 也用单一
`isAdmin` 开关包住全部写动作。

数据库其实已经为每条规则持久化 `owner_user_id`，创建路由也把调用者写成 owner；但现有
`requireWrite` 使用 `owner ∨ isResourceAdminRole`。由于 `manager` 本身就是
resource-admin，若只把三个粗粒度权限点加入 manager 基线，manager 会立即获得**操作所有人
规则**的能力，与本次要求相反。

此外，当前卡片没有显示规则归属。manager 即使能看到全部规则，也无法在操作前判断哪条属于
自己；前端授权与用户认知都缺一块可见依据。

用户于 2026-08-12 明确要求：

1. `manager` 获得新增、编辑、删除触发规则的能力；
2. 触发规则按 owner 隔离：manager 可以看见别人的规则，但不能操作别人的规则；
3. 卡片新增归属标签；
4. Webhook 接收端点权限不在本次下放范围内。

## 2. 目标

1. **manager 完整管理自己的规则**：新增、编辑、启停、删除、熔断重置均可用。
2. **全量可见、owner 写隔离**：manager 继续读取全部规则；对非本人规则没有任何写动作，
   后端也必须拒绝绕过 UI 的直接请求。
3. **admin 保留全局管理**：admin 可操作任意 owner 的规则。
4. **user 保持只读**：普通 user 继续读取全部规则，但不能新增或修改任何规则。
5. **归属可见**：每张规则卡显示 owner 标签；本人规则额外显示“我的规则”语义，其他规则显示
   owner 的公开显示名，解析失败时回退 owner id。
6. **权限面可解释**：角色权限、行级判据、前端按钮和 PAT 权限矩阵使用同一组既有
   `webhook-triggers:{create,update,delete}` 权限点，不引入平行布尔开关。

## 3. 非目标

- 不下放 Webhook 端点 CRUD、启停、Secret/URL token 轮换；这些仍由
  `webhook-endpoints:manage` 保护并保持 admin session 独占。
- MCP-only 令牌可以读取端点的既有脱敏元数据以选择 `endpointId`，但不能取得完整 URL、URL
  token、Secret，也没有任何端点写入口。
- 不给触发规则增加共享 grants、可见性或 owner 转移 UI；v1 是单 owner + admin 旁路。
- 不改变触发匹配、投递、熔断、任务启动、目标校验和 owner 身份执行语义。
- 不允许 manager 操作其他 manager 或 admin 创建的规则。
- 不改变 endpoint/provider、launch kind 等既有不可变字段。

## 4. 授权模型

| 动作              | admin            | manager          | user     |
| ----------------- | ---------------- | ---------------- | -------- |
| 列表、详情、fires | 全部可见         | 全部可见         | 全部可见 |
| 新增规则          | 可以；owner=自己 | 可以；owner=自己 | 不可以   |
| 编辑、启停        | 任意规则         | 仅自己的规则     | 不可以   |
| 删除              | 任意规则         | 仅自己的规则     | 不可以   |
| 重置熔断 stream   | 任意规则         | 仅自己的规则     | 不可以   |
| 编辑接收端点      | 可以             | 不可以           | 不可以   |

行级写判据固定为：

```text
row.ownerUserId === actor.user.id || actor.user.role === 'admin'
```

路由方法门仍先校验对应 permission。普通 user 因缺 permission 返回 403；manager 对他人规则
能通过方法门但必须在行级门被拒。为兼容现有错误契约，后者继续返回
`404 webhook-trigger-not-found`，不新增错误码。

## 5. 决策记录

| #   | 决策                                   | 内容与理由                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | manager 获得三个既有写点               | 将 `webhook-triggers:create/update/delete` 加入 `MANAGER_EXTRA`；`tasks:execute` 已在 user/manager 基线，创建的双权限门无需新点                                                                                                                                                                                                                              |
| D2  | trigger 不使用通用 resource-admin 旁路 | 本资源的用户决策是“manager 只写自己”，所以 `isResourceAdminRole` 不适用；admin 是唯一跨 owner 旁路                                                                                                                                                                                                                                                           |
| D3  | `update` 同时覆盖启停与 reset          | 两者当前都走 `webhook-triggers:update`，属于规则运行状态管理；manager 只能对自己的规则执行                                                                                                                                                                                                                                                                   |
| D4  | 前端按 permission × owner 渲染         | create 看 `create + tasks:execute`；完整编辑与 reset 看 `update + tasks:execute`，启用看 `update + tasks:execute`，禁用只需 update，delete 看 delete；行级动作再叠加 `admin ∨ owner`。不能只看 role，也不能只靠隐藏按钮                                                                                                                                      |
| D5  | owner 标签复用用户批量查询             | `useUserLookup` 一次解析当前列表 owner；标签显示公开 displayName，失败回退 owner id；本人规则增加“我的规则”标记，不新增逐卡请求                                                                                                                                                                                                                              |
| D6  | 认证变化 fail-closed                   | 每个写动作在调用 trigger API 前发起一次绕开 React Query 与 HTTP cache 的 `/api/auth/me` 请求，用新响应复核 permission、actor id/role 与 row owner；发布新响应前先取消同一 credential/server 的精确共享 query，再重验 request identity 后写回，避免旧 refetch 迟到覆写。刷新失败或已降权时不发 trigger 写请求，关闭无权 Dialog/确认态并失效旧 handler                                                                 |
| D7  | PAT 权限必须可见且重新显式授权         | trigger 写路由本就 `tokenAccess:'allow'` 且三个点属于 matrix 域。把 `webhook-triggers` 补入 `MATRIX_RESOURCES`，让 admin/manager 的 token 矩阵显式展示这行；Delete 仍需单独勾选。上线迁移先从所有未撤销旧 PAT 中剥离三个 trigger 写点，防止旧 Full preset 曾存下但 UI 不显示的 create/update 随 MCP kind 上线被静默激活；需要 trigger 自动化的调用方必须在可见矩阵中重新签发 PAT |
| D8  | MCP 触发规则与端点发现面               | `MATRIX_RESOURCES` 的漂移锁要求 trigger 具有通用 MCP resource surface，补 list/get/create/update/delete；另补只读 `webhook-endpoints` MCP kind 供 MCP-only 客户端选择 `endpointId`。端点读取仍 dispatch 正式 GET 路由并返回 PAT 脱敏形状，不增加端点 write op 或 permission                                                                                  |
| D9  | trigger 删除必须确认精确名称           | DELETE 路由统一要求 `{confirm: row.name}`，缺失/不匹配返回 422 且不删除；Web UI 在二次确认后传当前名称，generic `resource_write` 的 `confirm` 原样进入同一路由，避免“任意非空字符串即可删”                                                                                                                                                                   |
| D10 | MCP schema 按 launch kind 可发现       | 不把含 `z.unknown()` 的 REST schema直接当 MCP 文档；`describe_resource` 使用显式 kind-aware JSON Schema：create 的 workflow/agent/workgroup 三分支分别约束 `launchPayload`，update 修改 payload 时要求同时回显不可变 `launchKind` 以选择分支。schema 复用三份 shared payload Zod schema，并以测试锁住与正式路由的一致性                                      |
| D11 | owner 围栏先于角色授权                 | 实施顺序固定先把 `requireWrite` 收窄为 `owner ∨ admin` 并落回归测试，再把三个粗权限授给 manager；两步不得以相反顺序进入可运行的 main，避免短暂跨 owner 修改/重置/删除窗口                                                                                                                                                                                    |
| D12 | 重新武装必须有 `tasks:execute`         | create 继续静态双点；PUT 只有纯改名、禁用等不增加未来 fire 能力的变更可只凭 update，启用或修改匹配、目标、payload、熔断阈值等会重新武装的字段必须再有 `tasks:execute`；stream reset 恒视为重新武装并静态双点。最终判定必须在事务内基于 fresh trigger 行重算，manager PAT 不能只勾 update 就借 owner 身份启动任务                                             |
| D13 | 删除新契约与 Web caller 原子落地       | 正式 DELETE 开始强制 `{confirm}` 的同一批必须把现有 Web 调用改为 `deleteJson({confirm: row.name})` 并落集成回归；不能让 main 出现后端已拒绝 bodyless DELETE、前端仍发送 bodyless DELETE 的可运行中间态                                                                                                                                                       |
| D14 | token DELETE 保留审计快照              | owner 与精确名称确认通过后、实际删除前调用 `captureDeleteSnapshot`；REST PAT 与 MCP 两条通道均沿既有 token audit 管线持久化脱敏快照，session 删除不额外落快照                                                                                                                                                                                                |
| D15 | fresh auth 正向动作不自我失效          | preflight 捕获 token、base URL、auth revision 与 action generation，走 query 外的 no-store 请求；响应成功后取消精确 `/me` query，await 后再次核对 request identity/action，再发布新 actor。合法同 actor 刷新必须继续发业务请求；只有失败、换号或降权才推进 generation 并关闭无权 UI                                                                                                      |
| D16 | HTTP transport 绑定请求起始身份        | API client 在请求起点一次性捕获 token/base URL/auth revision，用捕获的 base URL 构造 URL并透传 `RequestOptions.cache`；401 只有在三者仍与 store 完全一致时才清 token。`setBaseUrl` 的有效变化也推进 auth revision，防住 A→B→A 与换 daemon 竞态；迟到的旧凭据 401 不能登出新账号                                                                                  |
| D17 | 历史 PAT 权限 cutover                  | 新增数据迁移，在任何新 trigger MCP/manager 能力可服务前，从 `revoked_at IS NULL` 的既有 PAT `scopes_json` 中按原顺序剥离 `webhook-triggers:create/update/delete`。不自动补回、不猜旧 UI 意图；迁移后新签发 token 才能通过显式可见矩阵取得这些点。畸形 scopes 继续按现有 fail-closed 解析为空，不因迁移获得能力                                                                                       |
| D18 | 保存门与写入使用精确配置代际           | PUT 的异步保存门只以既有 launch-config 四列（`launchRefId/launchPayload/eventTypes/autoRegisterRepos`）作逐字节 CAS，不使用会被 fire 更新的 `updatedAt`；事务内 fresh 行重跑 owner/arming/immutable 门并复用 scheduled target 的同步 identity/ACL/builtin fence。create 也在同一 INSERT 事务重验 endpoint 与 target，避免异步校验后的删除/收权竞态                                                                       |
| D19 | actor query key 只有一个构造入口       | 新增 `actorQueryKey(token, baseUrl)`（或等价共享 factory），`useActor`、request-boundary helper、repos 写门、密码换新 session、PAT inventory 及其测试全部通过它读写；禁止继续手拼 `[...ACTOR_QUERY_KEY, token]`。prefix invalidation 仍可用 `ACTOR_QUERY_KEY`，精确发布只写当前 token×daemon 的 key，避免迁移后消费者失联或跨 daemon 改写缓存 |
| D20 | webhook 动作数据绑定 transport identity | trigger、endpoint、workflow、agent、workgroup、fires 与 owner lookup 的 query key 全部纳入非敏感 transport cache key（base URL + auth revision）；打开的 draft/确认态记录其来源 key。daemon/token 变化立即切到新 key、推进 action generation 并关闭旧态；mutation 在 auth GET 前后都核对来源 key，因此不能把 daemon A 的 row/target id 提交到 B，即使两端恰好复用同一 id |

## 6. 能力影响清单

这是明确的权限扩张，影响如下：

1. manager 可在任意现有接收端点上新建规则，但仍看不到端点完整 URL、URL token 或 Secret，
   也不能修改端点。
2. manager 可让事件持续以自己的身份启动 workflow/agent/workgroup；这增加“事件驱动持久启动”
   能力，但不增加 manager 原本可见或可执行的目标范围，保存与 fire 仍重校验 owner 权限。
3. manager 可修改、启停、删除、重置自己名下的存量规则；不能操作其他 owner 的规则。
4. admin 现有能力不收缩；普通 user 现有能力不扩张。
5. 显式授权的 manager PAT 可获得 trigger CRUD permission；请求仍以 PAT owner 用户身份做行级
   判定。空 scopes/read-only PAT 不获得写能力，Delete 仍为显式勾选；只有 update、没有
   `tasks:execute` 的窄 PAT 只能做不重新武装未来 fire 的变更，不能启用、改匹配/目标/payload/阈值
   或重置熔断。
6. 角色从 manager 降为 user 后立即失去写方法门；既有规则仍按 fire-time owner 权限重新校验，
   不因历史 manager 身份保留额外权限。
7. 不迁移或改写任何现有 trigger owner；已有 admin-owned 规则对 manager 只读。
8. MCP-only manager 可从脱敏端点列表取得 `endpointId`；端点管理能力与敏感值可见性不扩张。
9. trigger DELETE 请求新增精确名称确认；这是删除保护收紧，不改变 owner/permission 判据。
10. 经 PAT/MCP 删除 trigger 会像其他 token DELETE 一样保留脱敏的删除前快照。
11. 所有未撤销旧 PAT 的 trigger 写点会在升级迁移中被移除；这是一次显式安全 cutover。管理员需要在
    新的可见权限矩阵中重新签发相应 PAT，系统不会把历史隐藏 scope 自动解释成对新 MCP surface 的授权。

## 7. 验收标准

- **AC-1 角色矩阵**：manager session 具有 trigger create/update/delete，仍不具有
  `webhook-endpoints:manage`；user 三个写点均无；admin 全有。
- **AC-2 创建归属**：manager POST 成功且响应/数据库 `ownerUserId` 等于 manager id；user POST
  403；创建仍要求 `tasks:execute` 与目标保存期校验。
- **AC-3 owner 写隔离**：manager 对自己的 PUT、启停、DELETE、streams/reset 成功；对 admin
  或另一 manager 的对应请求全部以 `webhook-trigger-not-found` 拒绝；admin 对任意 owner 成功；
  所有最终 owner/arming 判定均基于事务内 fresh 行；异步保存门使用精确 launch-config CAS，fire
  只更新运行状态/`updatedAt` 不制造伪冲突，目标删除或 ACL 收权不能穿过事务内 target fence。
- **AC-4 全量读不退化**：manager/user 仍能列表、查看详情与 fires，包含他人 owner 的规则。
- **AC-5 前端动作**：manager 看到“新建”；自己的卡片有 Switch、编辑、删除与可用 reset；他人
  卡片只有只读状态与 fires。user 对全部卡片只读，admin 对全部卡片可操作。
- **AC-6 归属标签**：每张卡都有 owner 标签；本人规则有“我的规则”标记；他人显示 displayName；
  lookup 失败回退 owner id；中英文与窄屏布局均不溢出。
- **AC-7 stale auth**：manager→user、manager A→manager B 或请求期间 `/me` 失效时，不发送旧
  owner 的 trigger 写请求；每次动作都能观察到一次新的 no-store `/api/auth/me` 网络响应，已打开
  的无权 Dialog/确认态随刷新关闭；同一 manager 的成功刷新不会因共享 query 短暂 fetching 而关闭
  Dialog 或吞掉后续业务请求。底层 `fetch` 必须收到 `cache:'no-store'`；已在途的旧 `/me` 结果不能
  覆写 fresh actor；credential/base URL 切换后的迟到 401 不能清除新 credential。actor key 的所有
  手工消费者使用同一 factory；daemon/token 切换后 trigger/endpoint/三类 target/fires/owner 数据切换
  到新 transport key，daemon A 打开的 draft 或确认不能向 daemon B 发业务请求。
- **AC-8 PAT/MCP**：token 矩阵显式显示 Webhook 触发规则行；Full preset 不再含不可见权限；
  manager PAT 只能操作自己，新显式签发的 admin PAT 可全局操作，未勾写点的 PAT 403；MCP-only 可列出
  脱敏端点；trigger create/update schema 能枚举三种 kind 的 payload；DELETE 缺失或错填规则名
  422 且数据不变；只有 `webhook-triggers:update` 而无 `tasks:execute` 的 PAT 对启用、匹配/目标/
  payload/阈值变更及 reset 均 403；成功的 PAT/MCP DELETE 有脱敏快照；升级前未撤销 PAT 的三个
  trigger 写 scope 被迁移剥离，升级后重新显式签发的 PAT 才能使用新 surface。
- **AC-9 回归**：端点写权限与 URL/Secret 脱敏、投递 replay、触发匹配和任务启动行为字节级不变。

## 8. Codex 设计门处置（2026-08-12）

| finding                                      | 处置                           |
| -------------------------------------------- | ------------------------------ |
| P1 授权先于 owner 围栏产生跨 owner 窗口      | D11；实施顺序改为 B → A        |
| P1 generic MCP 删除只检查非空 confirm        | D9；正式 DELETE 路由精确比名   |
| P2 MCP-only 无法发现 endpointId              | D8；新增端点只读 MCP kind      |
| P2 `launchPayload: unknown` 无法形成可用文档 | D10；显式 kind-aware schema    |
| P2 缓存 `/me` 无法阻止已降权用户发请求       | D6；每次写前强制网络刷新       |
| P1 窄 PAT 可借 update/reset 重新武装未来启动 | D12；fresh 事务行条件双点      |
| P1 共享 `/me` 刷新会让合法动作自我撤权       | D6/D15；query 外 no-store 刷新 |
| P1 后端 confirm 先落会暂时打断 Web 删除      | D13；后端与 Web caller 原子落  |
| P2 trigger token DELETE 缺审计快照           | D14；复用 token snapshot 管线  |
| P1 新 MCP kind 会激活旧 Full PAT 隐藏 scopes | D7/D17；升级迁移先剥离旧写点   |
| P2 no-store 没有进入底层 fetch               | D16；client 透传 cache 并测试   |
| P2 旧凭据迟到 401 会清除新凭据               | D16；请求起始身份条件清理       |
| P2 在途共享 `/me` 可覆写 fresh actor          | D6/D15；精确 cancel 后再发布    |
| P1 actor query 新 key 会断开既有手工消费者    | D19；共享 key factory 全量迁移  |
| P1 webhook 业务缓存可跨 daemon 驱动旧写入     | D20；数据 re-key + 来源代际门   |
