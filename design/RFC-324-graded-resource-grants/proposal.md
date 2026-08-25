# RFC-324 资源授权分档（只读 / 可编辑）—— proposal

- 状态：**Approved / Implementation Complete**
- 批准记录：2026-08-25，用户在三轮澄清（D1～D15）后回复「批准」，即批准 §2 目标、§3 非目标、
  §5 决策台账与 §6 能力影响清单 I1～I8；I9 是实现期按既有安全裁决（设计门 F-9）作出的**收敛**，
  比裁定更保守，随本 RFC 一并呈报
- 研究基线：`main@d50ac65f2`（2026-08-25）
- 澄清记录：2026-08-25，用户三轮裁定（见 §5 决策台账 D1～D13）
- 性质：授权模型扩展（新增档位）+ 任务成员制扩展 + 定时任务授权面新增 + 前端只读态补齐
- 目标架构落位：`resource-catalog` 的共享 ACL kernel（RFC-294 `proposal.md:160,175-178`）；
  任务成员判据落 `collaboration`（同文件 `:161`），定时任务授权落 `integration`（`:163`）

## 1. 背景与问题

用户诉求原文：

> 给所有资源，要增加只读授权能力，现在的授权都是可改授权，比如想把一个工作流授权给另一个使用
> 但是不想让他改，现在没有好的权限设置方式。

按源码对账，**后端的实际语义与"授权都是可改授权"相反**，但用户的痛点是真实的，只是根因在别处。
先把现状钉死（全部为 `main@d50ac65f2` 的实测锚点）：

1. **授权（grant）在后端本来就是只读的。** 13 类 ACL 资源共用
   `owner_user_id + visibility('private'|'public') + resource_grants(type,id,user)` 三元组，
   `resource_grants` 主键就是 `(resource_type, resource_id, user_id)`，
   **没有任何档位列**（`packages/backend/src/db/schema.ts:502-538`）。被授权人只拿到"可见 + 可用"；
   改 / 删 / 转移 / 管授权一律 `requireResourceOwner`
   （`packages/backend/src/services/resourceAcl.ts:481-499`），工作流写面同款
   （`packages/backend/src/services/workflow.ts:1008-1051`）。UI 文案也是这么写的：
   「私有资源仅所有者、授权用户或持有 resource-acl:bypass 的账户**可见可用**」
   （`packages/frontend/src/i18n/zh-CN.ts:14693`）。
2. **能绕过行级 ACL 的只有 `resource-acl:bypass`**，它不在普通 user preset 里，
   只在 manager/admin preset（`packages/shared/src/schemas/permission.ts:1064-1067`）。
3. **真正让用户"心里没底"的是前台。** 权限面板只有「所有者 / 可见性 / 授权用户」三项
   （`packages/frontend/src/components/AclPanel.tsx:317-420`），没有任何档位可选，也没有任何地方
   告诉授权者"他只能看不能改"；更糟的是详情页与编辑器**根本没有只读态**，两条都已登记在案：
   - `docs/audit-backlog.md:489-499`：非 owner 打开别人的工作流，「画布让他随便拖、随便改」，
     第一次自动保存才吃 403，且文案是「此工作流可能已删除或权限已变化」——两条都不成立。
   - `docs/audit-backlog.md:108`：agents / skills / mcps / plugins / workgroups 详情页
     「不按 owner 做写门 → 非 owner 可编辑、编辑器拖动即撞 403」。

   于是授权者看到的是"我把工作流授权给他，他打开就能改"，被授权者看到的是"我能改，保存却报错说
   工作流被删了"。**双方都没有得到关于档位的任何真话。**

4. **反过来，真正缺失的是"可编辑授权"。** 今天想让第二个人能改一份工作流，只有两条路：
   转移 owner（自己失去所有权），或者把他升成 manager（拿到全局 `resource-acl:bypass`，
   能改**全站每一份**资源）。两条都远超"让他一起维护这一个工作流"的意图。
5. **任务侧是另一个方向的同一问题。** 任务成员制只有一档：
   `taskCollab.ts:1-8` 明写「task users hold the same operational rights as the owner
   (cancel / retry / resume)」，成员身份同时是评审 / 反问的回答权边界
   （`requireTaskMember`，`packages/backend/src/services/taskCollab.ts:98-110`）。
   想让人"看得见任务进展但别动"，今天做不到——加进来就是同权。
6. **定时任务连授权面都没有**：读面 owner + `tasks:read:all`，写面 owner-only
   （`packages/backend/src/services/scheduledTasks.ts:207-215`），没有成员制也没有 grants。

