# RFC-305 · 统一权限目录与用户级附加授权

> 产品视角。技术设计见 [design.md](./design.md)，实施计划见 [plan.md](./plan.md)。
> 状态：**In Progress（2026-08-15，已获用户批准）**。
> 目标架构：RFC-294 `identity-access` bounded context。

## 1. 摘要裁决

`admin`、`manager`、`user` 只是三套默认权限预设，不是第二条授权轴。

```text
effectiveAccountPermissions = ROLE_PERMISSIONS[role] ∪ additionalPermissions
```

业务代码只判断 `effectiveAccountPermissions`。HTTP、MCP、service、ACL、WebSocket、后台委派和前端功能开关都不得通过
`role === 'admin' | 'manager' | 'user'` 决定是否放行。`role` 只用于：

- 选择默认权限预设；
- 持久化、兼容 wire 字段与审计；
- 用户目录中的展示、统计和筛选；
- 管理员切换默认预设。

共享目录共有 72 个权限点。除内在的 `account:self` 外，任何不在当前预设中的权限都可以逐用户显式附加。因此：

| 预设      | 默认权限数 | 当前可附加数 |
| --------- | ---------: | -----------: |
| `user`    |         48 |           24 |
| `manager` |         60 |           12 |
| `admin`   |         72 |            0 |

普通 `user` 勾满 24 个附加点后，仍保存为 `role: 'user'`，但其 72 个有效权限与 `admin` 预设完全相同；授权行为也必须完全相同。

## 2. 背景

最初需求是在管理员用户管理弹窗中赋予用户脚本能力，随后扩展为完整权限清单，并要求以后新增权限自然出现。现有系统已经有
`PERMISSIONS` 和 `ROLE_PERMISSIONS`，但名称、说明、风险、PAT 规则、可授予性、前端展示与逐用户 grant 没有同一事实源；
历史上还有五项能力通过账户角色谓词隐式放行。

只在弹窗里手写 `scripts:author` 会形成第二份清单，新增权限仍可能漏 UI、漏双语、漏传播或漏消费方。本 RFC 把权限定义、
预设、附加授权和权限说明收成一个穷尽目录，并把历史身份谓词转换为显式权限点。

### 2.1 “使用脚本”的准确含义

沿用现有 `scripts:author`：允许查看、创建、导入、修改或删除脚本节点的敏感投影，包括正文、解释器、依赖、环境和输出契约。
它不是执行门；没有该点的用户仍可按既有 `tasks:execute` / `workflows:execute` 规则运行已保存的脚本工作流。

## 3. 目标

1. 以共享 `Permission` 闭集和穷尽元数据目录作为唯一事实源。
2. 新建、编辑用户弹窗复用同一清单组件，支持分组、搜索、来源、风险、PAT 与范围说明。
3. 允许持有 `users:write` 的活跃交互式账户按需授予任何非内在权限，而不要求其账户角色为 `admin`。
4. 让 session、PAT、WebSocket 和后台委派在下一次授权边界读取当前有效权限，无需重新登录或重启 daemon。
5. 删除生产授权中的角色判断和并行 identity gate；把历史例外全部纳入显式权限。
6. 按 RFC-294 建立 `modules/identity-access/`，集中访问写命令、authority 重建、OCC、审计和持久化端口。
7. 用架构测试保证以后新增权限自然进入目录和弹窗，也不能重新引入角色授权分支。

## 4. 非目标

- 不提供自定义角色编辑器、deny 权限、IdP group 映射或条件策略语言。
- 不从角色预设中单独减权；需要更窄组合时选择更小预设再逐点增加。
- 不把 owner、visibility、resource grant、task membership 等行级规则塞进账户权限集合。
- 不让 PAT 携带 system-domain 权限。
- 不回滚已经通过 admission 的不可撤回副作用，也不因撤销 `scripts:author` 取消正在运行的任务。
- 不在本 RFC 一次性完成 RFC-294 的全部 operation catalog 和全部旧模块迁移。

## 5. 产品决策

### D1. 一份封闭目录

每个 `Permission` 必须有且只有一条元数据：分组、双语名称/说明键、风险、delegation、token 模式和约束。目录使用
`satisfies Record<Permission, PermissionCatalogEntry>` 穷尽约束。

- 新增权限但未补目录：类型检查失败；
- 缺中英文案：前端结构测试失败；
- 补齐后：新建/编辑用户弹窗自动出现，无需修改 Dialog；
- system-domain 反向消费锁保证目录项不是无实现的“假权限”。

### D2. 只有两种 delegation

- `account-additive`：不在当前预设中时可逐用户勾选；
- `intrinsic`：由账户存在本身提供，不可存为 grant；当前仅 `account:self`。

