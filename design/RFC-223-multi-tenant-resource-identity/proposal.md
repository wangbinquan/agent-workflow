# RFC-223 多租户资源标识：id 规范化与 name 唯一性放开

- 状态：Done（2026-07-23）
- 关联：RFC-099（资源 ACL）、RFC-177（by-id 解析器）、RFC-175（`source_agent_id` 冻结先例）、RFC-221 / RFC-222（历史共享文件合并面）、RFC-224（opencode 最终 resolved-config 执行身份完整性；独立后续，不阻塞 RFC-223 完成）

> 本 RFC 由「工作组 URL 为什么用 name 不用 id」这一问题延伸而来，最终定位为**多租户改造中 `name` 全局唯一这条隐含契约的全面拆除**。

## 1. 背景与动机

平台即将进入多租户：不同用户各自创建、拥有、管理自己的资源。当前 `name` 在六类资源（agents / skills / mcps / plugins / workflows / workgroups）上多为**全局唯一**（独立的 `CREATE UNIQUE INDEX`）。这是单租户时代的隐含假设——`name` 同时被当作**五重身份**在用：

1. **全局唯一键**（DB unique index + 服务层判重）
2. **URL / REST 寻址键**（`/agents/:name` 等）
3. **跨资源引用键**（agent 按名引用 skill/mcp/plugin/runtime/agent；workflow 节点按名引用 agent；workgroup 成员按名引用 agent；scheduled payload；ACL 引用检查——15 个引用点几乎全按名）
4. **skill 磁盘目录键**（`~/.agent-workflow/skills/{name}/files/`）
5. **opencode 注入键**（`OPENCODE_CONFIG_CONTENT.agent.<name>` / 注入的 skill 目录名）

「不同人可建同名资源」要求放开第 1 重全局唯一，于是第 2/3/4 重必须逐一改由 `id`（ULID 主键）承载。

**关键外部约束（已核实 opencode 源码）**：opencode 的 agent / skill 注册表按 **name** 为键、认不得我们的 ULID（`agent/agent.ts:267,272-280,312-313`；inline config 合并于目录扫描之后 `config/config.ts:468-475`——但**并非最终**：其后仍有 active-org/managed/MDM/`mode`/`OPENCODE_PERMISSION` 覆盖，故「inline 优先级最高、平台 agent 恒胜」的旧假设**不成立**，见 §6 + 拆分的 RFC-224）。因此**第 5 重身份拆不掉**——架构必须**分层**：内部一律 id，唯独 opencode 注入边界保留 name。

**前提（用户 2026-07-23 明确）**：现无存量生产系统，不做 back-compat / dual-read；一次性把架构改到最干净形态，只需保证升级迁移正确；无「既有导出 YAML 再导入」的兼容负担。

## 2. 目标 / 非目标

**目标**
- **G1** `id`（ULID）成为所有租户资源的唯一规范标识：URL、REST、跨资源引用、skill 磁盘目录全部以 id 寻址 / 存储。
- **G2** `name` 唯一性从「全局」放开为 `(owner_user_id, name)` **复合唯一**：跨用户可同名，同一用户内不重名（**仅五类：agents/skills/mcps/plugins/workgroups；workflows 沿用非唯一例外、runtimes 全局唯一例外**）。
- **G3** 消除放开唯一性引入的二义：跨资源引用改存 id；opencode 注入前保证单次 run 的依赖闭包内 name 唯一（冲突明确报错）。
- **G4** 顺带修复 name 全局唯一被打破后暴露的真实缺陷（跨 owner rename 污染、within-run 同名静默丢弃）。

**非目标**
- **N1** runtime **不**纳入放开：它是 admin 管理的机器级二进制配置（无 `owner_user_id` / `visibility` 列、不可改名），保持全局唯一。
- **N2** 不改 opencode「注入按 name」的协议（外部硬约束）。
- **N3** 不做旧行为的兼容层 / dual-read（无存量）。
- **N4** 不改 RFC-099 的 ACL 模型（owner + visibility + grants 不变，只把「按 name 解析成行」改为「按 id 解析」）。
- **N5** URL 不采用 GitHub 式 `owner/name` 可读路径（用户选 id 寻址；`owner/name` 作为未来可选增强留档，不在本 RFC 范围）。

## 3. 用户故事

- **US1** 用户 A 建名为 `auditor` 的 agent，用户 B 也能建自己的 `auditor`，互不冲突、互不可见（除非设为 public）；A 自己不能建第二个 `auditor`。
- **US2** A 的 agent frontmatter 引用 skill `lint`，解析到的永远是「A 选中的那一个具体资源」（自己的或某个 public 的），不会因为 B 也有 `lint` 而串。
- **US3** A rename 自己的 mcp，绝不影响 B 的同名 mcp、也不改动 B 的 agent 引用。
- **US4** 若某次 run 的依赖闭包里同时出现两个不同 owner 的同名 agent（opencode 无法区分），启动**明确报错**并指出冲突，而不是静默丢一个。
- **US5** 分享一个资源详情页 URL：URL 用 id，rename 不会让链接失效、也不会指向另一个同名资源。