结论：本 RFC 要做的不是"把可改授权改成只读授权"，而是**把授权从一档变成两档，并让档位在前台
成为可见、可选、可信的东西**。

## 2. 目标

- **G1**：每条授权带档位——**只读（read）** 与 **可编辑（write）**。只读＝今天的语义（可见 + 可用
  - 可引用 + 可启动任务 + 可复制），可编辑＝在只读之上**可以改内容**。
- **G2**：覆盖 13 类 ACL 资源（agent / skill / mcp / plugin / workflow / workgroup /
  capability_template / action_template / verification_profile / digital_employee /
  automation_policy / development_adapter / employee_definition）。
- **G3**：任务新增**只读观察者**档：能看任务详情 / 节点日志 / diff / 变更叙事，**不能**
  cancel / resume / diagnose，**不能**回答评审与反问。现有 collaborator 语义原样不变。
- **G4**：定时任务新增两档授权：只读＝看得见调度配置与执行历史；可编辑＝改 cron / 启停 / 立即运行。
- **G5**：前端全面对齐——权限面板逐人选档、详情页与工作流编辑器按档位进只读态、
  403 文案分流，一并清掉 `docs/audit-backlog.md:108` 与 `:489-499` 两条既有缺陷。
  （实现范围：8 个单资源详情页 + 工作流编辑器。`digital-employees.$typeRef` 是**类型**页、
  不对应单一 ACL 行，其逐卡只读态留给数字员工侧的下一个 RFC，见 design §14 X9。）
- **G6**：判据仍只有一个事实源。档位判定全部落在 ACL kernel 内，不允许任何路由自己拼
  `owner || grant` 的判断。

## 3. 非目标

- **不动 `resource-acl:bypass`**（D13）。manager / admin 仍能改任何资源；把资源只读授权给一个
  manager，他照样能改——只读档只对不带 bypass 的账户生效。
- **不给可编辑者**：改名、删除、转移 owner、改授权名单 / 档位、改 visibility（D3）。
- **不给 repos / repo_groups 补行级 ACL**。它们刻意不走 owner+visibility+grants
  （`packages/backend/src/db/schema.ts:871` 注释，RFC-248 D5），本次不动。
- **不引入"全员可编辑"的 public**。`public` 仍只表示"全员只读可用"（D12）。
- **不改既有 `scripts:author` 字段级门**。可编辑者若没有 `scripts:author`，照样写不了脚本 /
  hooks / adapter 可执行 / verification 程序（D15）。
- **不限制只读者的复制与导出**。今天只要看得见就能 copy / 导出 YAML / 配置包，保持不变（D14）。
- 不新增权限点。档位是行级 ACL 的一部分，方法粗门仍走既有 `{resource}:update` 等点。

## 4. 用户故事

- **US-1**：我把一份工作流只读授权给同事，他能在列表里看到、能拿它启动任务、能复制一份自己改；
  他打开编辑器时画布是只读的，右上角明确写着「只读授权」，拖不动也点不了保存。
- **US-2**：我把同一份工作流改成可编辑授权给搭档，他能改画布、改节点提示词并保存；
  但他改不了工作流名字、删不掉它、也看不到"转移所有者"和"改授权名单"的入口。
- **US-3**：我在权限面板里逐个成员选档位，默认新加的人是**只读**；把某人从可编辑降回只读后，
  他正开着的编辑器立刻变成只读态，而不是等到保存才报错。
- **US-4**：我把一个正在跑的任务只读授权给产品经理，他能看进度、看 diff、看变更叙事，
  但取消 / 重跑按钮对他不可用，评审和反问的回答框也不对他开放。
- **US-5**：我把一条每天跑的定时任务可编辑授权给同组同事，他能改 cron 和启停；
  只读授权给另一位，他只能看调度与历史。
- **US-6**：我是被可编辑授权的人，打开资源时能一眼看到自己的档位；试图改名或删除时，
  得到的是「改名 / 删除仅所有者可操作」这种说人话的拒绝，而不是「可能已删除」。
- **US-7**：我是管理员（带 bypass），行为与今天完全一致；权限面板会提示"该用户为管理员，
  只读档对其无效"，避免我误以为设了只读就锁住了他。

## 5. 决策台账（用户 2026-08-25 三轮裁定）

