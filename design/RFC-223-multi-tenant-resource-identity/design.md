# RFC-223 技术设计：多租户资源标识（v4）

> 锚点取自只读排查 + **设计门 round 1/2/3（Codex）**。round 1 NO-SHIP（9：2C+6H+1M）；round 2 needs-attention（11：1C+6H+4M）；round 3 needs-attention（7：0C+5H+2M）——critical 已归零，收敛中。全部采纳，见 §14 修订账。v4 核心：**id 化清单力求穷尽（产→存→解析→消费→展示→守卫），承诺力求可实现（删除不可实现的 project frontmatter 校验），PR 边界力求原子（导入管线与存储同 PR）**。

## 1. `name` 作为标识的全部持久化 / 解析 / 展示面（穷尽清单）

### 1.1 唯一性约束（§3）
六表 unique index（五类全局唯一→复合；workflows 非唯一；runtimes 保留）。

### 1.2 活引用（§4.1）
agent→skill/mcp/plugin/runtime/agent、workflow 节点→agent、workgroup 成员→agent、`config.defaultRuntime`、scheduled payload、`resourceRefs`/ACL。

### 1.3 冻结快照生产者 + 全部消费者（§4.2，round-1 F1 + round-2 R2-5 + round-3 R3-2/R3-3）
- 生产者：`tasks.workflow_snapshot`（`schema.ts:743-756`）、`workgroup_config_json`、`node_runs.agent_override_name`（`nodeRunMint.ts:99-104,229`）、动态快照（`dynamicWorkflow.ts:145-150`）、`tasks.source_agent_name`（配套 `source_agent_id` 已存在 `schema.ts:866-873`）。
- 消费者（穷尽）：续跑 `scheduler.ts:2862-2872,4433-4445`、workgroup turn `memberTurns.ts:124-131,280-289`、room 归属 `room.ts:145-155`、workgroup `state.ts:302-329`/`engine.ts:188-205`、蒸馏 `memoryDistillScheduler.ts:171-177`、校验 `workflow.validator.ts:317,765-770`、端口 `nodePorts.ts:132-155`、wrapper `wrapperFanout.ts:59-65`、**review** `review.ts:2690-2696,2992-3001,3242-3248`、**borrow** `taskQuestionDispatch.ts:1289-1295,1730-1747`、task 改/删守卫 `agent.ts:353-365,491-507` + 提交前复核 `task.ts:1616-1637`、前端 `NodeInspector.tsx:126`。

### 1.4 provenance + fusion 全生命周期 + 出站 DTO（§4.3，F2/R2-2/R3-6）
`fusions.skill_name`（`:1901`）、`memories.fused_into_skill`（`:1877`）、launch `fusion.ts:425-460`、decision `:885-903,913-939`、前端 `FuseDialog.tsx`、出站 `FusionSchema`（`schemas/fusion.ts:26`）、详情链接 `fusions.detail.tsx:117-118`。

### 1.5 内建 seeder / 磁盘状态机（§4.6/§5/§13）
fusion seeder `fusion.ts:207-253`、内建 workflow `:301-308`、`systemResources.ts:24-30`（仅 agents/workflows 有 `builtin`）；skill 磁盘 `managed_path`/`files_path`/`skill_operations`（delete/reserve/version-write/migrate，`schema.ts:357-375`）。

### 1.6 注入键 + 自发现边界（§6）
opencode/Claude Code 注入按 name；opencode 另自扫 repo-local project skill（多来源、同名覆盖、并发）。

### 1.7 反向引用 / 派生 key sink（§11，R2-7/R3-5）
删除守卫按名（`skill.ts:290-325`/`plugin.ts:262-280`/`agentDeps.ts:189-210`）、`plugin.ts:336-340` id-or-name fallback、前端 React key `agents.tsx:81`、计算属性赋值 `mcps.tsx:49`、TanStack query key、`.find/.some(name)`。

## 2. 目标架构
全链 id-canonical（产→存→解析→消费→展示→守卫），name 仅展示；动态工作流 LLM 的**机器可读成员引用**只用 opaque token（自由文本不脱敏，§4.2 R4-2）；runner ID hydration 后、staging 前做 runtime-无关**受控 managed 注入集**唯一校验；注入边界保留 name；project skill 属 opencode 自发现域、明示不由本 RFC 唯一性兜底。