## 4. 设计决策（记录 + 依据）

| # | 决策点 | 选择 | 依据 |
|---|---|---|---|
| **D1** | 唯一性粒度 | `(owner_user_id, name)` 复合唯一（**仅五类；workflows/runtimes 例外**） | 用户「不同人可同名」；同一用户内保持不重名利于列表可读；owner 列已就位 |
| **D2** | 寻址方案 | **id 寻址**（URL / REST / 引用 / 磁盘），name 仅展示 | 用户拍板（AskUserQuestion）；最简单、零二义、复用 RFC-177 by-id 解析器 |
| **D3** | runtime | **不放开**，保持全局唯一 + admin 管理 | 用户拍板；runtime 无 owner 列、机器级配置、不可改名 |
| **D4** | 跨资源引用存储 | 引用列改存 **id** | id-canonical 的必然；用户「全改好 + 无旧 YAML 再导入」移除了 name 可移植性的兼容约束 |
| **D5** | opencode 注入边界 | 保留 name-key；注入前强制**单 run 闭包 name 唯一**，冲突报错 | opencode 源码硬约束；自动别名会断掉 prompt / opencode 的按名引用 |
| **D6** | skill 磁盘键 | `skills/{name}` → `skills/{id}`；`skill_versions` 外键 `→skills.name` 重指 `skills.id` | 唯一的真磁盘键；避免跨用户同名 skill 串目录；FK 是唯一需 table-rebuild 处 |
| **D7** | rename | 走 id；删除 `like '%"name"%'` 式跨 owner 引用改写 | 修复 G4 污染 bug；引用已存 id、天然稳定，无需级联改写 |
| **D8** | 导入导出 | 内部存 id；导入边界按 **RFC-099 可用全集**（owner+public+显式 grant+admin）解析 name→id，多候选走 import preview + ref→id mapping 二次提交 | 保留跨环境可移植又确定性；与真实 ACL 模型一致（round-2 R2-4 修正：旧「自己的→public」与 AC10 矛盾）；无旧 YAML 负担 |

## 5. 验收标准（v2，含设计门 round-1 补项）