| 编号 | 决策         | 结论                                                                                                                                                   |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1   | 痛点性质     | 「没有档位可选、心里没底」——面板与前台从不表达授权到底给了多大权                                                                                       |
| D2   | 授权模型     | **两档：只读 + 可编辑**（不做三档"可管理"）                                                                                                            |
| D3   | 可编辑边界   | **只含"改内容"**；改名、删除、改授权名单 / 再授权**都不给**                                                                                            |
| D4   | 覆盖范围     | 13 类 ACL 资源全覆盖 + 任务 + 定时任务（repos / memory 不单独立面）                                                                                    |
| D5   | 任务只读含义 | **纯观察者**：能看，不能 cancel/resume/diagnose，不能回答评审与反问                                                                                    |
| D6   | 定时任务     | 引入两档授权（只读＝看调度与历史；可编辑＝改 cron / 启停 / 立即运行）                                                                                  |
| D7   | 执行面字段   | **能改，既有字段门原样保留**：MCP `config`（command/args/env）、技能文件等照改；脚本 / hooks / adapter 可执行 / verification 程序仍受 `scripts:author` |
| D8   | 发布类动作   | **算"改内容"**：可编辑者可发布数字员工工具 / job template / 员工定义 revision                                                                          |
| D9   | 记忆连带     | **可编辑视同写权**：`canManageMemory` 的"随 scope 资源写权"包含可编辑档                                                                                |
| D10  | 前端范围     | **全做**：面板档位 + 13 类详情页只读态 + 工作流编辑器只读态 + 403 文案分流                                                                             |
| D11  | 存量迁移     | `resource_grants` 全部迁为**只读**；`task_collaborators` 存量全部保持 **collaborator**（两者都是零行为变化）                                           |
| D12  | public       | 仍只表示"全员只读可用"，不设"全员可编辑"                                                                                                               |
| D13  | bypass       | 保持不动（manager/admin 仍可改任何资源）                                                                                                               |
| D14  | 复制 / 导出  | 只读者照常 copy / 导出 YAML / 配置包（现状保留）                                                                                                       |
| D15  | 字段级门     | `scripts:author` 等既有字段门原样保留，可编辑档不自动获得                                                                                              |

## 6. 能力影响清单

本 RFC 主体是**扩权**（新增可编辑档），不属于 CLAUDE.md §RFC workflow 第 7 条所指的能力收缩型
RFC。但下列行为会发生用户可感知的变化，逐条呈报确认：

| 编号 | 变化                                                                                                     | 性质                                                                                                                        | 处置                                                                                                                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1   | 非 owner 打开别人的资源详情页 / 工作流编辑器时，界面进入**只读态**：画布拖不动、表单禁用、保存按钮不可用 | **不是能力收缩**——后端从来就拒绝这些写入（`workflow.ts:1016-1022`），此前只是前台在骗人；但用户体感是"以前能点，现在不能点" | 明确列出；同时把 403 文案从「可能已删除」分流为「你对此资源只有只读授权」                                                                                                                                                                                         |
| I2   | `PUT /api/{res}/:id/acl` 的 `userIds` 字段**删除**，改为 `grants: [{userId, level}]`                     | wire 破坏性变更                                                                                                             | 该端点 `tokenAccess: 'never'`（`routes/resourceAcl.ts:159-166`），PAT 本就调不了；影响面只有本仓前端与直接用会话 Cookie 的脚本。按 CLAUDE.md「删除优于 deprecate」直接切换，不留兼容字段                                                                          |
| I3   | `PUT /api/tasks/:id/members` 的 `userIds` 同样改为带档位的 `members`                                     | wire 破坏性变更                                                                                                             | 同 I2（该端点亦为 `tokenAccess: 'never'`）                                                                                                                                                                                                                        |
| I4   | `GET /acl` 响应的 `users: UserPublic[]` 改为 `grants: [{user, level}]`，并新增 `canEdit`                 | wire 破坏性变更                                                                                                             | 同 I2；`canManage` 语义不变（能否改授权面）                                                                                                                                                                                                                       |
| I5   | 任务成员面板出现"观察者 / 协作者"两档，**新加成员默认协作者**                                            | 无行为变化                                                                                                                  | 存量成员与默认档都保持今天的同权语义（D11），只读观察者是显式选择的新档                                                                                                                                                                                           |
| I6   | 被可编辑授权的人可以改 MCP 的 `config`（command / args / env），等价于改变守护进程环境里跑什么命令       | **扩权**，由 D7 明确裁定                                                                                                    | 面板在选择"可编辑"时对 MCP / adapter 这类执行面资源给出显式风险提示；`scripts:author` 字段门不变                                                                                                                                                                  |
| I7   | 被可编辑授权的人可以管理该资源 scope 下的记忆（agent / workflow scope）                                  | **扩权**，由 D9 明确裁定                                                                                                    | `canManageMemory` 的 scope 写权判据改调可编辑判据（`memory.ts:800-817`）                                                                                                                                                                                          |
| I8   | 被可编辑授权的人可以发布数字员工工具 / job template / 员工定义 revision                                  | **扩权**，由 D8 明确裁定                                                                                                    | 发布仍受各自既有的 revision / digest 围栏与 `scripts:author` 字段门约束                                                                                                                                                                                           |
| I9   | 定时任务的可编辑授权**不含**改绑启动目标（`launchKind` / `launchPayload`）与改名                         | 实现期按既有安全裁决收敛，**比 D6 字面更保守**                                                                              | 定时任务到点以 owner 身份发起（`buildInheritedActor(..., 'schedule')`），改绑目标等于借 owner 身份跑任意东西——`db/schema.ts:1267-1269` 记的设计门 F-9 正是以此把定时任务与 ACL grants 划开。D6 裁定的三件事（cron / 启停 / 立即运行）全部落在可编辑档内，未被削减 |