## 3. DB 迁移（COALESCE 表达式唯一索引，marker/oracle 修正）

round-2 实测确认 `CREATE UNIQUE INDEX ... ON t(COALESCE(owner_user_id,''), name)` 在 Bun 1.3.13/SQLite 3.51.0 可建、Drizzle 接受。

```sql
DROP INDEX agents_name_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX agents_owner_name_unique ON agents(COALESCE(owner_user_id, ''), name);
--> statement-breakpoint
```
- marker 必须 `--> statement-breakpoint`（`migrations-statement-policy.test.ts:31-32`）。
- 表达式索引验证用 `PRAGMA index_list`/`index_xinfo`/`sqlite_master`（**非** `table_info`）。
- `_journal` SQL/tag 1:1 + `breakpoints:true` + `when` 严格递增。NULL owner backfill `__system__`。
- workflows 非唯一例外；runtimes 全局唯一例外；`skill_versions.skill_name`→`skill_id`（12-step rebuild，FK→`skills.id`，`files_path` 同批，§5）。

## 4. 全链 id 化

### 4.1 活引用
`agents.mcp/plugins/dependsOn`→id；`agents.skills`→typed union（§4.4）；`agents.runtime`/`config.defaultRuntime` 保 name；workflow 节点 `agentId`；`workgroup_members.agent_id`；scheduled payload id；`resourceRefs` 按 id。

### 4.2 冻结快照：生产者→消费者全矩阵 + 动态 token + 任务守卫

**原则**：§1.3 每个生产者 + 每个消费者都以 id 为 identity，name 仅展示。逐点改：
- 快照加 id 字段（`workflow_snapshot`/`workgroup_config_json`/`node_runs.agent_override_id`/动态快照）。
- 全部消费者按 id：`scheduler`(2862/4433)、`memberTurns`、`room`、workgroup `state`/`engine`、蒸馏（按冻结 id 取**单行**）、`validator`、`nodePorts`、`wrapperFanout`、`review`、`taskQuestionDispatch`(borrow)、前端 `NodeInspector`。

**任务守卫（round-3 R3-3）**：`tasks.source_agent_id` 已存在但 delete/rename 守卫（`agent.ts:353-365,491-507`）+ 提交前复核（`task.ts:1616-1637`）仍按 `source_agent_name`——放开后 B 的同名活动任务会挡住 A 的删/改并泄漏 B task id。全改 `source_agent_id`（回填在翻转前）；跨 owner 同名任务的启动/改名/删除/信息隔离测试。

**动态工作流 opaque token（round-3 R3-1 / round-4 R4-2）**：LLM 的**机器可读成员引用**只用 token（自由文本正文不强求脱敏，见下「身份收窄」）。token 间接层覆盖：
- `orchestratorAgent.ts:113` system prompt / `dynamicWorkflowRunner.ts:277-283` agent pool / `agentCapability.ts:184` capability 卡片的**机器可读成员引用 / 标题槽**渲染**任务内 opaque token**（如 `member#1`）；卡片自由文本正文（description/body 摘要）可能含真名，不脱敏。
- `DwStateSchema` 持久化 token→冻结 `agentId` checkpoint（确定性可重建）；生成 schema、runner、`orchestratorAgent` validator、重试错误信息、审批 `dwActions.ts:115-119`、拒绝重生成全按 token/id。
- **身份收窄（round-4 R4-2）**：token 只约束**框架生成的身份字段 / 机器可读成员引用 / 卡片标题 / 诊断**；自由文本（description/body 摘要 `agentCapability.ts:135-146`、charter/goal/拒绝意见 `orchestratorAgent.ts:143-174`）可能偶含真名，**不强求脱敏**（删除 v4 不可实现的「真名不得出现于任意 LLM I/O」承诺）。关键不变式：LLM 的**机器可读成员引用是 token**；服务端有**唯一** token→agentId 转换点；审批、执行、**save-as（`dwActions.ts:216-249`，补入消费者清单）** 一律只消费 **id 形态**。负向测试：框架身份字段 / 成员引用不含真名/id。

