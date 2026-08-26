# RFC-330 数字员工域授权面补齐：工具 / 岗位模版行级 ACL、员工定义前端授权面、案例归属与成员制 —— proposal

- 状态：**Done**（v7 功能核心版 2026-08-26 批准并单批落地；CI 于 `5c762c197` 全绿，2026-08-27）
- 研究基线：`main@da777913a`（2026-08-26）。**全部 `file:line` 锚点按已提交 blob 生成**（`git show <sha>:<path>`），不取共享工作树行号。
- 起因：用户 2026-08-26 问「现在数字员工的权限控制点是什么，工具、模版、数字员工有权限归属吗，有 edit 权限控制吗」。源码对账的答案：**员工定义有完整归属 +
  只读 / 可编辑分档（RFC-324）；工具与岗位模版只有一列 `owner_user_id` 做记录，不参与任何判定；员工定义的授权面板与只读态前端没跟上（RFC-324 design §14 X9）；
  案例侧全部是权限点级、无任何行级判据**。用户回复「好」并多轮拍板（§5）。
- 澄清记录：2026-08-26 六轮（§5 D1～D4、D16～D22、D17′）；D5～D9、D11～D14 是按仓内先例作出的默认裁定，**随本 RFC 一并呈批**。
- 设计门：v1～v6 五轮（§8）。**v7 起按用户 2026-08-26 明令「安全类一律不做，核心是功能；双门不审安全」（`CLAUDE.md` §工作准则）重切**：v2～v6 折入的安全 /
  守卫 / 记账层全部退出（§3 非目标列表），设计门不再跑，直接呈批；实现门只审功能自洽。
- 性质：**能力收缩型 RFC**（CLAUDE.md §RFC workflow 第 7 条适用）——把「全员可改工具 / 模版」「全员可读可操作任何案例」两处既有能力收成 owner / 授权 / 成员边界，
  理由是**归属与协作功能**而非安全；§6 能力影响清单逐项呈用户确认。
- 目标架构落位：`digital-employee` bounded context（工具 / 模版 / 员工定义 / 案例 / 案例成员五张表，RFC-294 `proposal.md:163`）；判据内核复用 `resource-catalog` 的
  共享 ACL kernel（`:167`、`:192-196`）；**判据只在路由层做一次**（与今天 DE 域其它写路由、RFC-324 之前的 13 类同形），模块层不引入 admission 端口。详见 design §1.2。

## 1. 背景与现状（全部为已提交 blob 上的锚点）

数字员工域的权限控制点今天分两层：

**第 1 层：方法粗门（permission point，`packages/shared/src/schemas/permission.ts`）**

| 点                                                   | 预设归属                                     | 管什么                                                                                    |
| ---------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `digital-employees:read / create / update / archive` | **普通 user 基线全有**（`:939`, `:987-989`） | 类型包 / 工具 / 岗位模版 / 员工定义的全部路由；案例读（`routes/digitalEmployees.ts:216`） |
| `development-missions:interact`                      | user 基线（`:1024-1026`）                    | 案例启动 / 恢复 / 终止 / 策略升级（`:227-322`）                                           |
| `scripts:author`                                     | admin 系（`:1072`）                          | 工具的 `implementationRef` 字段门（`:51-63`）                                             |
| `resource-acl:bypass`                                | admin（`:1067`）                             | 越过一切行级 ACL                                                                          |
| `tasks:read:all`                                     | admin（`:1089`）                             | 任务侧全读；案例侧今天不参与                                                              |

**第 2 层：行级判据（`services/resourceAcl.ts` kernel + `services/resourceAccessPolicy.ts`）**

