# RFC-223 实现交接（HANDOFF）

> 面向接手的贡献者。RFC-223「多租户资源标识：放开 name 全局唯一为 `(owner_user_id,name)` 复合唯一 + id 规范化」。设计三件套（`proposal/design/plan`）已过 **9 轮 Codex 设计门（approve）**；本文件记录**实现进度、欠账、阻塞与接手步骤**。所有内容以本仓 git 为准。

## 一句话状态（2026-07-23）

**核心地基与 runtime 边界已交付（PR-1/2/3a/3b/6 + 两轮实现门修复），deferred 0115 也已恢复并本地提交：全资源引用/冻结快照/动态 token 已按 id 解析，R4-1/ABA 与 managed 注入同名失败边界已闭。剩余落库顺序经 live-code 审计校正为 `PR-5 → PR-4 → PR-7 → PR-8 → PR-9`。PR-8 仍是真正的「唯一性翻转」开关；该开关未打前，`name` 仍全局唯一，「不同用户可建同名资源」尚未生效。**

## 已交付（committed + pushed origin/main，均 CI 绿）

| PR                        | commit     | 内容                                                                                                                                                                                                                            |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设计三件套 + RFC-224 拆分 | `11954305` | 9 轮设计门；opencode 执行身份完整性拆出 [RFC-224]（`../RFC-224-opencode-execution-identity/`）                                                                                                                                  |
| PR-1                      | `8f1f13ae` | `agents.mcp/plugins/dependsOn`→id；`agents.skills`→`AgentSkillRef` 判别联合（managed{skillId}/project{name}，保 RFC-178 repo-local）；resolver 按 id；mig `0111`                                                                |
| PR-1 实现门修             | `b304e849` | **selector↔ref 分离**（缺失 managed 不降级 project）；**ACL 绑定解析 id 消 name-ABA 授权绕过**（新 `resolveRefsUsableById`）；closure 出站 id→name 展示；不泄 private 资源 name；顺修 workgroup 同款 ABA。13 例回归             |
| PR-2                      | `27b7a9b8` | workflow 节点 `agentId`；`workgroup_members.agent_id`；scheduled payload id；scheduler 运行期严格 by-id（ABA-safe）；mig `0112`                                                                                                 |
| PR-3a                     | `d8c0c432` | 冻结快照 id + **全消费者矩阵按 id**；**R4-1 哨兵 quarantine**（`QUARANTINED_SNAPSHOT_AGENT_ID`，`getAgentById→null→fail-closed`）；`source_agent_id` 删改/提交前守卫按 id；mig `0113`                                           |
| PR-3b                     | `726512b1` | **动态 workflow opaque token**（LLM 只见 `member#N`；`resolvePool` 按冻结 id；单点 `dwGeneratedToWorkflowDef` 转换；R4-2/R5-2 身份收窄——仅框架字段 token 化，自由文本不脱敏）；无迁移                                           |
| PR-3a 实现门修（代码）    | `7bf9b4dc` | 修 6 findings（**2 Critical fail-open**）。核心原则 = **id 存在时严格 by-id、砍 name 兜底**：终态/dynamic fail-closed、蒸馏遇哨兵跳过、fanout 按 `fanoutInnerAgentKey(agentId??name)`、`resolveNodeAgent` 严格 id、room 严格 id |
| 保全暂缓迁移              | `e05856e3` | `deferred-pr3a-migration/`（见下）                                                                                                                                                                                              |
| PR-6                      | `0fe04bec` | 双 runtime 共用 hydration seam 的 managed 注入同名硬失败；project skill/disabled MCP 边界；plugin 按 id 去重；清除 `OPENCODE_PERMISSION`；合法 prototype-shaped registry key 不再被吞                                           |

两轮 Codex 实现门（PR-1 找 2P1+2P2；PR-3a 找 2C+3H+1M）findings 全部修闭。

## 本地已提交、待随 main 推送

| 批次          | commit     | 内容                                                                                                                                          |
| ------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| deferred 0115 | `caf52127` | 终态 single-agent/workflow/workgroup 与历史 dynamic DAG 的 R4-1 quarantine 回填；可信 `source_agent_id` 保留，其他 name-only 身份 fail-closed |

## 欠账 / 待办（接手要做的）

### 0. deferred 0115（PR-3a-fix 配套）已恢复

- RFC-225 `0114` 已以 `2b3fcf58` 独立落地；RFC-223 随后用 `caf52127` 单独恢复 `0115`。
- SQL/test 与 `deferred-pr3a-migration/` 保全副本逐字节一致。
- 门禁：migration + rolling 16/16；backend 6738 pass / 23 skip / 0 fail；typecheck/lint/format/build:binary 全绿。