## 7. 验收标准

**授权模型**

- AC-1：`resource_grants` 每行带档位，值域 `read | write`；迁移后存量行全部为 `read`，
  且迁移前后对同一账户的可见性 / 可写性判定逐条不变。
- AC-2：只读被授权人对 13 类资源的**任一写路由**都得到 403 `resource-read-only`，
  而不是 404、不是裸 `forbidden`；可见性不受影响（仍能 GET）。
- AC-3：可编辑被授权人能通过**内容写路由**（见 design §4 分类表），
  且对治理写路由（删除 / 改名 / rename / ACL PUT）得到 403 `resource-govern-owner-only`。
- AC-4：可编辑被授权人提交的 PUT 若改动了 `name`，得到 403 `resource-rename-owner-only`，
  资源内容不被写入（同一事务内拒绝，无部分落盘）。
- AC-5：owner 转移后，前任 owner 自动落为**只读**授权（与今天转移后只剩 grant 的效果一致）。
- AC-6：档位变更走既有 `aclRevision` CAS：并发 PUT 中落后的一方得到 409 `acl-revision-conflict`。

**任务 / 定时任务**

- AC-7：任务观察者能 GET 任务详情 / node-runs / diff / structural-diff / change-narrative；
  对 cancel / resume / diagnose / clear-recovery-suspension 得到 403，
  对评审决定 / 反问回答 / 澄清指令得到 403 `not-task-member`。
- AC-8：任务观察者不出现在评审与反问的可回答人集合里，
  也不会被记进 `TaskActorRole` 归属快照。
- AC-9：定时任务只读授权者能 GET 调度与执行历史；改 cron / 启停 / 立即运行得到 403。
  可编辑授权者三者都能做，删除仍 owner-only。
- AC-10：定时任务不引入 `public` 可见性——未被授权者一律 404（与不存在同形）。

**记忆连带**

- AC-11：agent / workflow scope 的记忆，可编辑授权者可管（创建 / 修改 / 删除 / 审）；
  只读授权者不可管；repo / repo_group / global scope 判定逐条不变。

**前端**

- AC-12：权限面板每个被授权人一行档位控件（复用 `<Segmented>`），新加默认只读；
  面板对 manager / admin 身份的被授权人显示"只读档对其无效"的提示。
- AC-13：13 类资源详情页与工作流编辑器在只读档下进入只读态：
  表单 `disabled`、画布 `nodesDraggable/nodesConnectable/elementsSelectable` 关闭、
  保存 / 删除 / 改名入口不渲染；**并且不发出任何自动保存请求**
  （锁死 `docs/audit-backlog.md:489-499` 的 `healLoadedDefinition` 首发写）。
- AC-14：403 `resource-read-only` 有独立中英文案（「你对此资源只有只读授权，可另存为副本」），
  不再复用「此工作流可能已删除或权限已变化」。
- AC-15：档位被降级（write→read）时，前端在下一次 `resource-acl-changed` 重校验后
  自动切入只读态，无需刷新页面。

**回归防护**

- AC-16：`resource-acl:bypass` 持有者的判定逐条不变（新增一组对照测试）。
- AC-17：既有 `rfc099-*` / `rfc170-*` / `rfc223-*` ACL 测试全部保持绿；
  新增两档矩阵测试覆盖 13 类 × {未授权 / 只读 / 可编辑 / owner / bypass} × {读 / 内容写 / 治理写}。