| 资源                               | 归属列                                                                   | 行级判据                                                                                                               | 前端                                                           |
| ---------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 员工定义 `employee_definitions`    | `owner_user_id` + `visibility` + `acl_revision`（`schema.ts:5442-5470`） | **完整**：第 13 类 ACL 资源，read / write 分档（RFC-324），`GET/PUT /api/digital-employees/:id/acl`（`:702`）          | **没跟上**：卡片无权限入口、无只读态（RFC-324 design §14 X9）  |
| 工具 `employee_tool_registrations` | 仅 `owner_user_id`（`:5342-5364`）——**只做记录**                         | **无**：`digital-employees:update` 持有者可改 / 校验 / 发布任何人的工具，`:archive` 可退休任何人的工具；不存在私有工具 | 无                                                             |
| 岗位模版 `employee_job_templates`  | 仅 `owner_user_id`（`:5388-5409`）——**只做记录**                         | **无**：同上；名字唯一域是「类型版本内全局」（`employee_job_templates_type_name_unique`）                              | 无                                                             |
| 案例 `employee_cases`              | `owner_user_id`（`:5876-5923`）                                          | **无**：读 / 恢复 / 终止 / 策略升级 / outcome-summaries 全是权限点级；无成员制                                         | 案例页只有「恢复」按钮（`employee-cases.$caseId.tsx:574-636`） |
| 类型包 / 平台内置工具              | 无                                                                       | 恒 public 只读（`composition.ts:401` `editable: false`）                                                               | 无编辑入口                                                     |

工具 / 模版逃过 RFC-317 的 schema 守卫（`tests/architecture/rfc317-acl-column-enrolment-guard.test.ts:27,57`）是因为守卫只对「`owner_user_id` + `visibility` 双列」发作。
审计 backlog 里对应 B91-2（`docs/audit-backlog.md:2852-2858`）。

## 2. 目标

- **G1**：工具与岗位模版成为第 14 / 15 类 ACL 资源：owner + `visibility` + read / write 分档，`GET/PUT …/acl` 与其余 13 类同 wire；新建 private、存量 public。
- **G2**：三类列表（工具箱 / 模版 / 员工定义）按可见性过滤并带 `access` / `visibility` / `ownerUserId`；三类卡片按档位收敛控件并提供权限入口；员工定义补上 RFC-324 X9 欠的前端授权面。
- **G3**：案例与编排任务**完整同形**的归属模型：成员制（observer / collaborator）+ owner 转移；可见 = 发起人 ∪ 成员 ∪ `tasks:read:all` ∪ bypass；操作 = 发起人 ∪ collaborator ∪ bypass。
- **G4**：岗位模版名字唯一域从「类型版本内全局」放宽为「类型版本内 × owner」，使私有 / 异 owner 同名模版可共存；kernel 的 owner-name 唯一表长出分区列声明。
- **G5**：类型包自动升级产生的 successor 继承 source 的 owner + visibility。
- **G6**：两处顺手修：`employee_definition` 转移撞名 500 → 409；旧 playbook 保存路径对 `write` 授权者放行。

## 3. 非目标（含 v7 按「安全类一律不做」退出的项）