没有 `admin-role-only`、`resource-admin` 或“仅角色授予”分类。system-domain 只限制 PAT，不限制账户附加授权。

### D3. 历史身份能力显式权限化

以下五项加入 `Permission` 闭集，并由原消费方直接检查：

| 权限点                            | 能力 |
| --------------------------------- | ---- |
| `resource-acl:bypass`             | 绕过资源 owner/visibility/grant 的行级 ACL |
| `memory-distill-jobs:manage`      | 查看与控制记忆蒸馏任务 |
| `intent:audit`                    | 跨 owner 只读审计 Intent session / provenance |
| `mcp-runtime-tests:audit`         | 通过精确 session id 跨 owner 只读 MCP runtime transcript |
| `webhook-triggers:override-owner` | 修改或删除其他 owner 的 Webhook trigger |

`manager` 和 `admin` 之所以默认拥有其中部分能力，只因为对应点在其预设中；普通 `user` 也可被显式授予。

### D4. 授权只看有效权限

粗粒度授权统一为：

```text
active account
AND required permissions ⊆ effectiveAccountPermissions
AND transport-specific constraints
AND resource/task row-level constraints
```

角色不参与这个公式。资源 ACL bypass、Intent/MCP 审计和跨 owner Webhook 写入都由 D3 的具体权限满足。

### D5. 附加权限是当前预设下的规范差集

```text
additionalPermissions ∩ ROLE_PERMISSIONS[role] = ∅
```

写入拒绝未知、重复、内在或与新预设重复的点。读取遭遇人工/旧版本写入的坏行时 fail closed：忽略坏行并记录诊断，不扩大权限。

切换角色代表替换预设：保留仍有效的显式附加点，移除被新预设覆盖的冗余点；以后再次降级不会自动复活已经被吸收的旧 grant，
管理员必须在新草稿中明确选择。

### D6. 谁可以管理访问

创建用户或替换角色/附加权限快照，需要：

- 本机 break-glass CLI；或
- `source=session`、`transport=http`、账户 active 且有效权限含 `users:write`。

不检查操作者角色。PAT 和 daemon HTTP 不能执行人类访问配置流程；daemon HTTP 仅保留旧 profile/status 管理兼容。操作者不得修改
自己的访问快照，`__system__` 不可修改。最后管理员保护改为：系统中必须至少保留一个 active 且有效权限含 `users:write` 的
非系统账户，而不是至少保留一个 `role=admin` 的账户。

### D7. 原子写、OCC 与审计

角色、附加权限、`accessRevision` 与 append-only audit 在同一 SQLite 事务提交。编辑提交完整访问快照并携带
`expectedRevision`；并发冲突返回 409，前端保留草稿并允许加载最新状态。仅有效访问变化推进 revision；profile/status-only
与 no-op 不虚增 revision 或 audit。

### D8. 当前权限即时生效

- REST/session/PAT：每次请求重新读取 active 状态、角色预设、grants 和 revision；
- WebSocket：DB revision 作为正确性围栏，post-commit 定向刷新只是加速；后续入帧和出帧不得继续使用旧 revision；
- scheduled/call/webhook：持久化 subject ref，在新委派与副作用 admission 前重新解析当前 authority；
- 前端收到 `authority.changed` 后失效 `/api/auth/me` 缓存。

### D9. PAT 仍受双重上限

```text
tokenPermissions =
  (READ_POINTS ∪ tokenMatrix)
  ∩ effectiveAccountPermissions
  \ SYSTEM_DOMAIN_POINTS
  \ (DELETE_POINTS \ tokenMatrix)
```

附加的 repo/Webhook 矩阵点可以进入 PAT；`tasks:read:all` 按既有 range 规则生效；五个 D3 权限、`scripts:author`、
`code-host-calls:author` 等 system-domain 点始终被剔除。撤销账户 grant 会立即收窄存量 PAT，重新授予不会创造 token 未保存的
写/删 scope。

### D10. 清单交互

两个用户弹窗复用 `UserPermissionCatalog`：

- 当前预设提供的点已选且锁定，标注“由预设提供”；
- 可附加点为可操作 Checkbox；`account:self` 只读；
- 支持名称、说明和稳定 id 搜索，搜索不改变选择；
- 展示风险、PAT 可用性和行级约束；
- 不提供“全选”捷径，避免误授 24 个高风险点；
- 角色切换、dirty/reset、409 草稿恢复、键盘/读屏、390px、明暗主题和中英文均需覆盖。

## 6. 用户故事