### 1~5. 剩余 PR（按真实依赖排序）

- **PR-5（下一步，migration 0116）** skill 磁盘迁移状态机 `runSkillIdentityMigrationBarrier`（`skills/{name}→{id}`、`skill_operations(kind='migrate')`、fail-closed 屏障、旧备份 forward-restore）。
- **PR-4** provenance + fusion 全生命周期（`fusions.skill_id`/`memories.fused_into_skill_id`，launch/decision/restore/前端全按 skillId）+ 内建 seeder（builtin+system+稳定 id）。**需迁移**。
- **PR-7** URL/API/前端**四类** `:name→:id` + workgroup member/scheduled/task-wizard 写侧直接提交 id；必须在 PR-5/4 后集成，fusion detail 使用 PR-4 的 `skillId`。
- **PR-8 ⭐** **唯一性翻转**：`COALESCE(owner_user_id,'')`,name 表达式唯一索引（五类）+ owner backfill `__system__` + workflows 例外 + 判重带 owner + 导入多候选 preview/mapping + owner transfer `OWNER_NAME_UNIQUE_TYPES` 预检 409 + skill ZIP owner 作用域 + **四类结构守卫（AST/语义，变异实证）**。**需迁移；必须最后**（前置全部 id 化就位后才翻转）。
- **PR-9** 跨租户对抗测试套件。

## 🚧 当前阻塞根因

迁移号阻塞已解除。当前风险改为**依赖顺序**：PR-7 若早于 PR-5 集成，skill id URL 仍会在 service/FS 二次按 name 解析，保留 rename/delete→同名重建 ABA；PR-4 若早于 PR-5，则无法证明同名 skill 的完整 fusion 文件生命周期。必须保持 `PR-5 → PR-4 → PR-7`，PR-8 最后。

## 接手步骤

1. 读 `design/RFC-223-*/{proposal,design,plan}.md`（design §4.1/§4.2/§8 是全链 id 化 + R4-1 权威；plan 是 9-PR 拆分与 AC）。
2. 读本文件 + `git log --oneline` 核实上表 shas。
3. 核对 `caf52127` 已随 main 推送，再从 migration `0116` 实现 PR-5。
4. 严格按 `PR-5 → PR-4 → PR-7 → PR-8 → PR-9`；PR-7 的隔离实现只能作为后续移植基线，不可提前合入。
5. 每 PR：`typecheck && lint && test && format:check` 全绿；迁移 PR 额外全量 backend `bun test` + `build:binary`；push 后按**自己的 sha** 查 CI（shared ref：并发 push 会取消我的 run，看含我 commit 的 superseding commit 的绿）；跑 Codex 实现门修 findings。

## 关键模式与坑（务必沿用/避开）

- **ACL 绑定**：涉及按名解析资源的权限检查，一律用 `resolveRefsUsableById`（一次解析 id + 判权、绑定同 id），**不要**「route 查 name→ACL、service 再独立解析」的两步（= name ABA 授权绕过）。
- **R4-1 fail-closed**：冻结快照/成员**有 id（含哨兵）时严格 by-id、绝不 name 兜底**；哨兵 `QUARANTINED_SNAPSHOT_AGENT_ID` 解析为 null 即拒。name 兜底是漏洞根源（PR-3a 实现门 2 Critical 皆因此）。
- **迁移**：纯数据 backfill 用 `json_group_array(... ORDER BY key)` + LEFT JOIN；`--> statement-breakpoint`（精确，仓库迁移器只认这个）；`_journal.json` `when` 接合成轴（上条 +86400000）、idx 递增；表达式唯一索引用 `PRAGMA index_list/index_xinfo` 验证（非 `table_info`）；每加迁移 bump `upgrade-rolling.test.ts` 计数。
- **多人共享树**：只提交自己的文件（**显式正向 pathspec**，别 `git add packages/`——RFC-225 污染面很大）；`git commit -- <paths>` 一步（避 add→commit 竞态）；**绝不 `--amend`**；不碰他人 untracked 文件。
- **CI flaky**：`centralized-answer-pane.test.tsx` 的 cross-round keyboard digit-key 是**已知 macOS flaky**（ubuntu 同 shard 绿即判 flaky，`gh run rerun --failed`）；`skills-split-page` 的 escaped-mocks 亦 flaky。别当真红。
- **唯一性未翻转前 name↔id 仍 1:1**：前置 PR 的 backfill 确定性来自这个前提；PR-8 翻转是**唯一**行为变更。