- **不动 `resource-acl:bypass`**、不新开权限点族（D5）。
- **不给类型包与平台内置工具加 ACL**：平台内置恒 public 只读、无 `/acl` 行（D9）。
- **不做「全员可编辑」的 public**（RFC-324 D12 原样）；不给可编辑者改名 / 删除 / 转移 / 改授权（RFC-324 D3 原样）。
- **不改 `scripts:author` 字段门**（`routes/digitalEmployees.ts:51-63`）。
- **不做 B99-1**（仓库组作用域服务端校验，`docs/audit-backlog.md:3129-3145`）：工作范围语义，另立。
- **不给案例页新增「终止」按钮**：今天案例页只有「恢复」，terminate 只有 API；本 RFC 只给既有控件加门。
- 不给案例补 `public` 可见性；不改 MCP 工具面（本域路由在 RFC-329 账本里属 `not-in-scope` 组，本 RFC 只按同一分类登记新增路由）。
- 不把派生内部任务暴露为可见任务、不给内部任务写 collaborator（成员制直接建在案例上）。
- **v7 退出项（用户 2026-08-26 D21 / D22 裁定；design §12 债务表逐条登记，不再折回）**：
  - 事务内 admission 端口 / 同步哨兵 / 写点注册表守卫（原 D16）——判据只在路由层做一次；
  - 新增引用可见性校验（原 D10）——模版 / 员工绑定工具只沿用今天的存在 / 状态校验（`authoringService.ts:1842`）；
  - 案例启动过员工可见性（原范围 C）——启动只看权限点，与今天相同；
  - 案例 `mine` / `shared` scope 与 `outcome-summaries` 按可见聚合（原 D13）——成员案例不进统一列表，只能从案例页直达；任务侧 `shared` null-safe 顺手修一并退出；
  - successor 继承 grants（原 D18 的 grants 部分）——只继承 owner + visibility；
  - `rfc317-acl-column-enrolment-guard` 第二不变量（原 D15）、前端 zod 边界校验、integration port `actorUserId → subject`、存在性 oracle 顺序、竞态终检、successor marker 列 /
    partial unique / adopt 协议、§12「唯一变异」证明体系。

## 4. 用户故事

- **US-1**：我为「实现变更」工作项注册了一个 Agent 工具，默认只有我看得见；设为 public 后同类型的所有人能在工具箱里选到它，但只有我能改它、发布新版本或退休它。
- **US-2**：我把一个工具**可编辑**授权给搭档，他能改描述 / 实现引用并发布新 revision；他改不了工具的显示名，也看不到退休按钮；他打开权限入口看到的是只读的授权清单。
- **US-3**：我建了一份岗位模版并只读授权给同事，他能基于它创建自己的数字员工，但模版卡片上没有编辑 / 发布按钮。
- **US-4**：我在员工定义卡片的「权限」入口逐人选只读 / 可编辑；被降回只读的人**不刷新页面**就看到编辑按钮消失。
- **US-5**：我启动的案例只有我（和 `tasks:read:all` / 管理员）能看进度；我在案例页把产品经理加为**观察者**，她能看进度、看不到恢复按钮；把搭档加为**协作者**，他能恢复。
  我离职前把案例**转移**给搭档：他成为 owner，我降为协作者，之后这个案例的提交 / 推送 / MR 以他的身份发出。
- **US-6**：管理员（bypass）行为与今天一致；权限面板提示「只读档对其无效」（RFC-324 AC-12 原样）。
- **US-7**：平台升级了研发类型包，我的岗位模版被自动升级到新版本——名字不变（除非我自己已在新版本下用了同一个名字且内容不同，这时沿用今天的 `· migrated …` 后缀）、
  归属与可见性不变；被授权的同事需要我在新版本上重新授权（D18′）。

## 5. 决策台账

**用户裁定（2026-08-26 第一轮四问）**

| 编号 | 决策            | 结论                                                                                                                                                          |
| ---- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | 范围            | 第一轮「A + B + C + D 全收」→ 第六轮 D22 砍去 C（案例启动过员工可见性）；A 工具 + 岗位模版立为 ACL 资源、B X9 前端授权面板 + 三类卡片只读态、D 两处顺手修保留 |
| D2   | 工具 / 模版模型 | **与 13 类同形**：owner + visibility + read / write 分档；引用闭包隐式授权（启动 / 编译不校验可见性）                                                         |
| D3   | 新建默认可见性  | **private**（与 RFC-231 全站默认一致）；想共享的人在权限面板切 public 或逐人授权                                                                              |
| D4   | 案例侧          | 第一轮「按发起人归属，对齐任务成员制」→ 第二轮改判为 D19                                                                                                      |

**用户裁定（第二轮，设计门 r1 后）**