- **AC1** 两个不同用户可各自创建同名 agent / skill / mcp / plugin / workgroup（**五类**），均成功；同一用户内重名被拒（`COALESCE(owner_user_id,'')`,name 复合唯一冲突）。**workflows 例外**：沿用今天的「name 非唯一、id 为唯一标识」，不纳入同 owner 唯一（design §3）。
- **AC2** **四类**既有 name-addressed 资源（agents/skills/mcps/workgroups）详情页 URL 与 REST 端点改为 **id 寻址**、不再有 `:name` 主路由；plugins/workflows 本就 id、runtimes 保 name（**四类 name→id + 两类本就 id = 六类租户资源 id 寻址**）。
- **AC3** 全部**活引用**（agent→skill/mcp/plugin/agent、workflow 节点→agent、workgroup 成员→agent、scheduled payload、ACL 引用检查）**与全部冻结快照**（AC11）按 **id** 解析；跨用户同名零串扰（A/B 同名矩阵）。
- **AC4** rename A 的资源不改动 B 的任何行 / 引用（回归锁 D7 bug）。
- **AC5** skill 磁盘目录 / 版本目录 / `managed_path` / `files_path` 按 **id** 落盘（可恢复垂直迁移 + ledger + 旧备份 forward-restore）；两用户同名 skill 各自独立目录、不覆盖 / 串读；boot verify 绿。
- **AC6**（F1/R2-3/R3-4）单 run **受控 managed 注入集**（先滤 disabled MCP）内两个不同 id 同 name → 启动**硬失败** `duplicate-name-in-closure`，opencode 与 Claude Code 两 runtime 均覆盖（runtime 无关、不静默 first-wins）；repo-local project skill 属 opencode 自发现域、非租户维度、**不由本校验兜底**（诚实边界，不承诺不可实现的 frontmatter 一致校验）。
- **AC7** 注入键仍按 **name**（opencode/Claude Code 硬约束，golden 语义不变）；唯一校验在 id hydration 后、staging 前执行。
- **AC8** runtime 仍全局唯一、admin 管理，未被放开（回归锁 N1）；`agents.runtime`/`config.defaultRuntime` 仍存 name。
- **AC9**（含 R2-9）一次性 schema 迁移：`COALESCE(owner,'')`,name 表达式唯一索引（NULL-safe、免六表重建，marker `--> statement-breakpoint`）；`skill_versions` FK `→skills.id` 走 12-step rebuild；fresh install 全绿；dev 升级 backfill 确定性正确；表达式索引用 `PRAGMA index_list`/`index_xinfo`/`sqlite_master` 验证（非 `table_info`）+ `foreign_key_check` + rolling upgrade + journal/when。
- **AC10** 导入 agent.md / workflow YAML：引用按 **RFC-099 可用全集**（owner+public+grant+admin）解析 name→id；多候选返回 **import preview**（候选 id/owner/visibility）+ 用户 **ref→id mapping** 二次提交；无候选 `import-ref-unresolved`、多候选未决 `import-ref-ambiguous`。
- **AC11**（F1/R4-1）全部冻结快照按 **id** 冻结/解析（**going forward** launch 即冻 `agentId`）；**迁移既有快照只从可信 launch-time id 回填**（single-agent 用 `source_agent_id`；workflow/workgroup/dynamic 无逐节点冻结 id 的旧快照 **quarantine、不按当前 name 猜测**）。回归锁：①「任务冻 A→workflow 移除 A→A rename/delete→B 建原名→迁移**不得**绑到 B」ABA；②「旧任务→A rename→B 同名→resume→原 agent、不触 B」。
- **AC12**（F2）fusion/memory provenance（`fusions.skill_id`、`memories.fused_into_skill_id`）按 id；两 owner 同名 skill 各自 fusion/restore 互不改对方 memories。
- **AC13**（F5/R3-5）`agents.skills` 分离**持久化 ref**（`AgentSkillRefSchema`：managed→skillId / project→name）与**可移植 selector**（导出/agent.md，name-based，无 DB 依赖）两 schema；导入管线（selector→解析→mapping）与存储切换**同 PR**；迁移 managed→skillId、project→原样保留（不硬失败）；RFC-178 `migration-0092` 锁不破。
- **AC14**（F8/R2-11）内建 **agent/workflow**（仅此两类有 `builtin` 字段）按 `builtin=true + system owner + 稳定 id` 定位/repair；用户 seed 前后建同名 agent 不劫持、不批量改 owner。**不引入 builtin skill**。
- **AC15**（F9/R2-8）ACL owner transfer 撞目标 owner 同名（`OWNER_NAME_UNIQUE_TYPES` 五类，workflows 除外）→ 事务内预检 `resource-name-conflict`（409），不裸 500；workflow 重名转让仍成功。
- **AC16**（R2-1/R3-1/R4-2）动态工作流生成用**任务内 opaque token**：token 约束**框架生成的身份字段 / 机器可读成员引用 / 卡片标题 / 诊断**（不强求自由文本脱敏——不可实现的「任意 LLM I/O 无真名」承诺已删）；服务端**唯一** token→冻结 `agentId` 转换点，审批 / 执行 / **save-as（`dwActions`，补入消费者）** 只消费 id 形态；两 owner 同名成员生成/执行不误选；负向测试：框架身份字段/成员引用不含真名/id。
- **AC17**（R2-2/R3-6）fusion **全生命周期**（launch/claim/approve/reject/filter/restore）+ **出站 DTO `{skillId, skillName}`** + 详情链接/过滤/缓存按 `skillId`；`LaunchFusion` wire 收 `skillId`，前端 value=id、label=name+owner；两 owner 同名 skill 互不干扰、详情导航不串。
- **AC18**（R3-3）`tasks.source_agent_id` 全面接入：delete/rename 活动任务守卫 + 提交前复核按 **id**（非 name）；B 的同名活动任务不挡 A 的删除/改名、不泄漏 B task id。
- **AC19**（R5-1）skill ZIP 覆盖导入（第三入口）按 **owner 作用域** `(ownerId, name)` 解析；跨 owner 覆盖需预览候选 + 提交携带稳定 `skillId` + owner/OCC 重校；A/B 同名 + admin 导入不误命中另一租户。
- **AC20**（R6-1~R8-3）修正「inline 优先级最高」错误假设（本机 v1.18.4 实证 inline 非最后合并：active-org/managed/MDM/legacy `mode`/`OPENCODE_PERMISSION`/`disable` 均可覆盖或回退）；本 RFC 廉价兜底 = 子进程 env **剔除 `OPENCODE_PERMISSION`** + docs 勘误登记；**opencode 执行身份完整性（effective-config 全字段指纹 / 受控 MCP / mode·disable / 同进程原子 / 版本验证）拆出 RFC-224**，本 RFC **不承诺 execution-unmodified**。

## 6. 行为变化（breaking，无兼容层）

- **B1** 资源 URL 从 `/agents/{name}` 变为 `/agents/{id}`；旧 name 链接不再解析。
- **B2** REST 端点从 `:name` 改 `:id`（前端全量跟改，无双挂）。
- **B3** 引用列存储从 name 变 id（DB 层；用户不可见，导入导出 / frontmatter 编辑体验按 §8 调整）。
- **B4** rename 不再级联改写引用字符串（引用已是 id，天然稳定）。
- **B5** skill 磁盘路径从 name 变 id（运维可见；备份 / 恢复自动跟随目录树）。
