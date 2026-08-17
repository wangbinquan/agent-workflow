# RFC-309 · 技术设计

> 产品视角见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)。

## 0. 一句话

把两张模板表合成一张、把配置面搬进流程图、并补上 RFC-304 承诺却没交付的两个入口。
三件事共用一个前提：**模板就是流程的配置**，此外没有别的东西可配。

## 1. 事实基线（写码前按源码核实，可复跑）

| 事实                                                      | 锚点                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 工作项身份唯一键含 `anchorKind`，闭举 `mr/issue/pipeline` | `db/schema.ts:3975`（`codeWorkItems`），唯一索引 `uniq_code_work_items_identity` |
| 两张模板表                                                | `db/schema.ts:4433` `capabilityFrameworks` / `:4484` `capabilityBindings`        |
| 矩阵单元格指向绑定                                        | `db/schema.ts:4532` `repoCapabilityConfig.bindingId`                             |
| `openRound` 只需 workItemId + epoch + workPackage         | `modules/code-capability/infrastructure/sqliteMonitorStore.ts:147`               |
| **平台发起已是域层一等公民**                              | `domain/clarifyRouting.ts:26` `{ kind: 'platform' }`，联合体无 default 分支      |
| **需求输入允许没有回写通道**                              | `domain/requirementInput.ts:62` `writebackHandle` optional                       |
| **T64 上游四态 + 三方差异已实现、零生产导入**             | `domain/templateUpstream.ts`（209 行），RFC-304 plan T64 标 ⛔ 转出              |
| 权限目录是闭集，当前 81 点                                | `shared/src/schemas/permission.ts`；`shared/tests/permission.test.ts:65`         |
| 配置包带两种模板 op                                       | `services/resourcePackage/serialize.ts:319,353`                                  |
| 唯一能开轮次的起点是 webhook                              | `openRound` 的三个调用者上溯至 `services/webhook/webhookDispatch.ts:1441`        |

## 2. 数据模型：一张表

### 2.1 新表

```
capability_templates
  id, name, description, capability
  scripts_json, hooks_json              ← 写入需 scripts:author（§3）
  param_schema_json, param_defaults_json
  agent_by_slot_json, prompt_by_slot_json, params_json
  stage_contract_ver
  upstream_id, upstream_version, base_digest      ← T64
  owner_user_id, visibility, acl_revision, builtin
  created_at, updated_at
```

两张旧表的列**逐一有归宿**，没有丢弃项：框架侧的 `scripts/hooks/paramSchema/paramDefaults/
stageContractVer` 与绑定侧的 `agentBySlot/promptBySlot/params` 并排放进同一行，
ACL 四件套与 T64 三件套各取其一（见 §2.2 的取舍规则）。

### 2.2 迁移（`0165_rfc309_capability_templates.sql`）

**规则：以绑定为主体，框架的内容被复制进来。**

```
FOR EACH binding b (framework f = b.framework_id):
    INSERT capability_templates (
      id            = b.id                    -- 绑定 id 延用，矩阵指针不必改值
      name          = b.name
      capability    = f.capability
      scripts/hooks/param_schema/param_defaults/stage_contract_ver = f.*
      agent_by_slot/prompt_by_slot/params      = b.*
      owner/visibility/acl_revision/builtin    = b.*      -- 组的所有权胜出
      upstream_id      = f.id                  -- 部门那套脚本成为「共同上游」
      upstream_version = f.version（无则 1）
      base_digest      = digest(f 的脚本+钩子+参数表)      -- 供 T64 三方合并
    )

FOR EACH framework f WITH 0 bindings:            -- Q-A：默认保留
    INSERT capability_templates (id = f.id, …f.*, agent_by_slot = '{}')
    -- 列表里标注「待补 agent」；脚本是真实资产，丢掉比留一份未配完的更糟
```

**为什么延用绑定 id 作模板 id**：`repo_capability_config.binding_id` 存的就是它。
延用后该列只需**改名**（`template_id`）而无需**改值**，迁移里最容易出错的一环
（矩阵单元格指向漂移）直接消失，AC-3 变成一条几乎不可能失败的断言。

**旧表处置**：本次直接 `DROP`。RFC-275 的 `schemaAdmission` 是前向单向的，保留空表
只会让下一个读者以为它们还有用。

### 2.3 `anchorKind` 增加 `'platform'`

平台发起的需求没有任何代码托管侧锚点。加第四种取值，`anchorId` 用发起时铸的 ULID：

- **每次手动发起是独立一件工作**——不去重，符合直觉（同一段需求发两次就是两件事）。
- 复用 `'issue'` 塞个假 id 会让 `anchorIdx` 上的查询把它当成真 issue，是说谎。
- `codeFindings.anchorKind`（`schema.ts:3913`）同为闭举，**同批放宽**；
  `codeTriggerDeliveries.anchorKind`（`:4373`）是无约束 text，不动。

