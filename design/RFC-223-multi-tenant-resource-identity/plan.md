# RFC-223 任务分解与交付记录（Done，2026-07-23）

> **完成态**：PR-1～PR-9、T1–T17、AC1–AC20 全部交付。本次仅在本地完成并提交，未获授权推送；RFC-224 是独立后续，不构成本 RFC 欠账。
>
> **历史落库顺序**：唯一性放开是唯一行为翻转，实际按 `deferred 0115 → PR-5 → PR-4 → PR-7 → PR-8 → PR-9` 完成。下方拆分、依赖图和 PR 编号保留为实现追溯，不再表示待办。

## PR 拆分

| PR          | 范围                                                                                                             | 关键交付                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 主要测试                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **PR-1 ✅** | agents.\* 活引用 + typed union 全链（R2-4/R3-5）                                                                 | `agents.mcp/plugins/dependsOn`→id + resolver；分离 `AgentSkillRefSchema`（持久化 ref：managed=skillId/project=name）与 `AgentSkillSelectorSchema`（可移植 selector）；贯通 DB/wire/`ResourcePicker`/`agent-md` parser；**导入适配（selector→解析→id，翻转前单候选确定性）同 PR**；backfill                                                                                                                                                                                                                                             | 闭包按 id；project 保留（`migration-0092`）；picker 存 id；selector↔ref 分离往返                                                   |
| **PR-2 ✅** | workflow/workgroup/scheduled/ACL 活引用→id                                                                       | workflow 节点 `agentId`；`workgroup_members.agent_id`；scheduled payload id；`assertNewRefsUsable` 按 id；backfill；**`WorkflowDefinitionSelectorSchema`**（YAML 可移植 selector，R4-3/P2）                                                                                                                                                                                                                                                                                                                                            | 跨用户同名矩阵                                                                                                                     |
| **PR-3 ✅** | 冻结快照 + **全消费者矩阵** + 动态 token 全链 + 任务守卫 + **回填安全**（F1/R2-5/R2-1/R3-1/R3-2/R3-3/R4-1/R4-2） | 快照加 id；消费者全按 id：`scheduler`(2862/4433)/`memberTurns`/`room`/workgroup `state`·`engine`/蒸馏(取单行)/`validator`/`nodePorts`/`wrapperFanout`/**`review`**/**`taskQuestionDispatch`(borrow)**/前端 `NodeInspector`；**`source_agent_id`** delete/rename/提交前复核守卫按 id；**动态 token**（身份字段/成员引用/卡片/诊断 token 化、唯一 token→id 转换点、补 `dwSaveAsWorkflow` 消费者，自由文本不强求脱敏）；**冻结快照回填只从可信 launch-time id（source_agent_id），旧 wf/wg/dynamic 快照 quarantine 不按当前名猜（R4-1）** | ABA：冻 A→移除 A→A rename/del→B 建原名→不得绑 B；旧任务→A rename→B 同名→resume→原 agent；token 负向                                |
| **PR-4 ✅** | provenance + fusion 全生命周期 + 出站 DTO + 内建 seeder（F2/R2-2/R3-6/F8/R2-11）**〔依赖 PR-5〕**                | `fusions.skill_id`/`memories.fused_into_skill_id`；`FusionSchema={skillId,skillName}`、`LaunchFusion` wire=skillId、seed/claim/approve/reject/filter/restore 按 id、`FuseDialog` value=id、过滤/缓存按 id；内建 agent/workflow 按 builtin+system+稳定 id（内建 workflow 节点存 agentId ← PR-2）。详情页在 PR-7 切 canonical skillId Link                                                                                                                                                                                               | 两 owner 同名 skill 全生命周期；seed 前后不劫持；DTO/picker/filter id                                                              |
| **PR-5 ✅** | skill 磁盘迁移屏障（F4/R2-6/R3-7/R4-4）**〔PR-4/7 前置〕**                                                       | `runSkillIdentityMigrationBarrier`（唯一 fail-closed 入口）：恢复全部 op（含新 migrate handler、**legacy `{name}` 双解码**）→耐久枚举/驱动 `skill_operations(kind='migrate')` intent/**`fs-staged`**(现有 oracle phase 名)/db-committed/done→**后置断言零未完成+DB/FS 一致否则禁 reconcile/seeder/HTTP**；boot 与 restore 共用；`managed_path`/`files_path`/FK 同事务                                                                                                                                                                  | 逐相位 crash；后置禁启动；旧 op×phase 升级 fixture；旧备份 forward-restore；boot verify                                            |
| **PR-6 ✅** | runtime-无关校验（受控 managed 集）+ 廉价 env 兜底（F6/R2-3/R3-4/R6-1~R8-3）                                     | `0fe04bec`：id hydration 后滤 disabled，对**受控 managed 集** `{agents,managed skills,mcps}` 按 name 检重→`duplicate-name-in-closure`；opencode+Claude Code；plugin 去重键 id；**project skill 属 opencode 自发现域、不承诺 frontmatter 校验**（诚实边界）；**子进程 env 剔除 `OPENCODE_PERMISSION`（廉价兜底；effective-config 全字段指纹/受控 MCP/mode·disable/同进程原子/版本验证拆 RFC-224）**                                                                                                                                     | 双 runtime/边界矩阵；全量 backend 6738、shared 1420、frontend 5215，0 fail                                                         |
| **PR-7 ✅** | URL/API/前端 id 寻址 **〔依赖 PR-5+PR-4〕**                                                                      | **四类** `:name→:id`（agents/skills/mcps/workgroups；plugins/workflows 本就 id、runtimes 保 name）；前端 detail `$name→$id`+`api.*`/`Link`；by-id canonical；name+owner 标签；workgroup member、scheduled target、task wizard 写侧直接提交 id；fusion detail 使用 PR-4 `skillId`                                                                                                                                                                                                                                                       | 前端路由 + e2e；name URL 404；写侧拒绝 name-only                                                                                   |
| **PR-8 ✅** | **唯一性放开（最后）+ 判重 + 导入多候选 + skill ZIP + transfer + 结构守卫（F3/R2-9/F7/F9/R2-8/R3-5/R5-1）**      | migration：COALESCE 表达式唯一索引（五类，marker `-->`）+ NULL backfill + workflows 例外；判重带 owner；导入多候选 preview+mapping 激活；**skill ZIP 覆盖 owner 作用域 `(ownerId,name)` + 提交带 skillId + owner/OCC**；owner transfer `OWNER_NAME_UNIQUE_TYPES`（排除 workflows）预检 409；**四类结构守卫（AST/语义）随此 PR 落**（不晚于翻转）                                                                                                                                                                                       | 复合唯一（`index_list`/`index_xinfo`）；import 多候选；skill ZIP A/B 同名+admin 不误命中；transfer 409+workflow 成功；守卫变异必红 |
| **PR-9 ✅** | 跨租户对抗测试套件                                                                                               | rename/resume/fusion/import/transfer/probe/borrow/review 跨租户对抗；管理员同时见两条同名资源的导航/probe/编辑/删除 e2e                                                                                                                                                                                                                                                                                                                                                                                                                | 对抗全绿                                                                                                                           |

## 子任务（T1–T17，全部完成）

- T1（PR-1）agents.mcp/plugins/dependsOn→id + resolver。
- T2（PR-1）`AgentSkillRefSchema`+`AgentSkillSelectorSchema` 分离，DB/wire/picker/agent-md/导入适配全链 + 迁移保留 project。
- T3（PR-2）workflow 节点 agentId + 调度/resourceRefs。
- T4（PR-2）`workgroup_members.agent_id` + scheduled payload id。
- T5（PR-3）四类冻结快照 id + **全消费者矩阵**（含 review/borrow/workgroup state·engine/NodeInspector）。
- T6（PR-3）动态 token 全链（orchestrator prompt/capability/DwState/审批/负向测试）。
- T7（PR-3）`source_agent_id` delete/rename/提交前复核守卫按 id + 蒸馏取单行。
- T8（PR-4）provenance→id + fusion 全生命周期 + 出站 DTO `{skillId,skillName}`；详情链接由 PR-7 在 canonical id route 就位时切换。
- T9（PR-4）内建 agent/workflow 按 builtin+system+稳定 id（无 builtin skill）。
- T10（PR-5）`runSkillIdentityMigrationBarrier` + migrate handler + 屏障后置 + forward-restore。
- T11（PR-6）✅ `0fe04bec`：受控 managed 集校验 + plugin 去重键 id（project 不承诺 frontmatter）+ **子进程 env 剔除 `OPENCODE_PERMISSION`（廉价兜底；完整执行身份指纹拆 RFC-224）**。
- T12（PR-7）四类 `:name→:id`（agents/skills/mcps/workgroups）+ 前端路由/api/Link/by-id/owner 标签 + workgroup/scheduled/task-wizard 写侧 id。
- T13（PR-8）COALESCE 复合唯一 migration（marker `-->`）+ owner backfill + workflows 例外 + `index_list`/`index_xinfo`/`foreign_key_check`。
- T14（PR-8）判重带 owner；导入多候选 preview+mapping；**skill ZIP 覆盖 owner 作用域 + skillId + owner/OCC（R5-1）**；owner transfer `OWNER_NAME_UNIQUE_TYPES` 预检 409。
- T15（PR-8）四类结构守卫扩面（AST/语义：eq/inArray/includes(name)、`.find/.some(name)`、id-or-name fallback、JS Map/Set、React key/计算属性赋值/query key；变异实证）。
- T16（PR-9）跨租户对抗套件。
- T17（PR-9）管理员双同名资源 e2e（导航/probe/编辑/删除）。

## 依赖

```
PR-1 → PR-2 → PR-3 → deferred 0115
  └────────────────────→ PR-6 ✅ (翻转前校验)

deferred 0115 → PR-5 (skill DB/FS/version 真正 by-id)
                    ↓
                  PR-4 (fusion/provenance/seeder by-id)
                    ↓
                  PR-7 (四类 URL + 全写侧 id)
                    ↓
                  PR-8 ★翻转 + 判重 + 导入多候选 + transfer + 结构守卫
                    ↓
                  PR-9 跨租户对抗
```

## 验收清单（proposal §5：AC1–AC20）

- [x] AC1 五类跨 owner 同名可建/同 owner 拒；workflows 例外
- [x] AC2 四类 name→id + 两类本就 id = 六类租户资源 id 寻址
- [x] AC3 活引用+冻结快照按 id
- [x] AC4 rename 隔离
- [x] AC5 skill 磁盘 id（屏障+forward-restore）
- [x] AC6 受控 managed 集同名硬失败（双 runtime）
- [x] AC7 注入键仍 name，校验在 hydration 后
- [x] AC8 runtime 未放开
- [x] AC9 COALESCE（marker `-->`、`index_list`/`index_xinfo`）+ FK rebuild
- [x] AC10 导入 ACL 全集+preview+mapping
- [x] AC11 冻结快照 id + 跨租户回归
- [x] AC12 provenance id + fusion 隔离
- [x] AC13 typed union（ref/selector 分离），RFC-178 不破
- [x] AC14 内建 agent/workflow（无 builtin skill）
- [x] AC15 owner transfer 409（五类）+ workflow 成功
- [x] AC16 动态 token 全链 + 负向
- [x] AC17 fusion 全生命周期 + 出站 DTO + 详情链接 id
- [x] AC18 source_agent_id 任务守卫按 id
- [x] AC19 skill ZIP 覆盖 owner 作用域 + skillId + owner/OCC
- [x] AC20 修正 inline 假设 + 子进程清 OPENCODE_PERMISSION（完整执行身份拆 RFC-224）

## 完成态门禁

- migration `0111`～`0118` 已落地；fresh install、rolling upgrade、表达式唯一索引、FK 与 skill identity barrier 验证全绿。
- T15 exact AST 指纹多重集护栏已交付；真实 production 非法 sink 注入会 red，还原后 8/8 green。
- 最终本地门禁包括 `typecheck`、`lint`、`format:check`、完整 `test`、完整非视觉 `e2e`、`build:binary` 与 `git diff --check`；精确计数见 `HANDOFF.md`。
- 本次未获授权推送；不得把本地完成态写成远端 CI 已绿。

## 交付记录（2026-07-23）

- PR-1～PR-6 地基：`8f1f13ae`、`27b7a9b8`、`d8c0c432`、`726512b1`、`0fe04bec`；实现门修复 `b304e849`、`7bf9b4dc`。
- skill identity / fusion：`0bc7d558`、`562a368d`；四类 canonical URL、REST、wire 与前端：`e6f9bfa7`～`03f9cf86`。
- PR-8/9：migration `0118`、owner-scoped uniqueness、导入 mapping/OCC、ZIP/transfer fence、跨租户 backend + Playwright 对抗覆盖：`d2f367b9`～`b2653ffb`。
- 收口审计与竞态 fence：`53af6b94`、`b280d6b0`、`86532afc`、`b2a5a8d5`、`cc1a5bc8`、`1fe7de4a`。
- T15：精确 AST 指纹多重集护栏 `cb42f148`；真实 production 非法 sink 注入会 red，还原后 8/8 green。
- 夹具与验收收口：`1bf0478b`、`df0d9c47`、`bd5bd37b`、`c28541ab`、`fe1fba43`、`25b7dd02`、`c2cc4062`、`5221b066`、`39e72632`、`4eacb2a7`；其中 `39e72632` 补齐 AC16 两 owner 同名动态成员真实 generate→execute 证明。
- AC1–AC20 全部完成。最终本地门禁与共享 `main` 集成状态见 `HANDOFF.md`；本次接手未获授权推送远端。