| 编号 | 决策                | 结论                                                                                                                                                           |
| ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D16  | 写入点栅栏          | 第二轮裁「事务内 admission 端口」→ **第六轮 D21 撤销**：安全加固类，判据只在路由层做一次                                                                       |
| D17  | 岗位模版名字唯一域  | 第二轮裁「`(owner, name)`」→ 第三轮改判为 D17′                                                                                                                 |
| D18  | 类型包自动升级      | 第二轮裁「继承 owner + visibility + grants」→ **第六轮 D22 改为 D18′：只继承 owner + visibility**，grants 由 owner 在新版本上重新授权                          |
| D19  | 案例归属（改判 D4） | **与编排任务完整同形**：新增案例成员制（observer / collaborator）；可见 = 发起人 ∪ 案例成员 ∪ `tasks:read:all` ∪ bypass；操作 = 发起人 ∪ collaborator ∪ bypass |

**用户裁定（第三轮，设计门 r2 后）**

| 编号 | 决策               | 结论                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D17′ | 岗位模版名字唯一域 | **`(owner, type, typeRevision, name)`**：保持今天「每个类型版本内名字唯一」的语义、只多一层 owner；kernel 的 owner-name 唯一表改为带**可选分区列**的声明（其余 11 类分区为空）。存量数据天然无重复（迁移不改名），自动升级的 successor 落在不同 type revision 分区。内部身份仍是 ULID `id` + `{id, revision}` exact ref |

**用户裁定（第四轮，设计门 r4 后）**

| 编号 | 决策            | 结论                                                                                                                                                                                                                                                                                                                                                        |
| ---- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D20  | 案例 owner 转移 | **案例也支持 owner 转移，与任务完全同形**：`PUT /members` 的 `ownerUserId` 语义与 `updateTaskMembers`（`taskCollab.ts:356-366`）一致——新 owner 须为活跃非系统用户，前任自动降为 collaborator，同一事务内改 owner + 成员；运行中案例从下一次执行起以新 owner 为发布主体（`runtimeService.ts:2052,2128-2133` 每次执行重读案例 owner）；面板复用任务的转移入口 |

**用户裁定（第六轮，2026-08-26 设计门 r5 后）**

| 编号 | 决策           | 结论                                                                                                                                                                                            |
| ---- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D21  | 安全类一律不做 | **核心是功能，安全类一律不做；设计门 / 实现门一律不允许做安全相关检视、不允许提安全相关问题**（已写入 `CLAUDE.md` §工作准则）。据此撤销 D16 与 v2～v6 全部安全 / 守卫 / 记账层设计（§3 退出项） |
| D22  | 边界项取舍     | 四项介于功能与安全之间的项**全部砍掉**：案例启动过员工可见性、新增引用可见性、successor 继承 grants、案例 mine / shared scope                                                                   |
| D23  | 设计门         | v7 **不再跑设计门，直接呈批**；实现门只审功能自洽                                                                                                                                               |

**按仓内先例作出的默认裁定（随本 RFC 呈批；不同意的逐条改）**