1. 访问管理员给普通用户勾选 `scripts:author`；该用户无需重新登录即可编辑自己可写工作流里的脚本，但仍受原资源 ACL。
2. 访问管理员再授予 `resource-acl:bypass`；同一用户立即可访问其他 owner 的 private 资源，撤销后恢复 404。
3. 普通 `user` 被授予 `users:read` + `users:write` 后，可创建用户并修改其他用户访问；其角色字段保持 `user`。
4. 普通 `user` 获得全部 24 个可选点后，授权面与 `admin` 完全一致；删除任何一点只收窄对应能力。
5. 两名访问管理员并发编辑同一用户，后提交者收到 409，已有草稿不丢失。
6. 开发者增加新 `Permission` 时，编译器要求补齐目录和文案；完成后两个弹窗自然出现该点。

## 7. 能力影响清单

### C1. 所有非内在权限均可逐账户授予

这是明确的能力扩张。过去只由 `admin`/`manager` 默认持有的用户管理、配置、备份、删除、端点管理与五项身份能力，现在都可
按点授予。所有存量用户的 grant 表初始为空，因此迁移本身不扩权。

### C2. 全 grant 等价于 admin 预设

普通 `user` 的 24 个差集全部授予后，其有效权限与 `admin` 的 72 点集合相同，包括资源 ACL bypass、蒸馏运维和用户访问管理。
系统不保留任何隐藏的 admin 身份能力。

### C3. PAT system-domain 边界不变

账户可获得 system-domain 点，但 PAT 永远不能携带这些点。`tasks:read:all` 仍会按 RFC-247 既有规则扩大 PAT 读取范围。

### C4. 角色切换会规范化冗余 grant

提升到更大预设时，重叠 grant 被移除；后来降级不会自动恢复。前端在角色切换时展示新基线与当前显式差集，保存前由管理员
确认。

### C5. 混合版本与回滚

迁移只新增 revision、grant 与 audit 表。旧 binary 忽略 grant，因此回滚期间会缺少新授能力但不会因 grant 扩权；重新升级后
有效 grant 恢复。部署窗口不得让旧、新 binary 同时写同一用户访问快照，因为旧 binary 不推进 revision。

## 8. 验收标准

- [x] **AC-1** 72 个权限均有穷尽目录和中英文案；新增点漏目录/文案时门禁失败，补齐后两个弹窗自动出现。
- [x] **AC-2** `admin/manager/user` 仅为预设；生产授权无账户角色比较、无 identity 元数据、无退役角色 helper。
- [x] **AC-3** 除 `account:self` 外，每个预设差集点均可逐账户授予；`user` 当前恰有 24 个可选点。
- [x] **AC-4** `user + 全部 24 grant` 与 `admin` 有效权限集合及真实授权行为完全相同，角色 wire 仍为 `user`。
- [x] **AC-5** 五个历史身份能力都有显式权限、正负行为与授予/撤销覆盖；PAT 对五点始终拒绝。
- [x] **AC-6** `scripts:author` 的读取、创建、修改、导入和撤销路径完整；既有脚本执行语义不变。
- [x] **AC-7** 持有 `users:write` 的 active session 可管理其他用户访问，无角色要求；self、system、last-active-users:write 保护成立。
- [x] **AC-8** create/patch、grant、revision 和 append-only audit 原子；未知/重复/内在/冗余输入稳定拒绝，坏存量行 fail closed。
- [x] **AC-9** session、PAT、WS、daemon/inherited authority 均按当前权限重建，撤权不留旧 revision 授权窗口。
- [x] **AC-10** PAT 公式使用有效账户上限且剔除 system-domain；range/resource 的撤销与恢复有真实 daemon 测试。
- [x] **AC-11** 两个弹窗共用目录组件，搜索/来源/风险/约束/OCC/dirty/a11y/390px/light/dark/i18n 完整。
- [x] **AC-12** `identity-access` 按 RFC-294 分层，跨模块仅经 exact public contracts，只有一个 grant/role/revision/audit writer。
- [ ] **AC-13** shared/backend/frontend/E2E、迁移、`bun run gate:local` 与固定提交实现审查全绿后提交上库。

## 9. RFC-294 对齐边界

本 RFC 完成 `identity-access` 的首个纵切：`domain / application / application/ports / infrastructure / public / composition`。
`routes/users.ts` 和旧 `services/users.ts` 只保留 adapter；当前 `Actor` 是向存量消费者投影有效权限的兼容面。

RFC-294 通用 operation catalog、outbox 和全部 legacy `Actor` 清仓仍属于后续波次。本 RFC 不复制第三套 registry；revision 是正确性
围栏，进程内事件仅做 post-commit 加速。RFC-294 的目标文档同步删除 `AdmissionPolicy.identity`，确保后续架构不会重新制造
角色身份轴。