## 3. 权限：合并对象，不合并权限

| 面                         | 判据                                               |
| -------------------------- | -------------------------------------------------- |
| 读模板                     | `capability-templates:read`                        |
| 建 / 改 / 删模板           | `capability-templates:{create,update,delete}`      |
| **改 `scripts` / `hooks`** | 上述之外**再加** `scripts:author`（system-domain） |
| 发起一轮                   | `code-rounds:launch`（Q-C 默认新增）               |

**这是本 RFC 最重要的不变量**：脚本以 daemon 身份执行。若「能编辑模板」等于「能改脚本」，
模板写权就等于 daemon 执行权，且该能力会第一次变得 **API token 可达**（框架写点原本是
system-domain）。所以合并后：

- 校验在**服务层按字段**做，不在路由层按资源做——`PUT /api/capability-templates/:id`
  的 body 若改动了 `scripts`/`hooks` 且调用者无 `scripts:author`，**整个请求拒绝**
  （不是静默忽略那两个字段：静默忽略会让人以为保存成功了）。
- 前端逐字段置灰，**不隐藏**（RFC-307 AC-7 已如此实现，界面零改动）。

**点数变化**：8 → 4（+1 新增发起点）。闭集 81 → **78**。四个角色预设点数随之更新，
`permission.test.ts` 的闭集断言同步改。**D5：指向已删点的存量 grant 由迁移直接删除**
（用户裁决「过去的权限还没人用」），迁移里写明这是有意为之而非疏漏。

## 4. 起跑：`POST /api/code/rounds`

```
POST /api/code/rounds
{ capability, templateId, repoId,
  input: <按 capability 取判别联合> }
→ 201 { workItemId, roundId, roundSeq }        ← 即 AC-9 的回执
```

### 4.1 按能力的输入与锚点

| capability       | input                                    | anchorKind | anchorId     |
| ---------------- | ---------------------------------------- | ---------- | ------------ |
| `requirement`    | `{ title, body, documents[] }`           | `platform` | 新铸 ULID    |
| `mr-review`      | `{ mrIid }`                              | `mr`       | `mrIid`      |
| `ci-fix`         | `{ pipelineId }`                         | `pipeline` | `pipelineId` |
| `mr-comment-fix` | `{ mrIid, discussionId }`（Q-B：纯手填） | `mr`       | `mrIid`      |

判别联合而非可选字段袋：`{capability:'mr-review', input:{title:'…'}}` 应当**编译期**
就不合法，而不是在第三个阶段才发现读不到 `mrIid`。

### 4.2 校验（D4：不要求矩阵启用）

按顺序，每条失败都有专属 code 与可读消息：

1. `repo-unresolvable` —— 仓库不存在 / 解不出 code-host endpoint
2. `template-not-visible` —— 模板对发起人不可见（与 404 同形，RFC-099 存在性隔离）
3. `template-capability-mismatch` —— 模板的 capability 与请求不符
4. `template-incomplete` —— 合同里的 agentSlot 有未填的（**逐个列出槽位名**）
5. `agent-not-visible` —— 模板引用的 agent 对发起人不可见
6. `input-invalid` —— 判别联合校验失败

**不校验**：矩阵单元格 enabled、webhook 触发器存在与否。矩阵管的是「自动响应」，
手动发起自带模板。

### 4.3 与既有编排的关系

复用现有机制，不新建第二条路：

- 工作项：`ensureWorkItem`（既有）按 §2.3 的锚点落身份行
- 轮次：`openRound`（`sqliteMonitorStore.ts:147`）——`workPackage` 携带模板快照与 input
- 抢占 / 租约 / 结算：**完全不动**。手动发起只是多了一个「谁按下开始」

**澄清通道**：平台发起 ⇒ `ClarifyOrigin.platform` ⇒ 问题落平台。域层已就绪
（`clarifyRouting.ts:26`），本 RFC 只负责在发起时把 origin 标对。

## 5. 前端：模板详情就是流程

| 现在                              | 之后                                                          |
| --------------------------------- | ------------------------------------------------------------- |
| `/code` 「模板」页：两个列表      | 一个模板列表；行 → **详情**                                   |
| `/code` 「流程」页：选能力+选绑定 | **删除**。详情页即流程，无需再选绑定（模板就是那份配置）      |
| 能力级流程                        | 移到**能力目录**与**新建模板向导**，只读（保住 RFC-307 AC-1） |

- 详情路由 `/code/templates/:id`（新建嵌套路由；`/code` 现为单层，需扩一层）。
- `CapabilityFlow` 组件**零改动**复用；`CapabilityFlowPanel` 的「选绑定」下拉去掉，
  改为从路由参数取模板。