**冻结快照回填安全（round-4 R4-1，critical）**：全局唯一只保证**当前**单候选，**不证明历史同一性**——旧快照冻结的 name 可能在迁移前已被 rename+recreate（ABA）重新指派。故：
1. **going forward**：每次 launch 把解析出的 **agentId 冻进快照**（workflow 节点 / workgroup 成员 / dynamic 经 token / `node_runs.agent_override_id`），launch 期按 launcher ACL 作用域确定性正确。
2. **迁移既有快照**：**只从可信 launch-time id 回填**——single-agent 用 `source_agent_id`（RFC-175 已存）；workflow/workgroup/dynamic 旧快照**无**逐节点冻结 id → **禁止按当前 name 猜测**，标记 **quarantine**（保留 name 供展示/审计，按名重解析的 resume/retry 阻断、需显式重建）。**round-5 R5-3**：`0091` 把既有 `source_agent_id` 全设 NULL 且禁 name 回填（`0091_rfc175_task_source_agent_id.sql:5`）——故 single-agent 若 `source_agent_id IS NULL` **同样 quarantine**，pre-0091 fixture 覆盖。`task.ts:1646-1649` 冻结点与 `agent.ts:297-318` 守卫只看当前定义，不保护旧快照——迁移器不得据当前 name 反填历史身份。
3. **回归**：任务冻 A→workflow 移除 A→A rename/delete→B 建原名→迁移**不得**把旧任务绑到 B（用 source_agent_id 命中原 A，或 quarantine）；正常路径旧任务→A rename→B 同名→resume→原 agent、不触 B、不泄漏 B。

### 4.3 provenance + fusion 全生命周期 + 出站 DTO（R2-2/R3-6）
- 存储：`fusions.skill_id`、`memories.fused_into_skill_id`。
- **wire（出站+入站）**：`FusionSchema` = `{skillId, skillName}`（`schemas/fusion.ts:26`）；`LaunchFusion` 收 `skillId`，废无 owner `getSkill(name).limit(1)`。
- 服务：launch/claim/approve/reject/filter/restore（`fusion.ts:425-460,885-939`、`memory.ts:633-661`、`skillVersion.ts:793`）按 `skill_id`。
- 前端：`FuseDialog` value=id、label=name+owner；**详情链接 `fusions.detail.tsx:117-118` 按 skillId**（PR-7 删 name 路由后不断链）；列表过滤/缓存按 id。
- 测试：两 owner 同名 skill 全生命周期 + 详情导航隔离。

### 4.4 agents.skills：持久化 ref 与可移植 selector 分离（R2-4/R3-5）
两个 schema，避免离线 parser 拿不到 DB 却要产 id：

```ts
// 持久化 ref（DB/wire/运行期）
AgentSkillRefSchema = discriminatedUnion('kind', [
  { kind:'managed', skillId }, { kind:'project', name }])  // 取代现 string[]（agent.ts:156,216）
// 可移植 selector（agent.md / YAML 导出，无 DB 依赖）
AgentSkillSelectorSchema = { kind:'managed', name, ownerUsername? } | { kind:'project', name }
```
- 迁移：匹配 DB→`managed{skillId}`；无 DB 行→`project{name}`（RFC-178，不硬失败）。
- 前端 `ResourcePicker`（`:14-16,68-75,93-95`）managed value=id、custom→`project{name}`；不再以 `item.name` 为 identity。
- agent.md parser（`agent-md.ts:25,39-69,395-405`）把 `skills` 列 typed key，产出 **selector**（非持久化 ref）。
- **导入管线与存储切换同 PR（R3-5）**：selector→按 ACL 可用集解析→（翻转前全局唯一→单候选确定性）→id mapping，落在 PR-1/PR-2；多候选 preview/mapping UX 在 PR-8 激活（那时才可能多候选）。

### 4.5 rename 去级联（D7，扩反向引用 R2-7）
活引用 + 反向引用（删除守卫、`plugin.ts:336` id-or-name fallback）改 id 后，`like(agents.*,'%"name"%')` 整段删。

### 4.6 内建 seeder（仅 agent/workflow，R2-11）
`fusion.ts:207-253` seeder + 内建 workflow 节点（`:301-308`）+ `systemResources.ts` 按 `builtin=true+system owner+稳定 id`。不引入 builtin skill。