| 编号 | 决策           | 结论                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D5   | 权限点前缀     | 两个新类型复用 `digital-employees:*`（`ACL_PERMISSION_PREFIX`，`routes/resourceAcl.ts:96-129`）；先例 RFC-317 T8 用户裁决「不新开点族」                                                                                                                                                                                                                                |
| D6   | 名字列         | 工具补 `name` 列（镜像 `content.displayName`，ACL kernel 的 `table.name` 契约需要，`resourceAcl.ts:794`），**不**加唯一约束                                                                                                                                                                                                                                            |
| D7   | 工具改名       | `content.displayName` 变更视同改名 → 仅 owner（RFC-324 D3 同则），路由层校一次                                                                                                                                                                                                                                                                                         |
| D8   | 工具退休       | `retire`（含「删除草稿」）归**治理写**（owner / bypass）；粗门仍是 `digital-employees:archive`                                                                                                                                                                                                                                                                         |
| D9   | 平台内置工具   | 没有 DB 行：访问判定投影为 `builtin: true` / `visibility: 'public'` / `access: 'read'`；ACL 挂载的 `load` 对它返回 null ⇒ GET / PUT `/acl` 都 404；前端不渲染权限入口（今天已 `editable: false`，`composition.ts:401`）                                                                                                                                                |
| D11  | 案例判据       | 见 D19 / D20；不可见 404 同形，可见不可操作 403 `employee-case-observer-read-only`（对齐 `task-observer-read-only`，`taskCollab.ts:164-174`）；成员 / owner 变更仅 owner / bypass；重复成员**取最后一条**（与任务侧共用同一 normalization helper，`taskCollab.ts:333-367`）；成员表 `user_id` 外键 `ON DELETE RESTRICT`（与 `task_collaborators` `schema.ts:3216` 同） |
| D12  | 存量行         | 工具 / 模版存量行 visibility 回填 **public**（读面零变化，`0045_rfc099_ownership_acl.sql:28-34` 先例），`acl_revision` 0；工具 `name` 从 `draft_json` 回填，畸形 JSON 行经 `json_valid` 分支落 `''`；D17′ 下模版**不改名**                                                                                                                                             |
| D14  | 错误码与文案域 | 工具 / 模版复用 RFC-324 三码（`resource-read-only` / `resource-govern-owner-only` / `resource-rename-owner-only`）；404 沿用 `employee-tool-not-found` / `employee-job-template-not-found`；新增前端错误域 `digitalEmployee`，前缀 `employee-` 整族接入                                                                                                                |

（D10 / D13 / D15 随 D21 / D22 撤销，编号保留不复用。）

## 6. 能力影响清单（CLAUDE.md §RFC workflow 第 7 条；逐项呈确认；plan §4 给 I↔T 对照）