- T64 四态与三方差异预览挂在详情页顶部（AC-11）——复制既然成了取得模板的主要方式，
  「我这份和上游差在哪」就成了常规问题。
- 详情页顶部「用这份模板发起一次」→ 选仓库 + 按能力填输入 → `POST /api/code/rounds`
  → 直达该轮。

## 6. 配置包兼容（AC-12）

`serialize.ts:319,353` 现产 `capability-framework-create` / `capability-binding-create`
两种 op。之后：

- **导出**只产 `capability-template-create` 一种。
- **导入**三种 op 都认：旧的两种按 §2.2 的同一规则合成一份模板（framework op 先落成
  「待补 agent」的模板，随后的 binding op 若引用它则合并进去）。
- 旧包导入后 `upstream_id` 置为包内 framework 的身份，与迁移行为一致。

## 7. 落位（RFC-294）

| 新增 / 变更                                  | 层                                     |
| -------------------------------------------- | -------------------------------------- |
| `domain/launchInput.ts`（判别联合 + 校验）   | `code-capability/domain`               |
| `application/launchRoundCommand.ts`          | `code-capability/application`          |
| `public/commands.ts` 加 `LaunchRoundCommand` | `code-capability/public`（exact 合同） |
| `infrastructure/sqliteTemplateStore.ts`      | `code-capability/infrastructure`       |
| `POST /api/code/rounds` + 模板 CRUD 路由归一 | routes                                 |
| 迁移 `0165_rfc309_capability_templates.sql`  | db/migrations                          |
| `/code/templates/:id` 路由 + 详情页          | frontend                               |

**偏离项（呈用户确认）**：`domain/templateUpstream.ts` 已存在于 domain 层但零导入；
本 RFC 为它接上 application + 路由，不移动文件。

## 8. 失败模式

| 场景                                        | 行为                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| 迁移中途失败                                | 单事务；schemaAdmission 前向单向，失败即回滚到旧表，daemon 拒绝启动并说明 |
| 迁移后矩阵指针对不上                        | 不可能——模板 id 延用绑定 id（§2.2）。仍写一条断言，因为「不可能」需要证据 |
| 无 `scripts:author` 却提交了改动脚本的 body | **整个请求 403**，不静默忽略字段                                          |
| 模板槽位没填全就发起                        | `template-incomplete`，**逐个列出**缺哪个槽位                             |
| 同一需求手动发起两次                        | 两件独立工作项（锚点各自铸 ULID）。这是设计，不是缺陷                     |
| 平台发起的需求要澄清                        | 落平台 clarify；**绝不**尝试回写任何 issue（`clarifyRouting` 已保证）     |
| 旧配置包导入                                | 两种旧 op 合成一份模板（§6）                                              |

## 9. 测试策略

| 层     | 必写                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------- |
| 迁移   | N 绑定 → N 模板且脚本各自继承；零绑定框架保留；**矩阵指针前后指向同一份配置**；旧 grant 被删除 |
| domain | `launchInput` 判别联合：四种能力各正一负一；缺字段 / 多字段均拒                                |
| 权限   | **两条分支都写**：有 `scripts:author` 能改脚本；无则 403 且 agent/prompt 仍可改（AC-6）        |
| 命令   | §4.2 六条校验各一条用例；矩阵未启用时**仍能发起**（AC-8 的正面）                               |
| 路由   | `POST /api/code/rounds` 201 + 六种 4xx；`api-contract-coverage` 登记                           |
| 兼容   | 旧配置包（两种 op）导入 → 一份模板，且 `upstream_id` 正确                                      |
| 前端   | 模板详情渲染流程；无权限置灰；T64 四态呈现；发起表单按能力切换输入                             |
| e2e    | 全新库 → 复制 demo 模板 → 改 agent → 选仓库发起 requirement → 出现在活动页 → 澄清落平台        |

## 10. 呈用户确认

- **Q-A** 零绑定框架：**默认保留**为「待补 agent」的模板（脚本不丢）。
- **Q-B** `mr-comment-fix` 讨论串 id：**默认纯手填**，拉列表列为后续优化。
- **Q-C** 发起权限点：**默认新增** `code-rounds:launch`（不复用 `repos:write`）。
- **Q-D**（本文档新增）迁移后旧表**直接 DROP**，不保留空表。若你要求可回滚窗口，
  需改为保留一个版本周期再删——但那与 RFC-275 前向单向的迁移纪律相悖。

## 11. 实现期发现（跑起来才照出的四条，写回本文档）

起草时以为 PR-3 只差一个路由。实现时发现「打开轮次」离「轮次真的在跑」还有三个接口，
每一个都是本仓反复出现的同一种缺陷形状——**两半各自正确、中间没有接线**。逐条记录，
因为它们都不是读代码能读出来的。