## 5. skill 磁盘：单一迁移屏障函数（R2-6/R3-7）

**`runSkillIdentityMigrationBarrier`（唯一入口，fail-closed）**：
1. 恢复**全部** skill 操作种类（delete/reserve/version-write/**migrate**）——为 migrate 注册 handler（`skillOpRegistry.ts:13-18` 现缺），否则 `skillOpRecoveryDriver.ts:110-130` 会释放锁丢证据。
2. 耐久枚举未迁 skill（DB 有行但目录仍 `{name}`），按 `skill_operations(kind='migrate')` marker 发起 intent→**`fs-staged`**（幂等 `mv {name}→{id}`；**沿用现有 oracle 认的 phase 名，非新造 `fs-moved`**，round-4 R4-4）→`db-committed`（同事务更 `managed_path`/`files_path`/`skill_versions` FK）→`done`；带指纹/碰撞/回滚。
3. **后置断言**：零未完成 migrate 且所有 DB row 的 `managed_path`/`files_path` 与 FS 一致；否则**禁止** reconcile/seeder/HTTP（`cli/start.ts:283-310,392-405` 不再吞异常继续）。
- boot 与 restore（`restore.ts:432-453`，关闭恢复 DB 前）**共用**此函数；逐相位注入 crash 测试。
- **旧 op 升级兼容（round-4 R4-4，P2）**：现有 reserve/delete/version-write 记录存 `{name}` 无 payload 版本（`skill.ts:195-200`、`skillDeleteOp.ts:32-60`、`skillVersion.ts:503-511`）；迁移前先**双解码 legacy `{name}`** 恢复旧 op 再切 id 路径；每种旧 op × 每个活动 phase 的升级 crash fixture。

## 6. runtime-无关校验 + 自发现边界（R2-3/R3-4 诚实收窄）
- 校验：id hydration 后、staging 前滤 disabled，对**受控 managed 注入集** `{agents, managed skills, mcps}` 按 name 检重 → `duplicate-name-in-closure`；覆盖 opencode + Claude Code；plugin 去重键 id。
- **project skill 边界（R3-4）**：opencode 从多来源自扫、同名覆盖、并发加载（`opencode/src/skill/index.ts:185-243`），**不存在确定的单一 SKILL.md**——故**删除 v3 的「校验 project ref 与 frontmatter 一致」承诺（不可实现）**。诚实边界：本 RFC 的唯一性保证**仅覆盖受控 managed 资源**；repo-local project skill 属 opencode 既有自发现合并域（随 worktree 的 repo、非租户维度），其同名覆盖是 opencode 既有行为、多租户不加剧、不由本校验兜底，文档明示。
- 测试：opencode + Claude 受控集重名报错；disabled 不误杀。

**OpenCode 外部覆盖层——修正错误假设 + 拆分 RFC-224（round-6~8 R6-1/R7-1/R8-1~3；本机 v1.18.4 实证）**：CLAUDE.md「Resolved open questions」记的『`OPENCODE_CONFIG_CONTENT` 优先级最高、平台 agent 恒胜』**对当前 opencode 不成立**——inline 合并于 `config.ts:468-475`，其**之后**仍合并 active-org（`:481-507`）/managed（`:516-523`）/MDM（`:524-531`「override everything」）/legacy `mode.<name>`（`:536-542`，来自 global/project JSON `:398-410`，即 worktree 的 `.opencode/`）/`OPENCODE_PERMISSION` env（`:545-550`；平台 `spawn.ts:170-171` 原样继承 daemon 全部 env）到 `result.agent`（`:537`）；注册表按 name（`agent/agent.ts:267`），且 `disable:true`/`mode:subagent` 可保持 prompt/model/permission 不变却让 `--agent` 回退默认（`agent.ts:268,287`；回退逻辑 `cli/cmd/run.ts:595-667`）；同名 MCP 的 command/url/env/headers/oauth 亦可被替换（`inlineConfig.ts:158-164`）。
- **定位（诚实边界）**：这是**先于多租户就存在的执行完整性缺陷**（平台一直误设 inline 恒胜），与「name 唯一性放开」**正交**；根治需「**同进程**解析最终 effective config，对全部 `Agent.Info` 字段 + 受控 MCP + mode/disable + 合并 permission 做规范化指纹校验，与真实 run **原子**（独立 probe 是 TOCTOU）+ 官方二进制/版本验证」，是独立子工程。→ **拆出后续专项 RFC-224「opencode 执行身份完整性」**；本 RFC **不承诺 execution-unmodified、不假装 inline 恒胜**。
- **本 RFC scope 内做的**：① §6 受控闭包 **name 不撞** 校验（多租户名冲突，RFC-223 核心，见上）；② **廉价兜底**——`spawn.ts:170` 构造子进程 env 时**剔除 `OPENCODE_PERMISSION`**（平台控该 env，一处消除一条向量，不引入 TOCTOU）；③ docs 勘误登记「inline 非最后合并」（CLAUDE.md 的过期断言 `config.ts:641` 旧锚失效，由 RFC-224 更正，本 PR 不改共享文件）。
- 测试（本 RFC）：受控闭包重名报错；子进程 env 无 `OPENCODE_PERMISSION`；`disabled` 不误杀。（effective-config 全字段指纹 / MCP 身份 / 同进程原子性归 **RFC-224**。）

## 7. URL / API / 前端
**四类**执行 `:name→:id`（agents/skills/mcps/workgroups）；plugins/workflows **本就按 id**（`routes/plugins.ts:70`、`routes/workflows.ts:72`）、runtimes 保 name——**四类 name→id + 两类本就 id = 六类租户资源 id 寻址**；前端 `$name→$id` + by-id canonical + name/owner 标签。

## 8. 导入导出（ACL 全集 + selector/ref 分离）
候选集 = RFC-099 可用全集（owner+public+grant+admin，`resourceAcl.ts:164-190`）；导出 selector（§4.4）；导入 selector→解析→（多候选）preview + ref→id mapping 二次提交；`import-ref-unresolved`/`import-ref-ambiguous`；project selector 原样保留不解析。

**workflow YAML（round-4 R4-3，P2）**：workflow 导出/导入同样需与内部 id ref 分离——PR-2 补 `WorkflowDefinitionSelectorSchema`（导出 id→name/owner selector、导入 selector→preview→id mapping），不再直接序列化内部 `WorkflowDefinitionSchema`（`workflow.yaml.ts:43-49,66-97`）。属实现期 P2，不阻断核心架构。

**skill ZIP 导入（round-5 R5-1，high）**：ZIP 覆盖导入（`skill-zip.ts:165,221`）是独立于 agent.md / workflow YAML 的**第三导入入口**，现按全局 `getSkill(name).limit(1)`（`skill.ts:77`）选覆盖目标、overwrite wire 不带 skillId（`schemas/skill.ts:161`），加上 admin 被 ACL 视作任意资源 owner（`resourceAcl.ts:207`）——翻转后 ZIP 覆盖可能改错租户数据。翻转前修：**普通导入只解析 actor 自有** `(ownerId, name)`；**跨 owner 覆盖必须预览返回候选 + 提交携带稳定 `skillId` + owner/OCC 重校**；A/B 同名 + admin 导入回归证明不误命中另一租户。归入 **PR-8**（与唯一性翻转 / 导入契约同 PR：翻转前 `(ownerId,name)` == 全局 name，翻转即启用 owner 作用域）。

## 9. runtime 例外（N1）
`runtimes_name_unique` 不动；`agents.runtime`/`config.defaultRuntime` 存 name。

## 10. 失败模式
受控注入集同名→`duplicate-name-in-closure`；引用/快照 id 失效→missing-refs；导入歧义/无候选→`import-ref-*`；五类同 owner 重名→`-name-in-use`；owner transfer 撞五类→`resource-name-conflict`(409)；skill 迁移屏障后置失败→禁启动。

## 11. 测试策略（必写）
- schema：COALESCE 复合唯一（`index_list`/`index_xinfo`，同拒/跨过/NULL 不击穿）；runtime 全局；workflows 可同 owner 重名；`foreign_key_check`；rolling upgrade + journal/when。
- 跨用户同名矩阵：活引用 + **§1.3 全部消费者**（含 review/borrow/workgroup state·engine/NodeInspector）+ **source_agent_id 任务守卫** 各自命中。
- 冻结快照跨租户：旧任务→A rename→B 同名→resume/retry/蒸馏/dynamic/review/borrow/改名/删除 → 原 agent、不触 B、不泄漏 B task id。
- 动态 token：**框架身份字段 / 机器可读成员引用 / 标题槽**不含真名/id（**自由文本不参与负向扫描**）；唯一 token→冻结 agentId 转换点；两 owner 同名成员生成/拒重生成/审批/执行/save-as 只消费 id。
- fusion：两 owner 同名 skill 全生命周期 + 详情导航隔离。
- typed union：managed/project 混合往返、迁移保留 project、picker 存 id、selector↔ref 分离。
- runtime 校验：opencode+Claude 受控集重名报错、disabled 不误杀（project skill 不承诺 frontmatter 校验）。
- skill 磁盘：`runSkillIdentityMigrationBarrier` 可重入、逐相位 crash、后置断言禁启动、旧备份 forward-restore。
- 内建 seeder：seed 前后同名 agent 不劫持（仅 agent/workflow）。
- owner transfer：五类撞名 409；workflow 重名转让成功。
- import：ACL 全集 + preview + mapping + managed/project。
- **结构守卫（AST/语义 + 变异实证）**：五类无 `:name` 主路由；引用/反向引用不按 `eq/inArray/includes(*.name)`、`.find/.some(name)`、`plugin` id-or-name fallback、JS `Map/Set(name)`、前端 React key/计算属性赋值/TanStack query key（runtime 白名单）；rename 无 `like`；注入校验 runtime 无关。守卫随 PR-8 交付（不晚于翻转，R3-5）。

## 12. 与现有模块耦合 / ACL
RFC-099 owner+visibility+grants 不变；`assertNewRefsUsable` 按 id；owner transfer `OWNER_NAME_UNIQUE_TYPES={agents,skills,mcps,plugins,workgroups}`（排除 workflows）同事务预检→409。归属不进 prompt。RFC-177 by-id canonical；RFC-175 冻结 id 推广至 §4.2（含守卫）；RFC-178 project skill 由 §4.4+§6 保留。RFC-221/222 并发：只加不改。

## 13. 系统资源 / builtin（仅 agent/workflow）
内建 agent/workflow 按 `(builtin=true, system owner, 稳定 id)` 定位/repair；`systemResources.ts` 全 id 键；不引入 builtin skill。

## 14. 修订账（设计门）
**round 1（9 全采纳）**：F1 冻结快照 / F2 provenance / F3 COALESCE+workflows 例外 / F4 PR 垂直切片 / F5 typed union / F6 runtime 无关校验 / F7 导入 ACL 全集 / F8 内建 seeder / F9 transfer 409。
**round 2（11 全采纳）**：R2-1 动态 token / R2-2 fusion 生命周期 / R2-3 自发现边界 / R2-4 typed union 闭环+D8 / R2-5 消费者矩阵 / R2-6 skill 状态机 / R2-7 守卫扩面 / R2-8 transfer 排除 workflows / R2-9 marker+oracle / R2-10 PR 依赖 / R2-11 builtin 收窄。
**round 3（7 全采纳）**：
- R3-1 [high] token 未覆盖 orchestrator 全边界 → §4.2 深化（system prompt/capability/DwState/审批/负向测试）。
- R3-2 [high] 消费者矩阵非穷尽 → §1.3/§4.2 补 review/borrow/workgroup state·engine/NodeInspector。
- R3-3 [high] source_agent_id 未纳入任务守卫 → §4.2 delete/rename/提交前复核按 id。
- R3-4 [high] project frontmatter 校验不可实现 → §6 删除该承诺、诚实收窄至 managed。
- R3-5 [high] selector 与持久化 ref 类型混用 + 管线错 PR → §4.4 分离两 schema、导入管线与存储同 PR。
- R3-6 [medium] fusion 出站 DTO/详情链接未闭合 → §4.3 `{skillId,skillName}` + 链接按 id。
- R3-7 [medium] migrate 状态机缺启动/后置条件 → §5 `runSkillIdentityMigrationBarrier` fail-closed。
**round 4（needs-attention，4 findings；R3-2/3/4/6 已闭合，R3-5/7 闭合留 P2）全采纳**：
- R4-1 [critical] 冻结快照 name→id 回填缺历史身份 oracle（ABA 跨租户）→ §4.2 只从可信 launch-time id 回填、无 id 的旧 workflow/wg/dynamic 快照 quarantine + going-forward launch 冻 id + ABA 升级测试。
- R4-2 [high] 「真名不出现于任意 LLM I/O」不可实现 → §4.2 收窄至框架身份字段/成员引用、唯一 token→id 转换点、补 `dwSaveAsWorkflow` 消费者。
- R4-3 [medium/P2] workflow YAML 缺可移植 selector → §8 PR-2 补 `WorkflowDefinitionSelectorSchema`。
- R4-4 [medium/P2] migrate 屏障旧 op payload/phase 兼容 → §5 双解码 legacy `{name}` + 用现有 `fs-staged` phase。
**round 5（needs-attention，3 findings；R4-1 核心/R4-3/R4-4 经核实已闭合，无新 critical）全采纳**：
- R5-1 [high] skill ZIP 覆盖按全局 name 选目标（跨租户误改）→ §8 第三导入入口：普通只解析 actor 自有 `(ownerId,name)`、跨 owner 覆盖带稳定 skillId + owner/OCC，归 **PR-8**。
- R5-2 [high] R4-2 收窄未改干净（§2/§4.2 段首/§11 测试仍留绝对表述）→ 已同步 design.md:30/60/130 至「仅框架身份字段/成员引用 token 化，自由文本不参与负向扫描」。
- R5-3 [medium] R4-1 未列 pre-0091 单代理 NULL 分支 → §4.2 补「single-agent `source_agent_id IS NULL` 同样 quarantine」+ pre-0091 fixture。
**round 6（needs-attention，1 high + 1 low；R5-1/2/3 经核实已闭合）全采纳**：
- R6-1 [high] opencode inline「最高优先级」假设失效（本机 v1.18.4 实证 active-org/managed/MDM 在 inline 后覆盖同名 agent）→ §6 补外部覆盖层文档 + PR-6 fail-closed 探测（managed/MDM/active-org 存在则拒启动）+ CLAUDE.md 勘误登记。
- R6-2 [low] 记账漂移（§14「归 PR-1」/plan AC 计数/T12 路由数）→ 统一为 PR-8、AC1–AC20、T12 四类 name→id 路由。
**round 7（needs-attention，1 high + 1 low）全采纳**：
- R7-1 [high] PR-6「探测三源」fail-closed 不完整（legacy `mode` 从 global/project JSON `:536-542`/`:398-410`、继承 `OPENCODE_PERMISSION` `:545-550`+`spawn.ts:170-179` 仍可覆盖）→ §6 契约升级为**面向最终 resolved config 的指纹校验 + 清 env + 中和 mode + 未知版本 fail-closed**（非枚举来源）。
- R7-2 [low] 路由数措辞漂移（§7/PR-7 仍写「五类 :name→:id」）→ 统一「四类执行 name→id（agents/skills/mcps/workgroups）+ plugins/workflows 本就 id + runtimes 保 name」。
**round 8（needs-attention，4 high + 1 low；均围绕 opencode 外部覆盖）**：
- R8-1/2/3 [high] 三字段指纹不足（须全 `Agent.Info`+mode/disable+受控 MCP）、独立 probe 是 TOCTOU（须同进程原子）、MCP 身份未保护——本机 v1.18.4 实证 `agent.ts:268/287/333-338`、`spawn.ts:170-171` 全继承 env。→ **架构裁决**：opencode 执行身份完整性是**先于多租户的正交缺陷**、根治为独立子工程，**拆出 RFC-224**；RFC-223 §6 只做受控闭包 name 不撞 + 廉价兜底（清子进程 `OPENCODE_PERMISSION`）+ 修正错误假设，**不再承诺 effective-config 指纹**（消除过度声称即消除 R8-1~3 阻断）。
- R8-4 [high] R7-1 契约未同步进 proposal/plan → 已把 proposal §1「优先级最高」勘误、PR-6/T11/AC20/§6 测试全部同步为「廉价兜底 + 拆 RFC-224」单一契约。
- R8-5 [low] 计数错（四迁+两本就 id = 六类，非五）→ 统一「六类租户资源 id 寻址；runtimes 保 name」。
