# RFC-371 v2 断代后的真实任务验证与修正（2026-10-14）

用户问「重构后之前的数据界面都不显示了，是数据丢失还是断代」，并要求新跑任务验证统计正确。

## 1. 结论：断代，不是丢失

- SQLite `0256_rfc371_observation_v2` 按 [v2 设计](./redesign-v2-20261014.md) §7、§9 退役 v1 的 81 张观测表，**不迁移**旧数据。本机在 2026-10-14 15:57（PDT）dev daemon 重启时执行该迁移。
- 业务事实（`tasks` / `node_runs` 等）不受影响，所以总览的任务计数照常，Token 从 v2 上线后才开始记。
- 迁移前的完整库由 `backupOnMigration` 自动备份为 `~/.agent-workflow/backups/pre-migration-1791953593843-1791988700180-…tar.gz`。
- v1 价格表里只有验收示例费率（`observation_price_versions` 两行，均注明“验收专用示例费率”），没有用户真实价格。
- 退役后的派生页进入空闲页：本机库 24.7 GB 中约 23 GB 空闲，可在「设置 → 数据库维护」或 `VACUUM` 回收。

## 2. 新任务验证

用 `dist/agent-workflow-macos-arm64`（含 v2）在本机正式数据目录起服务，验收价只配在验收运行时 `obs-native-20261007` × `opencode-go/deepseek-v4.1-flash`（2 / 0.5 / 3 / 8 元每百万 Token，备注写明不代表供应商价格）。

| 场景 | 任务 | 结果 |
| --- | --- | --- |
| 单节点 + 两个并行原生子 Agent | `01M4YDMDHGSZCWC0F4K8C9WNXR` | 会话树 3 个会话 / 4 个步骤，与原生库逐项一致 |
| 并行 / 串行工作流 | `01M4YDMDXMJ04RZKDQRVBWKNW5` / `01M4YDME7KY3HVP1RBQ9CJDHD0` | 一致 |
| 独立 Agent | `01M4YDMMN60HWBC2PWD0PZR68W` | 一致 |
| 运行中取消 | `01M4YDYX9XVDWMPA7KYYJSFDGK` | 运行中原地写 partial，取消后终态 canceled |
| daemon 被 `kill -9` 后重启 | `01M4YE554RW4QHH9P51DH1GF9E` | 开机修复把原调用标 interrupted（usage none），自动恢复产生新调用 |

27 次调用（14 次业务、13 次记忆提取）的输入 / 缓存读 / 缓存写 / 输出（含推理）/ 推理，逐条与 OpenCode 原生库（根会话沿 `parent_id` 递归、`step-finish` 且时间不早于调用开始）比对全部相等；已定价调用的人民币按费率逐条精确。总览、任务、Agent 与模型、系统执行四个接口的汇总等于库内求和；六个页面在 1440 / 390 宽度渲染、无横向溢出。

## 3. 发现的问题与修正

| # | 问题 | 修正 |
| --- | --- | --- |
| 1 | 通过旧 `memoryDistillModel` / `commitPushModel` 等设置运行的系统 Agent 没有运行时注册身份，`runtime_id` 为空，永远未定价，价格目录不可见；模型表把它显示成同名注册运行时 | 没有注册的调用按 `builtin:<protocol>` 落价格线键（受理时写入；历史空值读取时同样归并）；价格目录在出现调用或价格后列出“内置 &lt;协议&gt;”价格线，可像注册运行时一样定价；模型表、调用表显示“内置 opencode” |
| 2 | 同一任务在总览「Token 最多的任务」只算业务调用，任务页签与详情含其系统调用 | 总览按任务汇总不再过滤用途，与任务页签口径一致 |
| 3 | 外部取消 / 中断的调用若正处于一次请求中途，该请求的用量运行时不会记账，却仍标 complete | 终态为 canceled / interrupted 时把 complete 快照记为 partial（下界） |
| 4 | 任务详情的状态标签在纵向 flex 标题里被拉满整行 | 改用公共 `PageHeader`，状态进 meta 行 |
| 5 | 账号未配邮箱时启动任务返回 `500 internal-error` | 全局错误处理把 identity-access 的 `UserAccessError` 按类别映射为 422 / 409 / 403 / 404 并保留错误码 |

回归用例：`rfc371-v2-observation-store`（内置价格线、历史空值归并、下界终态、总览按任务口径）、`errors`（四类映射与伪造名不放行）、前端 `rfc371-v2-observation-format` / `rfc371-v2-run-observability` / `rfc371-v2-runtime-pricing`。

## 4. 已知限制

- interrupted 调用的用量为“运行时未报告”：daemon 崩溃时进程中途的用量无法从流里拿到，v2 不做原生补采（§9）。
- 本机 PostgreSQL 一侧以确切 SHA 的 CI 为准（并发会话的在制 schema 改动使本机 PG 迁移历史校验无法通过）。