| 编号 | 被收缩 / 改变的既有能力                                                                                                                                                  | 受影响形态     | 处置                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ----------------------------------------------------- |
| I1   | 非 owner、无 `write` 授权、无 bypass 的账户**不能再改 / 校验 / 发布别人的工具**（今天 `digital-employees:update` 全员可改）                                              | 所有多人部署   | 403 `resource-read-only`；owner 在权限面板授权        |
| I2   | 工具 `retire`（含删草稿）收成 owner / bypass（今天 `digital-employees:archive` 全员）                                                                                    | 同上           | 403 `resource-govern-owner-only`                      |
| I3   | 非 owner、无 `write` 授权者**不能再改 / 发布别人的岗位模版**                                                                                                             | 同上           | 同 I1                                                 |
| I4   | 新建工具 / 模版默认 **private**：其他人在工具箱 / 模版列表里看不到，直到 owner 设 public 或逐人授权（今天新建即全员可见）                                                | 同上           | 权限面板 + 空态文案                                   |
| I5   | 工具 / 模版可被设为 private：对其他人从工具箱 / 模版列表消失；已 pin 的员工定义**不受影响**（引用闭包隐式授权，D2）                                                      | 同上           | 无需处置                                              |
| I6   | 非 owner 编辑者（`write` 档）**不能改**工具显示名 / 模版名字 / 员工定义名字（今天任何人都能通过 PUT 改名）                                                               | 同上           | 403 `resource-rename-owner-only`；名字输入 `disabled` |
| I7   | 工具 authoring body `GET …/tools/:toolId` 对不可见工具 → 404（今天持 `:update` 点即可读）                                                                                | 同上           | 与列表过滤一致                                        |
| I8   | `GET /api/employee-cases/:id` 对非发起人 / 非成员 / 无 `tasks:read:all` / 无 bypass 的账户 → 404（今天持 `digital-employees:read` 全员可读）                             | 同上           | 发起人加成员                                          |
| I9   | `resume` / `terminate` / `policy-upgrade-preview` / `policy-upgrade-apply` 收成发起人 / collaborator / bypass                                                            | 同上           | 403 `employee-case-observer-read-only`                |
| I10  | 三类卡片按档位收敛控件：`read` 档无编辑 / 发布 / 退休；`write` 档无退休 / 改名；平台工具无权限入口；降档后不刷新页面即收敛                                               | 前端           | —                                                     |
| I11  | 三类自定义卡片新增「权限」入口，**所有可见者**可打开只读视图（RFC-324 X10 语义），只有 owner / bypass 能改                                                               | 前端           | —                                                     |
| I12  | 新增案例成员制：案例页新增成员面板、`GET/PUT /api/employee-cases/:id/members`；**成员案例不进统一任务列表的 mine / shared**（D22），从案例页直达                         | 所有部署       | —                                                     |
| I13  | 案例支持 **owner 转移**（D20）：前任降为 collaborator；运行中案例从下一次执行起以新 owner 为发布主体（代码托管凭据按新 owner，缺则推送**显式失败**、不静默沿用旧人身份） | 所有部署       | 转移前提示                                            |
| I14  | 列表 DTO 新增 `visibility` / `access` / `ownerUserId` 字段（必填）；新增 4 条 `…/acl` + 2 条 `…/members` 路由；统一列表 WS 新增 `employee-case.members.changed` 帧       | API 消费者     | additive                                              |
| I15  | 岗位模版名字唯一域从「类型版本内全局」变为「类型版本内 × owner」：**不同 owner** 可以在同一类型版本下有同名模版（今天 409）；同 owner 语义不变；存量不改名               | 所有部署       | 卡片 / 选择器带 owner 徽标并按 id 选择                |
| I16  | 旧 `/code/config/employees` playbook 保存路径改 edit 门：`write` 授权者可以保存 playbook（今天 403）                                                                     | 用旧路径的部署 | 扩能                                                  |
| I17  | `employee_definition` owner 转移撞名：500 → 409 `resource-name-conflict`                                                                                                 | 所有部署       | 修 bug                                                |
| I18  | 类型包自动升级产生的 successor 工具 / 模版继承 source 的 owner + visibility（D18′）；**grants 不继承**——被授权者在新版本上需 owner 重新授权；名字规则与今天相同          | 所有部署       | 升级后 owner 在新版本卡片重新授权                     |
| I19  | 前端错误域新增 `digitalEmployee`，全部 `employee-*` 码从 `misc` 兜底改为该域标题                                                                                         | 前端           | —                                                     |

## 7. 验收标准

**工具 / 岗位模版 ACL**

- **AC-1**：迁移后存量工具 / 模版行 `visibility='public'`、`acl_revision=0`，工具 `name` = `draft_json.content.displayName`（非法 JSON / 缺字段的行为 `''` 且迁移不中断）；
  迁移前后所有既有读路径返回同一集合；模版名字逐行不变。
- **AC-2**：只读被授权人 / 未授权公开读者对工具的 PUT / validate / publish、对模版的 PUT / publish 得到 403 `resource-read-only`；对工具 retire 得到 403 `resource-govern-owner-only`；
  对不可见工具 / 模版的任何路由 → 404 与不存在同形。
- **AC-3**：可编辑被授权人能 PUT / validate / publish 工具与模版；改 `displayName` / `name` 得到 403 `resource-rename-owner-only` 且内容不落盘；retire / ACL PUT 得到 403 `resource-govern-owner-only`。
- **AC-4**：新建工具 / 模版 = 创建者 owner + `private` + 零 grants；平台内置工具 `access='read'`，GET **与** PUT `/acl` 均 404。
- **AC-5**：同 owner 同类型版本同名模版 409 `employee-job-template-name-conflict`；不同 owner 同名可共存；owner 转移撞分区名 409（模版、员工定义）；转移到只有**其它**类型版本同名的 owner → 成功。
- **AC-6**：`GET/PUT …/acl` 四条路由走 `mountAclEndpoints`，`aclRevision` CAS 409、owner 转移后前任落 `read`，与其余 13 类逐条一致。
- **AC-7**：successor 的 owner / visibility 与 source 相同（public / private / null-owner 三类源）；grants 为空；命名四案与今天相同。

