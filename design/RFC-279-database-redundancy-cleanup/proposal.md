# RFC-279 · 数据库冗余字段收口

状态：Done（2026-08-10；实现 `fa4fdcc3` 已进入 `main`，exact-SHA 主 CI run 31396152948 的 36 个 job 与 git-protocols-e2e run 31396155818 全部成功）

## 1. 背景

RFC-278 已把历史物理漂移收敛到 canonical replay，但不处理当前产品模型内的语义冗余。对当前 source、完整迁移链与 live SQLite 的只读交叉核对确认：以下七列不再承载独立产品事实，其中部分仍保留了已退役能力的兼容分支。

用户在 2026-08-10 明确要求先清理审计结论中的 P1，随后把范围扩为 P1 + P2。本 RFC 固定该边界，不顺手扩大到其它反规范化字段或表。

| 表                 | 删除列                       | 当前事实                                                              |
| ------------------ | ---------------------------- | --------------------------------------------------------------------- |
| `skills`           | `migration_marker`           | 生产零读写；`version_state` 已承担快照权威状态                        |
| `skills`           | `source_kind`                | RFC-178 后持久 skill 只可能是 managed；wire 仍可派生字面量            |
| `task_questions`   | `reopen_count`               | 从无生产写者；live 恒为 0                                             |
| `task_questions`   | `prior_answer_snapshot_json` | 从无生产读写；live 恒为 NULL                                          |
| `task_questions`   | `manual_title`               | 手工问题创建时与非空 `question_title` 写入同一值                      |
| `cached_repos`     | `url`                        | RFC-204 密封后恒为空；凭据权威为 `url_enc`，展示权威为 `url_redacted` |
| `skill_operations` | `next_skill_id`              | RFC-178 删除唯一双 ID `replace` op 后无生产者                         |

## 2. 目标

1. 通过一个 forward migration 物理删除上述七列，且 full replay 与存量升级形态一致。
2. 删除对应生产 fallback、过滤器和休眠分支，不把常量换个位置继续当数据库事实。
3. 保持 Skill、任务问题、手工问题 prompt、仓库列表与 skill operation 的现有产品行为。
4. 从任意旧 migration 前缀直接升级时，不静默丢失尚未经过 RFC-204 boot gate 的仓库 URL。
5. 对不满足既有不变量的异常行 fail closed，不在 migration 中猜测或丢弃审计数据。

## 3. 非目标

- 不删除 `skill_operation_locks`；它继续作为单 ID operation 的显式互斥面。
- 不处理 `task_repos.worktree_dir_name`、`tasks.*` repo0 mirrors、`repo_count`、`task_questions.question_title` 或 `node_runs.tok_total`。
- 不新增 RFC-120 的 reopen/打回能力。未来若重新设计该能力，必须以新 migration 定义新事实面。
- 不改变历史 migration SQL 或其测试；历史文档继续记录当时的 schema。
- 不清理 event payload 或调整 `node_run_events` 归档策略。

## 4. 能力影响清单

以下是实现前必须显式确认的全部能力影响：

1. **Skill API 不收缩**：`Skill.sourceKind` 继续返回 `'managed'`，但改为 mapper 派生，不再落库。
2. **任务问题 wire 不收缩**：`reopenCount` 暂继续返回常量 `0`，避免无版本 API 字段消失；数据库不再为尚未存在的 reopen 能力预留状态。
3. **无 SecretBox 的测试注入形态收紧**：生产 `agent-workflow start` 总会创建 SecretBox。仅测试或自定义嵌入若故意不注入 SecretBox，新建缓存仍可按 URL clone/reuse，但不会持久化可恢复明文；重启后仅凭 `cachedRepoId` 无法恢复原 URL，继续返回既有 `cached-repo-credential-unavailable`。这是删除明文 fallback 的必要结果。
4. **旧库直升不丢 URL**：migration 会把尚未密封的 `url` 暂存为带 closed prefix 的 hex payload 写入 `url_enc`，随后删除 `url` 列；同一次启动在任何业务服务前把该 payload 用 SecretBox 真正密封并写 `url_redacted`。若进程在两步之间崩溃，下次启动继续收敛；临时形态不比升级前的明文列扩大暴露面。
5. **休眠 reopen 数据 fail closed**：若现场出现 `reopen_count != 0` 或非 NULL `prior_answer_snapshot_json`，migration 拒绝而不是删除未知审计历史。
6. **双 ID operation 不恢复**：物理 CHECK 收窄为当前四 kind；若存在已退役 kind 或非 NULL `next_skill_id`，migration 拒绝。`skill_operation_locks` 本 RFC 保留。

## 5. 验收标准

- **AC-1** canonical schema 与 fresh replay 均不含七列，全物理准入通过。
- **AC-2** managed skill 的 list/detail/export/runtime 注入 wire 与删除前一致，源码不再查询 `skills.source_kind`。
- **AC-3** 任务问题响应仍返回 `reopenCount: 0`；手工问题标题、正文及 prompt 字节语义不变。
- **AC-4** 已密封 cached repo 升级后可按 URL、按 id、webhook 与 push credential path 正常使用；所有诊断只使用 `url_redacted`。
- **AC-5** 仅有 legacy plaintext URL 的旧库直升后，第一次 boot gate 将其密封；模拟 migration 后崩溃再启动同样收敛，凭据不丢失。
- **AC-6** 新缓存写入永不把原始 URL 写入 SQLite；无 SecretBox 时 `url_enc=NULL` 且 `url_redacted` 有值。
- **AC-7** skill operation 四 kind 的互斥、崩溃恢复与历史行保留行为不变；源码无 `nextSkillId`。
- **AC-8** migration 对 non-managed skill、休眠 reopen 数据、manual title 分歧、退役 op kind/second id 均 fail closed，并有反向测试。
- **AC-9** 定向测试、backend 全量、typecheck/lint/format/depcheck 与 `gate:local` 全绿。