### 11.1 `openRound` 不会让任何东西跑起来

`launchRoundCommand` 起初只做 `ensureWorkItem` + `openRound`：两行写库、回执长得完全正确、
`/code` 活动页也能看到那一轮——**而它永远停在原地**。webhook 路径在同一口气里还做了
`noteWorkItemEvent(scheduler-take)` + `startCodeRoundTask` + `attachRoundTask`。

处置：命令新增 `StartRoundTask` **端口**（不是直接调用——起任务要 `StartTaskDeps`，那属于
装配根），路由注入 `startCodeRoundTask`；回执增加 `taskId`。用例锁两处：命令层断言启动器
被调用且 `code_work_rounds.task_id` 落库；路由层用一个**克隆不了的仓库**断言它确实尝试了
启动（能拿到仓库类错误 = 接线在；拿到 201 = 接线断了）。

### 11.2 工作项状态机没有「人按了按钮」这一事件

`scheduler-take` 只接受 `queued`，而 `ensureWorkItem` 出来的新行是 `idle`；webhook 路径先靠
`external-signal` 把它推到 `queued`。手动发起借用 `external-signal` 就是在说谎（没有任何
托管侧信号），于是给状态机加了 `platform-launch`：只在 `idle/settled/failed` 合法，**运行中
一律拒绝**（`round-already-in-flight`）。这条拒绝是有意义的产品行为——webhook 突发可以合并
成一个 pending revision（只有最新状态要紧），而人按两次按钮没有东西可合并，同一 MR 上两轮
会抢同一把锁、写同一棵工作树。

### 11.3 调度器要求「冻结的 webhook 上下文」，平台发起没有

`buildCapabilityWiring` 那一支的判据是 `state.triggerContext !== null`。平台发起没有投递，
于是整支不进——轮次起来、拿到锁、每个阶段拒绝。而 `requirement` 的两个关键字段更是**写死**的：
`input: null`（于是 `resolve-input` 回答「这是引用、没有 entry 脚本」——在说一份就躺在轮次里的
需求正文）与 `origin: {kind:'issue', 两个 false}`（于是 `routeClarify` **拒绝启动**，理由是
「请改从平台提交」——而人正是从平台提交的）。

处置：①`WebhookTriggerFields` 旁边加 `CodeContextFields`（同一字段袋、`event_type` 可选），
两个入口共用，平台发起不再需要伪造一个从未发生的托管事件；②`CapabilityWiringInput` 增加
`requirementInput` / `clarifyOrigin` 两个可选口，**默认值保持原样**（issue 形状 + 两个 false），
所以 issue 入口一字未改；③调度器从轮次的 `workPackage.launch` 读回发起输入。
用例把两个方向都锁上：给了 `requirementInput` 就 `done`、没给仍旧 `failed('reference')`；
`platform` 走 platform、默认仍旧 `refuse`。

### 11.4 三方合并的「新基线」取错方向会在**第二次**才暴露

最自然的写法是把合并后的本地行记为新基线。第一次合并看起来完全正确；第二次读时，
被我们**保留**的字段基线等于我方值、上游仍是他方值 ⇒ 判成「上游改了、我方没改」⇒
反过来劝你撤销刚保护住的改动。基线是**共同祖先**，只能往上游走；**唯独仍在冲突的字段
保留旧基线**，否则一次「合并」就把没人裁决过的分歧按上游意见静默了结。`upstreamVersion`
同理：只有冲突清零才推进，否则徽标会在还有未决分歧时消失。（另：应用了零个字段的合并
写作彻底 no-op——连 `updatedAt` 都不动，否则**下游**模板会因为一次什么都没做的操作集体
显示「有更新」。）

## 12. 已知取舍（本 RFC 有意留下）

- **手动发起的 `stable_project_id` 用的是缓存仓 id，不是托管侧 project id**。后者只有投递
  才带得来（GitLab 是数字 id），手动发起没有投递也无法在不发 API 请求的前提下算出。
  代价：同一个 MR 上「手动一轮」与「webhook 一轮」是两件工作项，不去重、不共享 MR 锁。
  可见后果是重复劳动（两份检视，或第二次 push 被 git 以 non-fast-forward 拒掉），不是数据
  损坏；替代方案「平台没见过该仓库的投递就不许发起」会直接废掉本入口存在的理由。
- **迁移后的模板一律呈 `orphaned`**：`upstream_id` 指向的原框架已被 DROP（AC-2 如此规定）。
  这是 T64 四态里**准确**的那一个（「来源已删除，这份复制品从此独立」），也正是 §5 已呈报的
  能力收缩的如实呈现；「改上游 → 各组显示有更新」适用于**此后**的复制，不适用于迁移存量。