**案例**

- **AC-8**：`GET /api/employee-cases/:id`：发起人 / observer / collaborator / `tasks:read:all` / bypass → 200；其他 → 404。
- **AC-9**：`resume` / `terminate` / `policy-upgrade-preview` / `policy-upgrade-apply`：发起人 / collaborator / bypass 放行；observer 与 `tasks:read:all` → 403 `employee-case-observer-read-only`。
- **AC-10**：`GET/PUT /api/employee-cases/:id/members` 通过共享的资源中立成员 schema（`caseId` 变体，含 `canManage` / `canOperate`）；PUT 仅 owner / bypass；非活跃 / 系统用户 422；
  重复成员 last-wins；WS `employee-case.members.changed` 帧送达 before ∪ after 的 owner + 成员。
- **AC-11**：owner 转移（D20）：新 owner 成为 owner、前任降为 collaborator（同一事务）；转移后下一次执行的发布主体 = 新 owner。

**前端**

- **AC-12**：`/digital-employees/$typeRef` 三类卡片按 `access`：`read` → 无编辑 / 发布 / 退休、只读徽标；`write` → 有编辑 / 发布、无退休、名字输入 `disabled`；`own` → 全部；
  平台工具无权限入口；员工卡「新建任务」对 `read` 档保持可用。
- **AC-13**：档位变更后被授权方在下一次 `resource-acl.changed` 重校验后**不刷新页面**切换卡片态。
- **AC-14**：案例页成员面板复用任务成员面板（design §7.5 薄适配器，任务页行为与既有 manage-loss / session-reset / owner-transfer 测试完全不变）；案例 owner 能增删成员与转移、
  非 owner 不能；恢复按钮 = 权限点 ∧ `members.canOperate`。
- **AC-15**：新码有中英文案且与全部既有 `employee-*` 码一起落在 `digitalEmployee` 域（`domainOf` 直测）。
- **AC-16**：旧 `/code/config/employees` 详情页对 `write` 授权者：编辑草稿 → 保存 playbook → 200；带改名 → 403。

**回归防护与登记**

- **AC-17**：`resource-acl:bypass` 持有者在两个新矩阵与案例矩阵中的判定 = 今天。
- **AC-18**：既有 `rfc099-*` / `rfc317-*` / `rfc324-*` 全绿；`rfc099-acl-endpoints-matrix` 增两行；`api-contract-coverage` 精确 `/acl` 清单增两 base；`contracts/registry` 登记 6 条新路由；
  `rfc223-owner-transfer` 增分区转移用例；RFC-329 叶子账本登记 6 条新路由；6 条新路由全部被 e2e 打到；RFC-294 账本涨的项具名 `allowGrowth`。

## 8. 设计门记录

- **第一轮～第五轮（2026-08-26，Codex `gpt-5.6-sol`）**：r1 2/13/3、r2 3/9/2、r3 1/9/2、r4 1/8/2、r5 0/7/1。功能类结论保留在 v7：D17′（模版唯一域）、D19 / D20（案例成员制 +
  转移）、D18′（successor 继承归属）、成员面板适配器、案例成员表归 DE。其余（事务内 admission、写点注册表、存在性 oracle、census 记账、successor 收敛协议、前端边界校验、
  §12 变异证明）属安全 / 守卫 / 记账层，随 D21 全部退出。
- **第六轮**：已启动、按 D21 / D23 中止；结果不采信。
- **v7 起不再跑设计门（D23）**；实现门按 `CLAUDE.md` §工作准则「双门不审安全」执行，只审功能自洽与用户拍板漂移。
- **实现（2026-08-26）**：按 plan T1～T21 单批落地；实现门记录见 plan §5。
