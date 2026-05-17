# Agent Workflow 平台 —— 技术设计

> 与 [`proposal.md`](./proposal.md)（产品规格）配套。本文聚焦实现层。

---

## 1、总体架构

```
┌────────────────────────────────────────────────────────┐
│ Browser (Vite + React 19 + TanStack Router            │
│  + TanStack Query + xyflow v12 + shadcn/Base UI)      │
│  - workflow editor / task status view / detail drawer  │
│  - i18next (zh-CN default) / system theme              │
└────────────────────────────────────────────────────────┘
            ▲ HTTP (Bearer token) / WebSocket (?token=)
            │
┌────────────────────────────────────────────────────────┐
│ Local Daemon (Bun + TypeScript, single process)        │
│ ┌────────────────────────────────────────────────────┐ │
│ │ HTTP API (Hono)  │  WS 推送 (Bun built-in WS)      │ │
│ ├────────────────────────────────────────────────────┤ │
│ │ Workflow Engine                                     │ │
│ │  - DAG scheduler + loop expansion + fan-out         │ │
│ │  - 全局 semaphore (max_concurrent_nodes)             │ │
│ │  - 写入 semaphore (per-task, capacity 1)             │ │
│ │  - 子进程独立并发池 (multi-process node 内部)        │ │
│ ├────────────────────────────────────────────────────┤ │
│ │ Process Manager (spawn / monitor opencode)         │ │
│ ├────────────────────────────────────────────────────┤ │
│ │ Git Helper (worktree / diff / split / snapshot)    │ │
│ ├────────────────────────────────────────────────────┤ │
│ │ Storage (Drizzle ORM + bun:sqlite + filesystem)    │ │
│ ├────────────────────────────────────────────────────┤ │
│ │ Background jobs                                     │ │
│ │  - hourly: events 表归档到 jsonl                     │ │
│ │  - hourly: worktree GC (可选)                        │ │
│ │  - on-tick: 资源限额检查（耗时/token）              │ │
│ └────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
            │ spawn (per node run)
            ▼
┌────────────────────────────────────────────────────────┐
│ opencode subprocess                                     │
│  cwd: task worktree (~/.agent-workflow/worktrees/...)  │
│  env (覆写): OPENCODE_CONFIG_DIR / OPENCODE_CONFIG_CONTENT │
│  env (继承): 全量 daemon process.env (PATH/HOME/auth) │
│  argv: opencode run "<userPrompt>" --agent <name>      │
│        --format json --dangerously-skip-permissions    │
└────────────────────────────────────────────────────────┘
```

进程模型：**单 daemon 进程**，常驻；浏览器是普通 SPA 客户端。所有 opencode 子进程由 daemon spawn / 监控 / 收尾。

**单实例锁**：daemon 启动时拿 `~/.agent-workflow/.daemon.lock`（POSIX flock）。已被占则报错退出并打印现有 PID + 端口 URL。

---

## 2、应用目录布局

所有持久化内容在 `~/.agent-workflow/`：

```
~/.agent-workflow/
├── db.sqlite                              # 主数据库（agents / workflows / tasks / events 等）
├── db.sqlite-wal                          # WAL（运行时存在）
├── db.sqlite-shm                          # shared memory
├── .daemon.lock                           # 单实例 flock
├── .daemon.pid                            # 当前 daemon PID（可选辅助文件）
├── config.json                            # 全局配置（opencode 路径、限额、网络等；含 $schema_version）
├── token                                  # 32 字节 token（chmod 600）
├── skills/
│   └── {name}/
│       └── files/                         # SKILL.md + 支撑文件，全部在 fs
│           ├── SKILL.md
│           ├── templates/...
│           └── scripts/...
├── workflows/
│   └── {workflow-id}.yaml                 # YAML 导出形态（手动导出 / 备份产物，非真值源）
├── worktrees/
│   └── {repo-slug}/
│       └── {task-id}/                     # 每个 task 的 git worktree（保留至手动删）
├── runs/
│   └── {task-id}/
│       └── {node-run-id}/
│           └── .opencode/                 # 每个 node run 的私有 OPENCODE_CONFIG_DIR
│               └── skills/{name}/         # managed skill copyDir / external skill symlink
├── snapshots/
│   └── {task-id}/
│       └── {node-run-id}.snapshot         # 节点 start 前的 git stash create 哈希（用于 retry rollback）
├── logs/
│   ├── daemon.log                         # 当前 daemon 日志
│   ├── daemon-{date}.log.gz               # rotated 历史 (10MB × 5 份)
│   └── {task-id}/
│       └── {node-run-id}.jsonl            # 归档后的 events 流（DB 删除后落到这里）
└── backups/
    └── {date}.tar.gz                      # 用户触发的备份产物
```

注意 **agent 不在文件系统**：agent.md frontmatter 拆字段存 DB 列，正文 markdown 也存 DB。文件系统仅在每次启动 opencode 子进程时通过 `OPENCODE_CONFIG_CONTENT` 把 agent 以 inline JSON 形式注入。

**Skill 在文件系统**：完整目录结构（含支撑文件）保留 opencode 原生格式。DB 仅维护 `name → managed_path` / `name → external_path` 索引。

`runs/{task-id}/{node-run-id}/` 在子进程结束后立即清理；其余目录持久。

`worktrees/{repo-slug}/{task-id}/` 默认保留，UI 提供一键删除；可选 GC（settings 配 `worktreeAutoGc.olderThanDays` / `onlyMerged`，默认关闭）。`{repo-slug}` 是仓绝对路径的 `sha1`(8 位) + `basename`，避免路径冲突。

`snapshots/` 保存每个写入节点 start 前的 git stash hash；retry / resume 时用于 worktree 回滚。一个 task 删除后整个目录清掉。

---

## 3、数据模型（SQLite DDL）

> 所有 schema 通过 **drizzle-kit** 生成 migration（`packages/backend/db/migrations/`）。Daemon 启动时读取 `__drizzle_migrations` 表自动 apply 未跑过的迁移。

```sql
-- agents：DB 是真值源；frontmatter 拆字段 + 正文 markdown 列
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,         -- ULID
  name            TEXT UNIQUE NOT NULL,     -- URL 标识 (/agents/{name})
  description     TEXT NOT NULL DEFAULT '',
  outputs         TEXT NOT NULL DEFAULT '[]', -- JSON string[] of port names
  readonly        INTEGER NOT NULL DEFAULT 0, -- 0/1
  model           TEXT,                     -- nullable，缺省走 settings 默认
  variant         TEXT,
  temperature     REAL,
  permission      TEXT NOT NULL DEFAULT '{}', -- JSON: opencode permission schema
  steps           INTEGER,
  max_steps       INTEGER,
  skills          TEXT NOT NULL DEFAULT '[]', -- JSON string[]
  frontmatter_extra TEXT NOT NULL DEFAULT '{}', -- 高级字段（透传） JSON
  body_md         TEXT NOT NULL DEFAULT '', -- system prompt 正文，可空
  schema_version  INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- skills：fs 是真值源；DB 仅维护索引
CREATE TABLE skills (
  id              TEXT PRIMARY KEY,         -- ULID
  name            TEXT UNIQUE NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  source_kind     TEXT NOT NULL,            -- 'managed' | 'external'
  managed_path    TEXT,                     -- 'skills/{name}/files/' 相对 app dir
  external_path   TEXT,                     -- 绝对路径
  schema_version  INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- workflow definition
CREATE TABLE workflows (
  id              TEXT PRIMARY KEY,         -- ULID
  name            TEXT NOT NULL,            -- 不要求唯一（导入冲突时用户决定）
  description     TEXT NOT NULL DEFAULT '',
  definition      TEXT NOT NULL,            -- JSON: { $schema_version, nodes, edges, inputs, outputs }
  version         INTEGER NOT NULL DEFAULT 1, -- 自增（每次 PUT 加 1）
  schema_version  INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- 仓最近使用列表（缓存非登记）
CREATE TABLE recent_repos (
  path            TEXT PRIMARY KEY,         -- 绝对路径
  last_used_at    INTEGER NOT NULL,
  default_branch  TEXT                      -- 上次使用时探测到的默认分支
);

-- task instance
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,         -- ULID
  workflow_id       TEXT NOT NULL,
  workflow_snapshot TEXT NOT NULL,            -- 启动时刻 workflow 完整 JSON
  repo_path         TEXT NOT NULL,
  worktree_path     TEXT NOT NULL,
  base_branch       TEXT NOT NULL,            -- 用户在启动表单选的 base
  branch            TEXT NOT NULL,            -- 'agent-workflow/{task-id}'
  status            TEXT NOT NULL,            -- pending|running|done|failed|canceled|interrupted|awaiting_review|awaiting_human
  inputs            TEXT NOT NULL,            -- JSON: 启动表单值
  -- 人审：每次 review 决策 (approve/reject/iterate) 单调 +1。WS 与 REST 用作乐观锁（防多 tab 抢决）
  review_iteration  INTEGER NOT NULL DEFAULT 0,
  -- 资源限额（启动时拷贝 settings 默认 / workflow 覆写 / 启动表单覆写）
  max_duration_ms   INTEGER,                  -- per-task 总耗时上限
  max_total_tokens  INTEGER,                  -- per-task 累计 token 上限
  -- 时间
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  -- 失败诊断
  error_summary     TEXT,                     -- 顶部错误条短文本
  error_message     TEXT,                     -- 详细
  failed_node_id    TEXT,                     -- 触发失败的节点
  -- 软删 / 过期（用户启动时可设过期，到期 daemon 后台软删）
  expires_at        INTEGER,
  deleted_at        INTEGER,
  schema_version    INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);
CREATE INDEX idx_tasks_status ON tasks(status, started_at);
CREATE INDEX idx_tasks_workflow ON tasks(workflow_id, started_at);

-- 一次"节点的一次执行"。多进程节点的每个子进程是独立 node_run，挂同一个 parent_node_run_id；
-- loop wrapper 的每轮迭代里每个内层节点也是独立 node_run，按 iteration 编号；
-- 节点的 retries 也产生独立 node_run，按 retry_index 编号。
CREATE TABLE node_runs (
  id                TEXT PRIMARY KEY,         -- ULID
  task_id           TEXT NOT NULL,
  node_id           TEXT NOT NULL,            -- workflow definition 内的节点 id
  parent_node_run_id TEXT,                    -- multi-process fan-out 父 / loop iteration 父
  iteration         INTEGER NOT NULL DEFAULT 0, -- loop 迭代号
  shard_key         TEXT,                     -- multi-process shard 标识（如文件名）
  retry_index       INTEGER NOT NULL DEFAULT 0, -- 第几次重试（0 = 首次）
  -- RFC-023: clarify-driven rerun counter; orthogonal to retry_index (process
  -- retries) and review_iteration (review-driven). For an agent-multi shard
  -- child this counts that shard alone.
  clarify_iteration INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,            -- pending|running|done|failed|canceled|interrupted|skipped|exhausted|awaiting_review|awaiting_human
  started_at        INTEGER,
  finished_at       INTEGER,
  pid               INTEGER,
  exit_code         INTEGER,
  error_message     TEXT,
  prompt_text       TEXT,                     -- 实际 user prompt（详情页用）
  -- token 拆细
  tok_input         INTEGER,
  tok_output        INTEGER,
  tok_cache_create  INTEGER,
  tok_cache_read    INTEGER,
  tok_total         INTEGER,                  -- 等于上四项之和（冗余便于求和）
  -- worktree 快照（仅写入节点写）
  pre_snapshot      TEXT,                     -- git stash hash，retry 前回滚到此
  -- RFC-026: opencode session id captured from this run's --format json
  -- event stream. NULL when the run never spawned opencode (clarify /
  -- review / input / output / wrapper) or when the process exited before
  -- emitting any session event. Read by the scheduler ONLY on the
  -- clarify-driven rerun path when the upstream clarify node has
  -- sessionMode='inline' (see §7.4 below) — that path forwards the id via
  -- `--session <id>` so opencode resumes the prior session.
  opencode_session_id TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX idx_node_runs_task ON node_runs(task_id, node_id, iteration, retry_index);
CREATE INDEX idx_node_runs_parent ON node_runs(parent_node_run_id);

CREATE TABLE node_run_outputs (
  node_run_id       TEXT NOT NULL,
  port_name         TEXT NOT NULL,
  content           TEXT NOT NULL,
  PRIMARY KEY (node_run_id, port_name),
  FOREIGN KEY (node_run_id) REFERENCES node_runs(id) ON DELETE CASCADE
);

-- opencode --format json 的事件流持久化；同时 daemon tail 流推 WS。
-- 超过阈值后由后台任务归档到 logs/{task}/{node-run}.jsonl 然后从表删除。
CREATE TABLE node_run_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT, -- 自增，作 WS reconnect 的 since-id
  node_run_id     TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  kind            TEXT NOT NULL,             -- 'tool_use' | 'text' | 'reasoning' | 'permission_asked' | 'error' | 'step_start' | 'step_finish' | 'stderr'
  payload         TEXT NOT NULL,             -- 原始 JSON 行 / stderr 行
  FOREIGN KEY (node_run_id) REFERENCES node_runs(id) ON DELETE CASCADE
);
CREATE INDEX idx_events_node ON node_run_events(node_run_id, id);

-- 人审节点（RFC-005）：每次决策快照一份 markdown
CREATE TABLE doc_versions (
  id              TEXT PRIMARY KEY,           -- ULID
  task_id         TEXT NOT NULL,
  node_id         TEXT NOT NULL,              -- review 节点 id
  iteration       INTEGER NOT NULL,           -- review_iteration at time of capture（0=首次 dispatch；reject/iterate 每次回填后 +1 再 capture）
  body_md         TEXT NOT NULL,              -- 上游 markdown port / markdown_file 解析后的全文（一次性快照）
  source_ref      TEXT,                       -- 'inline' | 'file:relative/path.md'
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX idx_doc_versions_review ON doc_versions(task_id, node_id, iteration);

-- 人审评论（RFC-005）
CREATE TABLE review_comments (
  id              TEXT PRIMARY KEY,           -- ULID
  doc_version_id  TEXT NOT NULL,
  author          TEXT NOT NULL,              -- 现阶段恒为 'user'；多用户预留
  body_md         TEXT NOT NULL,              -- 评论正文（GFM）
  anchor          TEXT NOT NULL,              -- JSON: { sectionPath, paragraphIdx, startOffset, endOffset, selectedText, contextBefore, contextAfter, occurrenceIndex }
  resolved        INTEGER NOT NULL DEFAULT 0, -- 0/1
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (doc_version_id) REFERENCES doc_versions(id) ON DELETE CASCADE
);
CREATE INDEX idx_review_comments_doc ON review_comments(doc_version_id);

-- 反问澄清（RFC-023）：agent 主动反问的每一次会话。
-- agent-multi 下每个反问 shard 各自 mint 一条独立 clarify_sessions 行 +
-- 一条独立 clarify-node node_run，按 (clarify_node_id, source_shard_key) 分组。
CREATE TABLE clarify_sessions (
  id                          TEXT PRIMARY KEY,             -- ULID
  task_id                     TEXT NOT NULL,
  source_agent_node_id        TEXT NOT NULL,                -- 提问 agent 的 workflow 节点 id
  source_agent_node_run_id    TEXT NOT NULL,                -- agent-single 时是单一 node_run；agent-multi 时是 shard 子 node_run
  source_shard_key            TEXT,                         -- shard_key when agent-multi child; NULL 表示 agent-single
  clarify_node_id             TEXT NOT NULL,                -- clarify 节点 workflow id
  clarify_node_run_id         TEXT NOT NULL,                -- clarify 节点的 node_run id（agent-multi 时每个反问 shard 一条）
  iteration_index             INTEGER NOT NULL,             -- 与 node_runs.clarify_iteration AT TIME OF ASKING 同
  questions_json              TEXT NOT NULL,                -- JSON: ClarifyQuestion[]
  answers_json                TEXT,                         -- JSON: ClarifyAnswer[]；提交前 NULL
  status                      TEXT NOT NULL DEFAULT 'awaiting_human', -- awaiting_human | answered | canceled
  truncation_warnings_json    TEXT,                         -- JSON: {code,detail}[]；agent 超额时记录
  created_at                  INTEGER NOT NULL,
  answered_at                 INTEGER,
  answered_by                 TEXT,                         -- v1 恒为 'local'，多用户预留
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX idx_clarify_sessions_task        ON clarify_sessions(task_id);
CREATE INDEX idx_clarify_sessions_clarify_run ON clarify_sessions(clarify_node_run_id, iteration_index);
CREATE INDEX idx_clarify_sessions_source_run  ON clarify_sessions(source_agent_node_run_id);
CREATE INDEX idx_clarify_sessions_node_shard  ON clarify_sessions(clarify_node_id, source_shard_key);

-- drizzle 自维护
-- CREATE TABLE __drizzle_migrations (...)
```

> events 与 outputs 之所以分两表：events 是高频追加；outputs 是节点结束时一次性 upsert。两者读路径不一样。
>
> 大文本（diff / 单行超长 stdout）超过 `largeOutputThresholdBytes`（默认 1MB）的部分写入 `logs/{task}/{node}.jsonl`，DB 内仅保留指针 (`@file://logs/...:offset:length`)。阈值在 config 中可调。

---

## 4、API 设计

### 4.1 鉴权

- 所有 REST 与 WS 请求必须携带 token：
  - REST：`Authorization: Bearer {token}` 或 query `?token=...`
  - WS：连接时 query `?token=...`
- token 在 daemon 启动时生成 32 字节 hex（`crypto.randomBytes(32).toString('hex')`），写到 `~/.agent-workflow/token`（chmod 600）
- daemon stdout 启动时打印一次 `http://127.0.0.1:{port}/?token=...`（用户复制到浏览器；浏览器收到后存 localStorage，后续 API 自带）
- Settings 提供"重生 token"按钮 + CLI `agent-workflow config rotate-token`

### 4.2 REST（Hono）

约定：所有路径前缀 `/api`。请求体 JSON。响应统一 `{ ok, ... }` 包装。

#### 4.2.1 错误响应统一 schema

```ts
type ErrorResp = {
  ok: false
  code: string // kebab-case enum，例：'agent-not-found' | 'workflow-validation-failed'
  message: string // human readable，可 i18n
  details?: unknown // 字段级错误等
}
```

HTTP status 也准确（4xx/5xx）。前端根据 `code` 决定 i18n key 与处理逻辑。

#### 4.2.2 endpoint 列表

| Method | Path                                                                  | 说明                                                                                                   |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------- |
| GET    | `/health`                                                             | `{ ok, opencodeVersion, dbVersion, uptime, runningTasks }`                                             |
| GET    | `/config`                                                             | 全局配置                                                                                               |
| PUT    | `/config`                                                             | 更新全局配置（部分热生效，bind/lock 重启后生效，UI 标注）                                              |
| POST   | `/config/rotate-token`                                                | 重生 token（返回新 token）                                                                             |
| GET    | `/models/refresh`                                                     | 重新跑 `opencode models` 缓存模型列表                                                                  |
| GET    | `/agents` / `/agents/{name}`                                          | 列表 / 详情                                                                                            |
| POST   | `/agents`                                                             | 创建：body `{ name, description, outputs, readonly, model?, ..., body_md }`                            |
| PUT    | `/agents/{name}`                                                      | 更新（同上）                                                                                           |
| DELETE | `/agents/{name}`                                                      | hard delete（被引用拒绝，code=`agent-in-use`，details 列出引用 workflow）                              |
| POST   | `/agents/{name}/rename`                                               | 重命名（被引用拒绝）                                                                                   |
| GET    | `/skills` / `/skills/{name}`                                          | 列表 / 详情（详情含 file tree）                                                                        |
| POST   | `/skills`                                                             | 创建 managed skill（body 可选 frontmatter + body）                                                     |
| POST   | `/skills/import-external`                                             | 注册外部路径 skill                                                                                     |
| PUT    | `/skills/{name}`                                                      | 更新 SKILL.md / frontmatter                                                                            |
| GET    | `/skills/{name}/files/*`                                              | 读支撑文件                                                                                             |
| PUT    | `/skills/{name}/files/*`                                              | 写支撑文件（含上传）                                                                                   |
| DELETE | `/skills/{name}/files/*`                                              | 删支撑文件                                                                                             |
| DELETE | `/skills/{name}`                                                      | hard delete（被 agent 引用拒绝）                                                                       |
| GET    | `/workflows` / `/workflows/{id}`                                      | 列表 / 详情（id = ULID）                                                                               |
| POST   | `/workflows`                                                          | 创建                                                                                                   |
| PUT    | `/workflows/{id}`                                                     | 更新（version+1）                                                                                      |
| DELETE | `/workflows/{id}`                                                     | hard delete（被运行中 task 引用拒绝）                                                                  |
| POST   | `/workflows/{id}/import`                                              | YAML body 导入；冲突时返回 `code=workflow-import-conflict` + details 让前端弹窗                        |
| GET    | `/workflows/{id}/export`                                              | 导出 YAML                                                                                              |
| POST   | `/workflows/{id}/validate`                                            | 静态校验（5 项），返回错误列表                                                                         |
| GET    | `/repos/recent`                                                       | 最近用过的仓 + default_branch                                                                          |
| GET    | `/repos/refs?path=...`                                                | 给定仓路径返回 ref 列表（branches/tags/commits 最近 N 个）                                             |
| GET    | `/repos/files?path=...`                                               | 给定仓 + 路径返回当前 worktree 下文件树（启动表单文件选择器用）                                        |
| POST   | `/tasks`                                                              | 启动 task：body `{ workflow_id, repo_path, base_branch, inputs, max_duration_ms?, max_total_tokens? }` |
| GET    | `/tasks`                                                              | 列表 + 筛选（status / repo_path / workflow_id / since / until / sort）                                 |
| GET    | `/tasks/{id}`                                                         | 详情（含 nodes 状态摘要 + 错误概述 + 输出节点 ports）                                                  |
| GET    | `/tasks/{id}/diff`                                                    | 当前 worktree 的 git diff（diff2html 用）                                                              |
| POST   | `/tasks/{id}/cancel`                                                  | 取消                                                                                                   |
| POST   | `/tasks/{id}/resume`                                                  | 从 failed/interrupted 节点恢复                                                                         |
| POST   | `/tasks/{id}/retry`                                                   | 用同输入新建一个全新 task                                                                              |
| POST   | `/tasks/{id}/nodes/{nodeRunId}/retry`                                 | 单节点重跑（query `?cascade=true                                                                       | false`，默认 true） |
| GET    | `/tasks/{id}/nodes/{nodeRunId}`                                       | 节点详情：prompt_text / outputs / token_usage / status / retries history / shards                      |
| GET    | `/tasks/{id}/nodes/{nodeRunId}/events?since={id}&kinds=...&limit=...` | 事件分页 + kind 过滤                                                                                   |
| GET    | `/tasks/{id}/nodes/{nodeRunId}/stdout`                                | Raw stdout 拼接（用于 Events tab 的 Raw 视图）                                                         |
| DELETE | `/tasks/{id}/worktree`                                                | 删除该 task 的 worktree（不删 task）                                                                   |
| DELETE | `/tasks/{id}`                                                         | 彻底删除（task + node_runs + events + outputs + worktree + snapshots）                                 |
| POST   | `/backup`                                                             | 触发备份（返回生成的 .tar.gz 路径）                                                                    |

### 4.3 WebSocket 频道

所有 WS 需 `?token=...`。三个频道：

#### `/ws/tasks/{taskId}` —— 单 task 详情页

```ts
type TaskWsMessage =
  | { id: number; type: 'task.status'; status: TaskStatus; errorSummary?: string }
  | {
      id: number
      type: 'node.status'
      nodeRunId: string
      nodeId: string
      status: NodeStatus
      iteration?: number
      retryIndex?: number
      shardKey?: string
    }
  | {
      id: number
      type: 'node.event'
      nodeRunId: string
      ts: number
      kind: EventKind
      payload: unknown
    }
  | { id: number; type: 'node.output'; nodeRunId: string; portName: string; content: string }
  | { id: number; type: 'task.done'; status: 'done' | 'failed' | 'canceled' | 'interrupted' }
  // —— 人审（RFC-005） ——
  | {
      id: number
      type: 'review.awaiting'
      nodeId: string
      docVersionId: string
      reviewIteration: number
    }
  | {
      id: number
      type: 'review.comment.added'
      nodeId: string
      docVersionId: string
      commentId: string
    }
  | {
      id: number
      type: 'review.comment.resolved'
      nodeId: string
      docVersionId: string
      commentId: string
      resolved: boolean
    }
  | {
      id: number
      type: 'review.decision'
      nodeId: string
      decision: 'approve' | 'reject' | 'iterate'
      reviewIteration: number
    }
  // —— 反问澄清（RFC-023） ——
  | {
      id: number
      type: 'clarify.created'
      nodeRunId: string         // clarify 节点 node_run id
      clarifyNodeId: string     // clarify 节点 workflow id
      sourceShardKey: string | null
      iterationIndex: number
      session: ClarifySessionSummary // 紧凑摘要 — 列表 / 徽标增量更新用
    }
  | {
      id: number
      type: 'clarify.answered'
      nodeRunId: string
      clarifyNodeId: string
      sourceShardKey: string | null
      iterationIndex: number
      rerunNodeRunId: string    // 新 mint 的 source agent node_run id；订阅方可切换焦点
      session: ClarifySession   // 完整 session（含 sealed answers + selectedOptionLabels）
    }
```

`id` = `node_run_events.id`（自增）。客户端断线重连用 `?since={lastSeenId}`，服务端从 events 表回放 id > since 的所有事件，再衔接实时推送。

clarify.* 与 review.* 复用同一 `/ws/tasks/{taskId}` 通道；前端 `/clarify` 列表与左栏 badge 走 polling + invalidate（10s + 15s），详情页订阅本通道直接拿增量。`sourceShardKey` 在 payload 上让前端把同 clarifyNodeId 的多 shard 会话路由到正确 tab。

#### `/ws/tasks` —— 任务列表页

```ts
type TasksListWsMessage =
  | { type: 'task.created'; task: TaskSummary }
  | { type: 'task.status'; taskId: string; status: TaskStatus }
  | { type: 'task.deleted'; taskId: string }
```

不带 since-id（列表不需要补订阅）。

#### `/ws/workflows` —— Workflow 列表 + 编辑器多 tab 同步

```ts
type WorkflowsWsMessage =
  | { type: 'workflow.created'; workflow: WorkflowSummary }
  | { type: 'workflow.updated'; workflowId: string; version: number; updatedAt: number }
  | { type: 'workflow.deleted'; workflowId: string }
```

编辑器收到 `workflow.updated` 且 `version > 当前` → toast "其他 tab 修改了 workflow，刷新"。

> **Agents / Skills 列表页不走 WS**：用 TanStack Query invalidate 即可（变更频率低，且 CRUD 后客户端可手动 invalidate）。

### 4.4 Frontend ↔ Backend 类型共享

`packages/shared/` 放 Zod schema + 派生 TypeScript 类型，前后端共享。后端 Hono 路由用 `@hono/zod-validator` 做请求体校验。前端 fetcher 用同一份 schema 做响应解析（防御 API 演进）。

---

## 5、Workflow 定义 JSON / YAML schema

### 5.1 顶层

```ts
type Workflow = {
  $schema_version: 1 | 2 | 3 // v2 (RFC-005) 引入 review；v3 (RFC-023) 引入 clarify。旧库自动迁移
  id: string // ULID
  name: string
  description?: string
  inputs: WorkflowInput[] // 启动表单字段
  nodes: Node[] // 含 wrapper（wrapper 是一种 node）
  edges: Edge[]
  outputs?: WorkflowOutput[] // 输出节点
  version: number // 自增（每次 PUT +1）
}

type WorkflowInput =
  | {
      kind: 'text'
      key: string
      label: string
      multiline?: boolean
      required?: boolean
      default?: string
      placeholder?: string
      maxLength?: number
    }
  | {
      kind: 'files'
      key: string
      label: string
      required?: boolean
      minCount?: number
      maxCount?: number
      pickerKind: 'file' | 'dir' | 'both'
    }
  | {
      kind: 'enum'
      key: string
      label: string
      required?: boolean
      multi?: boolean
      allowOther?: boolean
      options: { value: string; label: string }[]
    }
  | {
      kind: 'git'
      key: string
      label: string
      required?: boolean
      objectType: 'branch' | 'commit-range' | 'pr'
    }

type Node =
  | AgentNode
  | InputNode
  | OutputNode
  | WrapperGitNode
  | WrapperLoopNode
  | ReviewNode
  | ClarifyNode // RFC-023

type AgentNode = {
  id: string
  kind: 'agent-single' | 'agent-multi'
  agentName: string
  promptTemplate?: string // 支持 {{port_name}} + {{__repo_path__}} / {{__base_branch__}} / {{__task_id__}}
  overrides?: AgentOverrides
  retries?: number // 默认 0
  timeoutMs?: number // 默认沿用 settings.defaultPerNodeTimeoutMs
  position: XY
} & (
  | { kind: 'agent-single' }
  | {
      kind: 'agent-multi'
      shardingStrategy: ShardingStrategy
      sourcePort: { nodeId: string; portName: string }
    }
)

type InputNode = { id: string; kind: 'input'; inputKey: string; position: XY }
// Output 节点声明的 ports 用于 task 详情页"产出"面板展示。
type OutputNode = {
  id: string
  kind: 'output'
  ports: { name: string; bind: { nodeId: string; portName: string } }[]
  position: XY
}

// —— 人审节点（RFC-005） ——
// 接收上游一个 markdown port，暂停任务等待人工 approve / reject / iterate。
// 决策走 REST /api/reviews/:taskId/:nodeId/decision，框架根据 rerunNodeIds 重置下游节点。
type ReviewNode = {
  id: string
  kind: 'review'
  inputSource: { nodeId: string; portName: string } // 上游 markdown / markdown_file port
  inputKind: 'markdown' | 'markdown_file' // markdown_file: 解析 envelope 后从 worktree 读文件
  // approve 时：output = body_md 原文
  // reject:    output = {{__review_rejection__}}（review_outcome port = 'reject'）
  // iterate:   output = {{__review_comments__}}（review_outcome port = 'iterate'，iterate_target_port 指 doc port）
  outputs: { docPort: string; reviewOutcomePort: string }
  rerunOnReject?: string[] // 决策 = reject 时，需要重置 (pending) 的下游节点 id 列表
  rerunOnIterate?: string[] // 决策 = iterate 时，同上；iterate_target_port 写到 prompt 模板
  iterateTargetPort?: string // 用于 {{__iterate_target_port__}} 模板替换
  position: XY
}

// —— 反问澄清节点（RFC-023） ——
// 不主动调度；由上游 agent 通过 <workflow-clarify> 协议触发。系统通过两条
// 由反向拖动注入的边把它与提问 agent 关联：
//   agent.__clarify__         → clarify.questions       （问题通道）
//   clarify.answers           → agent.__clarify_response__（视觉环；运行期靠
//                                                          clarify_sessions 行 + prompt
//                                                          context 注入，不走该边）
// 端口是硬编码（'questions' / 'answers'），不可改；user 仅可编辑 title /
// description。validator 拒绝接到非 agent-{single,multi} 的对端。
type ClarifyNode = {
  id: string
  kind: 'clarify'
  title?: string
  description?: string
  assignee?: string // 预留；v1 UI 不暴露
  position: XY
}

type WrapperGitNode = { id: string; kind: 'wrapper-git'; nodeIds: string[]; position: XY; size: WH }
type WrapperLoopNode = {
  id: string
  kind: 'wrapper-loop'
  nodeIds: string[]
  maxIterations: number // 必填，UI 默认 3
  exitCondition: ExitCondition // 必填
  outputBindings?: { name: string; bind: { nodeId: string; portName: string } }[] // wrapper 边界输出端口
  position: XY
  size: WH
}

type ShardingStrategy =
  | { kind: 'per-file' }
  | { kind: 'per-n-files'; n: number }
  | { kind: 'per-directory'; depth?: number } // 默认 1

type ExitCondition =
  | { kind: 'port-empty'; nodeId: string; portName: string }
  | { kind: 'port-equals'; nodeId: string; portName: string; value: string }
  | { kind: 'port-count-lt'; nodeId: string; portName: string; n: number; separator?: string } // 默认 '\n'

type Edge = {
  id: string
  source: { nodeId: string; portName: string }
  target: { nodeId: string; portName: string }
}

type AgentOverrides = {
  model?: string
  variant?: string
  temperature?: number
  dangerouslySkipPermissions?: boolean // 默认沿用 daemon 全局设置
}
```

> **readonly 不在 AgentOverrides 内**：始终从 agent.md 继承。
>
> **errors port 不在 outputs schema**：multi-process 父节点的 `errors` port 由框架自动追加，不出现在 agent.outputs 列表里，但下游节点可像普通 port 一样连接（编辑器侧栏显示该 port 时标灰 + "auto"小字）。

### 5.2 YAML 导出形态（人类可读）

```yaml
id: 01HXXX...
name: Audit & Fix
inputs:
  - kind: text
    key: requirement
    label: 需求描述
    multiline: true
    required: true
nodes:
  - id: in_1
    kind: input
    inputKey: requirement
  - id: wrap_git_1
    kind: wrapper-git
    nodeIds: [worker_1, audit_loop_1]
  - id: worker_1
    kind: agent-single
    agentName: code-worker
    promptTemplate: |
      Implement the following requirement.
      {{requirement}}
  - id: audit_loop_1
    kind: wrapper-loop
    nodeIds: [audit_1, fix_1]
    maxIterations: 3
    exitCondition:
      kind: port-count-lt
      nodeId: audit_1
      portName: audit_findings
      n: 1
  - id: audit_1
    kind: agent-multi
    agentName: code-auditor
    shardingStrategy: { kind: per-file }
    sourcePort: { nodeId: wrap_git_1, portName: git_diff }
  - id: fix_1
    kind: agent-single
    agentName: code-fixer
    promptTemplate: |
      Fix the issues found by the auditors.
edges:
  - {
      source: { nodeId: in_1, portName: requirement },
      target: { nodeId: worker_1, portName: requirement },
    }
  - {
      source: { nodeId: wrap_git_1, portName: git_diff },
      target: { nodeId: audit_1, portName: diff },
    }
  - {
      source: { nodeId: audit_1, portName: audit_findings },
      target: { nodeId: fix_1, portName: audit_findings },
    }
```

---

## 6、Workflow 执行引擎

### 6.1 调度核心

- 启动一个 task 时，引擎拷贝 workflow definition → `tasks.workflow_snapshot`，从 settings 拷贝默认资源限额（可被 workflow / 启动表单覆写）。
- 创建 worktree（base 分支取 `tasks.base_branch`）。失败 → 整个 task 标 `failed`，仍创建 task 记录便于用户排查。
- 内存里建一个 **执行图**：wrapper 展开为子图；多进程节点保留为占位（runtime 决定分片数）。
- 调度循环：
  1. 找出所有 `pending` 且所有上游 port 已 ready 的节点
  2. 按节点类型分发到不同执行路径
  3. 任一节点状态变更 → 唤醒调度循环
- 并发控制：
  - **全局 semaphore**：容量 `max_concurrent_nodes`（默认 4）
  - **写入 semaphore**：容量 1（per-task；按 agent.readonly 区分；只读节点不占用）
  - **multi-process 子进程独立池**：父节点占 1 个全局名额，子进程在父节点内部用独立池（容量按分片策略推算 / settings 配 `multiProcessSubprocessConcurrency`），不挤占其他节点全局名额
- 资源限额检查：
  - daemon 内 1Hz 后台 tick：扫描所有 running task → 检查 `now - started_at > max_duration_ms` / `sum(tok_total) > max_total_tokens` → 超限自动 cancel，error_message = `task-time-limit-exceeded` / `task-token-limit-exceeded`

### 6.2 节点 ready 判定

- 输入端口 ready = 该端口至少有一条上游边的源节点 `done`，且其 `node_run_outputs` 含目标 port（可能为空字符串）
- 多上游同 port 时：等所有上游都 done 后**按 source 节点 id 字典序顺序拼接**（中间用 `\n\n---\n\n` 分隔）
- 多进程父节点的 `errors` port 即使没有失败 shard 也存在（空字符串），下游若连了它仍可正常 ready

### 6.3 多进程节点（fan-out）

```
1. 等 sourcePort 内容 ready；空 diff → 直接 done，所有 outputs port = 空字符串，触发下游
2. 调用 GitHelper.split(diff, strategy) → shards: { key, content }[]
   - 重命名作为 1 个 shard
   - 二进制文件累计成一条"binary files: a.png, b.bin"附加在每个 shard 末尾（shard 内不含二进制 diff）
3. 为每个 shard 创建子 node_run（shard_key 填充，parent_node_run_id = 父）
4. 父节点用内部独立 semaphore 调度子 shard，与全局 semaphore 解耦
5. 等所有子 shard node_run 完成（含 done / failed）
6. 聚合：
   - 每个声明的 outputs port → 成功 shard 的同名 port 内容按 shard_key 字典序拼接
   - 自动 errors port → 失败 shard 列表 + 各自 error_message + binary files 提示
7. 写入父 node_run 的 outputs
8. 父节点 status = done
```

> **非分片输入端口**：父节点的其他输入端口（除 sourcePort 之外）对每个 shard 完整复制，子进程都看到一样的内容（如 `requirement` / `audit_checklist`）。

### 6.4 Loop wrapper

```
iteration = 0
while iteration < maxIterations:
  把 wrapper 内的子图作为一次"小执行"递归调度
  每个内层 node_run.iteration = iteration
  小执行结束后，求值 exitCondition：
    - port-empty:    指定节点本轮 outputs[port].trim() === ''
    - port-equals:   指定节点本轮 outputs[port] === value
    - port-count-lt: 指定节点本轮 outputs[port].split(separator).length < n
  if exitCondition 满足:
    根据 wrapper.outputBindings 把内层节点的指定 ports 复制到 wrapper 自身的输出
    wrapper.status = done
    return
  iteration += 1

# 超过 max_iterations 仍没退出
wrapper.status = exhausted
task.status = failed
```

注意 v1 **不实现跨轮反馈端口**：每轮迭代是 wrapper 内子图的一次独立执行；跨轮的"状态"完全靠 worktree 文件落盘（fix 写文件 → 下轮 audit 看新内容）。

UI 颜色：

- 当前迭代正在跑的内层节点：黄
- 当前迭代已结束、未来还会再跑的内层节点：蓝
- 退出后内层节点最终状态：绿（成功轮）

### 6.5 Git wrapper

```
on enter:
  pre_commit   = git rev-parse HEAD
  pre_diff     = git diff (HEAD)         + untracked-as-+
on exit (内部所有节点 done 后):
  post_commit  = git rev-parse HEAD
  post_diff    = git diff (HEAD)         + untracked-as-+
  output git_diff = compose_diff(pre_commit, pre_diff, post_commit, post_diff)

# compose_diff 实现：
#   1. commit 范围差: git diff pre_commit..post_commit
#   2. 当前工作区相对 post_commit 的差: git diff (HEAD)
#   3. 减去进入 wrapper 之前 已有的 工作区差（pre_diff）
#   4. untracked 文件以"新文件全 +"形式补充
#   5. 拼接 1+2 后写到输出 port
```

嵌套：

- **git wrapper 嵌套 loop wrapper 内**：每轮独立拍快照，wrapper 输出 `git_diff` 是退出条件满足那一轮的 diff
- **loop wrapper 嵌套 git wrapper 内**：git wrapper 的 pre 在 loop 第一轮启动前抓，post 在 loop 全部退出（满足条件 / exhausted）后抓 → 输出整个 loop 期间的总 diff

### 6.6 输出节点

- 编辑时声明若干"展示用 port"，每个 port 绑定到某个 `(nodeId, portName)`
- 引擎不为输出节点创建 node_run，仅在 task 详情页 GET 时实时拼装 → 返回给前端

### 6.7 重试 / Resume / Single-Node Retry

#### 节点 retries

- 节点 status=failed 时，框架检查 `retries`：
  - 计数：当前 node_run.retry_index < node.retries → 创建新 node_run（retry_index+1）→ **prompt 完全一致**重试
  - 全部 retry 都 failed → 节点最终状态 failed，传播到 task

#### Resume from failed/interrupted

```
1. user 点击 resume，传 task_id
2. 找到所有 status in (pending, failed, interrupted) 的 node_runs
3. 对每个 status=failed/interrupted 的写入节点：
   - git reset --hard <pre_snapshot>
   - clean -fd（清掉 untracked）
4. 把这些 node_runs 全部置 status=pending（保留 done 节点）
5. 重新启动调度循环
```

#### Single-Node Retry

```
1. 在节点详情弹窗点击"重跑该节点"，可选 cascade=true|false（默认 true）
2. 找到该节点 + （cascade=true 时）原本被它触发过的所有下游节点
3. 这些节点全部 git reset 到各自 pre_snapshot
4. 节点状态置 pending，下游也置 pending
5. 重新启动调度
```

#### Retry whole task

- 不重用旧 task 数据；以同一组 `(workflow_id, repo_path, base_branch, inputs)` 启动新 task

### 6.8 Daemon 重启对在跑 task 的影响

- daemon 启动时扫描 `tasks.status='running'` 与 `node_runs.status='running'`
- 对每个 node_run：检查 `pid` 是否仍存活（`kill -0 pid`）
  - 存活 → SIGKILL（孤儿子进程），node_run.status = `interrupted`
  - 已死 → node_run.status = `interrupted`
- task.status = `interrupted`，error_message = `daemon-restart`
- 用户可手动 resume

### 6.9 Daemon 优雅退出

- 收到 SIGTERM / SIGINT：
  1. 停止接受新 API 请求（HTTP server.close()）
  2. 给每个 running opencode 子进程发 SIGTERM
  3. 30 秒内：每子进程退出后落盘 events / outputs / status，正常 mark = canceled
  4. 30 秒后仍存活的 → SIGKILL，对应 node_run 标 interrupted
  5. 释放 daemon.lock，退出

---

## 7、opencode 子进程隔离实现

### 7.1 设计原则

- **不屏蔽** 仓内 `.opencode/`、`~/.opencode/`、`~/.claude/skills`、`~/.agents/skills` —— 用户的业务 skill / 全局 skill / auth 都需要保留。
- **agent 定义** 走 `OPENCODE_CONFIG_CONTENT`（inline JSON，opencode 在所有目录扫描完成后最后 merge，永远胜出）。
- **平台管理的 skill** 走每进程独立的 `OPENCODE_CONFIG_DIR/skills/`。

### 7.2 启动一个 node run

```ts
async function startNodeRun(task: Task, nodeRun: NodeRun, agent: Agent) {
  const runDir = `${APP_HOME}/runs/${task.id}/${nodeRun.id}/.opencode`
  await fs.mkdir(`${runDir}/skills`, { recursive: true })

  // 1. 注入平台管理 / 外部路径的 skill（仓内 skill 由 opencode 自行从 .opencode/skills 发现，跳过）
  for (const skillName of agent.skills ?? []) {
    const skill = await loadSkill(skillName)
    switch (skill.sourceKind) {
      case 'managed':
        // 拷贝整个 skill 目录到本次执行的私有目录
        await copyDir(`${APP_HOME}/skills/${skillName}`, `${runDir}/skills/${skillName}`)
        break
      case 'external':
        // 外部已注册路径，用 symlink 节省 IO
        await fs.symlink(skill.externalPath, `${runDir}/skills/${skillName}`)
        break
      // 'project' 来源：opencode 已通过仓内 .opencode/skills 扫描到，无需注入
    }
  }

  // 2. 构造 inline agent 定义（OPENCODE_CONFIG_CONTENT 主体）
  //    包含 agent.md 全部 frontmatter 字段 + 正文 prompt → 高优先级注入
  const overrides = nodeRun.overrides ?? {}
  const inlineAgent = {
    prompt: agent.bodyMarkdown, // agent.md 正文（system prompt）
    description: agent.description,
    model: overrides.model ?? agent.model,
    variant: overrides.variant ?? agent.variant,
    temperature: overrides.temperature ?? agent.temperature,
    permission: agent.permission,
    steps: agent.steps,
    // 平台自有字段（opencode 不识别但保留兼容；通过 options 透传）
    options: { outputs: agent.outputs, readonly: agent.readonly },
  }
  const inlineConfig = { agent: { [agent.name]: inlineAgent } }

  // 3. 拼接 user prompt（节点 prompt 模板替换 + 未引用 port 章节追加 + 输出协议块）
  const userPrompt = renderUserPrompt(nodeRun, agent)
  await dbUpdateNodeRun(nodeRun.id, { prompt_text: userPrompt })

  // 4. spawn opencode
  const args = ['run', userPrompt, '--agent', agent.name, '--format', 'json']
  if (nodeRun.dangerouslySkipPermissions ?? true) {
    args.push('--dangerously-skip-permissions')
  }

  const child = Bun.spawn(['opencode', ...args], {
    cwd: task.worktreePath,
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: runDir,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
      // 故意 *不设置* OPENCODE_DISABLE_PROJECT_CONFIG / OPENCODE_DISABLE_EXTERNAL_SKILLS
      // —— 仓内业务 skill、~/.opencode、外部 skill 路径都要保留
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  await dbUpdateNodeRun(nodeRun.id, { pid: child.pid, status: 'running', started_at: Date.now() })

  // 5. 流式读 stdout（每行一个 JSON event）
  const fullStdout: string[] = []
  for await (const line of streamLines(child.stdout)) {
    fullStdout.push(line)
    const evt = safeParseJson(line)
    if (evt) {
      await dbInsertEvent(nodeRun.id, evt)
      wsBroadcast(task.id, {
        type: 'node.event',
        nodeRunId: nodeRun.id,
        ts: evt.timestamp,
        kind: evt.type,
        payload: evt,
      })
    }
  }

  const exitCode = await child.exited
  await dbUpdateNodeRun(nodeRun.id, { exit_code: exitCode, finished_at: Date.now() })

  // 6. 解析最后一段 <workflow-output>
  if (exitCode === 0) {
    const xml = extractLastEnvelope(fullStdout.join('\n'))
    if (!xml) {
      await markFailed(nodeRun, 'no <workflow-output> envelope')
    } else {
      const ports = parseEnvelope(xml, agent.outputs)
      for (const [name, content] of ports) {
        await dbUpsertOutput(nodeRun.id, name, content)
        wsBroadcast(task.id, {
          type: 'node.output',
          nodeRunId: nodeRun.id,
          portName: name,
          content,
        })
      }
      await dbUpdateNodeRun(nodeRun.id, { status: 'done' })
    }
  } else {
    await markFailed(nodeRun, `opencode exit ${exitCode}`)
  }

  // 7. 清理 runDir
  await fs.rm(`${APP_HOME}/runs/${task.id}/${nodeRun.id}`, { recursive: true, force: true })
}
```

### 7.3 prompt 拼接细节

> **Input 节点端口契约（RFC-004）**：`input` 节点的**输出端口名 = `inputKey`**，
> 同时也是 `definition.inputs[]` 中对应 entry 的 `key`、launcher 表单字段的
> 字段名。三处任一不一致都是 bug。运行时 scheduler 把 `task.inputs[inputKey]`
> 写到 `node_run_outputs.portName = inputKey`，下游边按 `source.portName ===
inputKey` 查同一份 row。

```ts
function renderUserPrompt(nodeRun: NodeRun, agent: Agent): string {
  const tpl = nodeRun.promptTemplate ?? ''
  const inputs = nodeRun.resolvedInputs // { port_name -> 拼接后的字符串 }
  const referenced = new Set<string>()

  // 1. 替换 {{port_name}}
  let body = tpl.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    referenced.add(name)
    return inputs[name] ?? ''
  })

  // 2. 未被引用的 input port 作为附加章节
  for (const [name, content] of Object.entries(inputs)) {
    if (referenced.has(name)) continue
    body += `\n\n## ${name}\n${content}`
  }

  // 3. 框架协议块（指挥 agent 输出信封）—— 固定英文，避免与业务 prompt 的中文上下文混在一起
  body += `\n\n---\nYou MUST end your reply with a \`<workflow-output>\` block listing these ports:\n`
  for (const port of agent.outputs) {
    body += `  - ${port}\n`
  }
  body += `\nFormat:\n<workflow-output>\n`
  for (const port of agent.outputs) {
    body += `  <port name="${port}">...</port>\n`
  }
  body += `</workflow-output>`

  return body
}
```

> 模板替换还会把内置变量 `{{__repo_path__}}` / `{{__base_branch__}}` / `{{__task_id__}}` 替换为运行时元信息。agent.md 正文 **不做** 任何模板替换。

### 7.4 信封解析

```ts
function extractLastEnvelope(text: string): string | null {
  const matches = [...text.matchAll(/<workflow-output>[\s\S]*?<\/workflow-output>/g)]
  return matches.length ? matches[matches.length - 1][0] : null
}

function parseEnvelope(xml: string, declaredOutputs: string[]): Map<string, string> {
  // 用一个轻量 XML parser（fast-xml-parser）；XML 不一定 well-formed，需要容错
  const result = new Map<string, string>()
  for (const m of xml.matchAll(/<port\s+name="([^"]+)"\s*>([\s\S]*?)<\/port>/g)) {
    result.set(m[1], m[2].trim())
  }
  // 校验：未声明的 port 警告，缺失的 port 警告
  return result
}
```

> 容错策略：如果 agent 用 `name='x'` 单引号，或者 attribute 顺序不同，都补一个备用正则。但故意不写完备 XML parser —— 信封约定就一种合法形态。

#### 7.4.1 反问澄清信封（RFC-023 起）

agent 也允许吐出**第二种信封** `<workflow-clarify>`：当本节点的 workflow 中存在 `agent.__clarify__` 出边（指向某 clarify 节点）时，runner 会在用户 prompt 末尾追加一段英文 `buildClarifyProtocolBlock()`，指示 agent 在卡住的情况下可改吐 clarify。

```ts
type DetectedEnvelopeKind = 'output' | 'clarify' | 'both' | 'none'

function detectEnvelopeKind(stdout: string): DetectedEnvelopeKind {
  const hasOutput = /<workflow-output>[\s\S]*?<\/workflow-output>/.test(stdout)
  const hasClarify = /<workflow-clarify>[\s\S]*?<\/workflow-clarify>/.test(stdout)
  if (hasOutput && hasClarify) return 'both'
  if (hasOutput) return 'output'
  if (hasClarify) return 'clarify'
  return 'none'
}
```

**互斥规则（硬约束）**：一次回复只能是 `output` 或 `clarify` 之一；同时含两者 → runner 立刻把 node_run 标 `failed` 错误码 `clarify-and-output-both-present`；都不含 → 与既有行为一致，标 `failed` 错误码 `no <workflow-output> envelope found in stdout`。

clarify 信封 body 是 JSON：

```json
<workflow-clarify>
{
  "questions": [
    {
      "id": "q-db",
      "title": "Which database should we use?",
      "kind": "single",
      "recommended": true,
      "options": ["Postgres", "SQLite"]
    }
  ]
}
</workflow-clarify>
```

约束（agent 必须遵守，否则被框架友善截断 / 拒绝）：
- 最多 5 个 question；超出则取前 5 + 在下次 prompt 里回灌一条警告 `clarify-questions-too-many`（不阻塞）。
- 每 question 2–4 个 option；> 4 截到 4 + 回灌警告；< 2 是硬错误码 `clarify-options-too-few`，节点 fail。
- agent 禁止自己加 "其他/自定义" option —— UI 会自动给每题追加一行 textarea。
- `recommended: true` 的题目在用户提交时强制必答（UI 校验）。

runner 解析成功后调 `clarify.createClarifySession(...)`：写一行 `clarify_sessions`、对应 mint 一行 `clarify_node_run` 入 `awaiting_human`，回 task 顶层 `awaiting_human`，并广播 `clarify.created` WS 事件。用户提交答案后 service 把答案盖回 `clarify_sessions.answers_json`（重算 selectedOptionLabels 防客户端伪造）、把 clarify node_run 标 done、mint 一行 `source_agent_node_run` 的 rerun（`clarify_iteration = source.clarify_iteration + 1`，`retry_index = 0`，shardKey / parent / preSnapshot 透传）。详见 §9。

#### 7.4.1.1 同 session 内反问（RFC-026 起）

clarify 节点新增可选字段 `sessionMode: 'isolated' | 'inline'`（默认 `'isolated'`，与 RFC-023 落地版本 byte-for-byte 一致）。

- `isolated`：每轮反问 → 用户回答 → agent 重跑都新开 opencode 进程；prompt 在 `## Clarify Q&A — Prior Rounds (Questions)` + `## Clarify Q&A — Prior Rounds (Answers)` 两段里把所有历史轮 Q&A 重新拼进去。
- `inline`：runner 在 spawn 时多带一个 `--session <prior-session-id>` 参数，opencode CLI 加载上一次 session 的完整 transcript（messages / thinking / tool calls）。本轮 user prompt 退化为 "User Answers (Current Round)" 一段 + 一行精简 reminder（`buildClarifyInlineReminder()`），不再重发 bi-modal preamble + 完整 clarify 协议块（agent 在 session 历史里已经看过）。

实现要点：
- `node_runs.opencode_session_id`（§3 同章节加列）持久化 runner 从 opencode `--format json` event stream 抓到的 sessionId。
- scheduler 在 clarify 触发的 agent 重跑（`clarify_iteration > 0 && retry_index === 0`）路径上调 `decideResumeSessionId({ sessionMode, sourceSessionId })`：
  - `sessionMode === 'isolated'` 或 sourceSessionId 缺失 → 走 isolated（无 `--session`），missing 时写 warning 事件 `inline-clarify-fallback-to-isolated: missing-session-id`。
  - 否则 inline 路径生效；runner spawn 后扫 stderr 检测 `session not found` 类提示 → 写 warning `inline-clarify-fallback-to-isolated: session-not-found` 并让现有 retry 路径以 isolated 复位。
- inline 路径**跳过**反问回滚的 `worktree.restoreSnapshot(preSnapshot)`：opencode session 的 tool-call 记忆里包含它对 worktree 状态的认知，rollback 会让 agent 视角与文件系统脱钩。RFC-023 协议禁止 agent 在反问回合里写文件，所以 rollback 通常本就是 no-op。
- review reject / iterate / 技术 retry / wrapper-loop 跨 iter 路径**一律**不走 inline（这些是"重新开始"语义），保留 RFC-023 默认行为。
- agent-multi shard 各自独立 sessionId，inline 沿 shard 链路续接（fan-out 父节点本身不调 opencode）。

UI：clarify 节点 Inspector 暴露 segmented `sessionMode` 选择器；任务详情节点 Stats tab 在 `opencode_session_id` 非空时显示该 id 前缀 + `session=inline` chip（仅当本 node_run 的 `clarify_iteration > 0`）；事件流把 `[rfc026/inline-session-resumed]` / `[rfc026/inline-fallback]` 前缀的 `kind='text'` 行渲染成 info / warning 行（i18n key `clarify.eventStream.{sessionResumed,fallbackToIsolated}`）。

#### 7.4.2 端口元数据（RFC-005 起）

agent.md frontmatter 可声明 `outputKinds: { portName: 'markdown' | 'markdown_file' }`（sidecar，不破坏老 agent 的 `outputs: string[]`）。**`markdown_file`** kind 表示 port content 是 worktree 内的相对路径（不是文件正文）；review 节点遇到这种 port 时框架会读出文件正文写入 `doc_versions.body_md` 并把 `source_ref` 设为 `file:<相对路径>`。普通 `markdown` 走 inline。

---

## 8、Git 集成

### 8.1 Worktree 助手

```ts
async function createWorktree(repoPath: string, taskId: string, baseBranch?: string) {
  const slug = repoSlug(repoPath)
  const wtPath = `${APP_HOME}/worktrees/${slug}/${taskId}`
  const branch = `agent-workflow/${taskId}`
  const base = baseBranch ?? (await git.currentBranch(repoPath))
  await git.run(repoPath, ['worktree', 'add', '-b', branch, wtPath, base])
  return { worktreePath: wtPath, branch }
}

async function removeWorktree(repoPath: string, wtPath: string) {
  // 不强制 --force；如果用户有未 push 的改动，提示
  await git.run(repoPath, ['worktree', 'remove', wtPath])
}
```

### 8.2 Diff 计算与分片

```ts
async function gitDiffSnapshot(wtPath: string, prev: { commit: string }) {
  // 已提交的差
  const committed = await git.run(wtPath, ['diff', prev.commit])
  // 工作区未提交差（含 staged）
  const wd = await git.run(wtPath, ['diff', 'HEAD'])
  // untracked
  const untracked = await git.run(wtPath, ['ls-files', '--others', '--exclude-standard'])
  // 把 untracked 转成"全 +"伪 diff
  return composeDiff(committed, wd, untracked)
}

function splitDiffPerFile(diff: string): { key: string; content: string }[] {
  // 按 'diff --git a/... b/...' 切分
}
function splitDiffPerNFiles(diff: string, n: number) {
  /* ... */
}
function splitDiffPerDirectory(diff: string, depth = 1) {
  /* ... */
}
```

### 8.3 仓最近列表

每次成功 `POST /tasks` 后，把 `repo_path` upsert 进 `recent_repos` 表，updated `last_used_at`，并探测 `default_branch` 缓存。前端启动表单的"最近用过"下拉读这里。

### 8.4 节点 start 前快照（用于 resume / retry）

```ts
async function snapshotBeforeNodeStart(wtPath: string, taskId: string, nodeRunId: string) {
  // 仅写入节点（agent.readonly=false）才需要
  // git stash create 创建一个 detached commit object 包含 working tree + index 状态
  const { stdout } = await git.run(wtPath, ['stash', 'create'])
  const sha = stdout.trim()
  await fs.writeFile(`${APP_HOME}/snapshots/${taskId}/${nodeRunId}.snapshot`, sha)
  await dbUpdateNodeRun(nodeRunId, { pre_snapshot: sha })
  return sha
}

async function rollbackBeforeRetry(wtPath: string, snapshotSha: string) {
  await git.run(wtPath, ['reset', '--hard', 'HEAD'])
  await git.run(wtPath, ['clean', '-fd'])
  if (snapshotSha) {
    await git.run(wtPath, ['stash', 'apply', snapshotSha])
  }
}
```

> 只读节点不需要拍快照（不会改 worktree）。多进程节点的子 shard 也不拍快照（父节点拍一次即可）。

---

## 9、节点状态机

```
              ┌─────────► canceled        (用户 cancel)
              │
              ├─────────► interrupted     (daemon SIGTERM 30s 内未退 → SIGKILL，或 daemon 重启扫描标记)
              │
pending ──► running ──► done
   ▲          │   │
   │          │   └────► failed (exit_code != 0 / 信封解析失败 / timeout)
   │          │           │
   │          │           ▼
   │          │     (节点 retries=N → 创建新 node_run，retry_index+1，prompt 一致；
   │          │      最后一次仍 failed 则节点最终 failed)
   │          │
   │          └────► skipped（仅 resume 时已 done 的节点）
   │
   └── single-node retry 触发（默认级联下游也回 pending）
   └── resume from failed/interrupted 触发（worktree 回滚到节点 pre_snapshot）
```

颜色：done=绿，running=黄，pending=灰，loop body 蓝（已跑可能再跑），失败族（failed/canceled/interrupted/exhausted）红边 + 文字。

特殊：

- Loop wrapper 自身在所有迭代跑完且退出条件满足后转 `done`；max_iterations 但未满足 → `exhausted`（task → failed）
- 多进程节点的父节点在所有 shard 结束后转 `done`（即便部分 shard `failed`，错误信息聚合到 `errors` port）
- **Review 节点（RFC-005）**：进入 `running` 后框架快照 `doc_versions` → 节点立刻转 `awaiting_review`，**task.status 也同步设为 `awaiting_review`**；阻塞至 `POST /reviews/:taskId/:nodeId/decision` 返回。决策后：
  - `approve` → 节点 `done`，docPort 写 body_md；reviewOutcomePort = `'approve'`
  - `reject` → 节点 `done`（reviewOutcome = `'reject'`），框架把 `rerunOnReject` 列表内的节点（含同上游派生出的兄弟 review 节点）回 `pending`，task 进入 `running` 重跑
  - `iterate` → 节点 `done`（reviewOutcome = `'iterate'`），把 `rerunOnIterate` 内节点回 `pending`，相同上游兄弟 review 不连锁；prompt 模板可读 `{{__review_comments__}}` / `{{__iterate_target_port__}}`
- **Reject / iterate 上游重跑（RFC-011）**：上面两条提到的"回 `pending`"在实现层不是就地改状态，而是 **mint 一行新的 `node_run`**：原行 `status='canceled'` + `errorMessage='superseded-by-review-{decision}: …'` 保留其 `promptText` / outputs；新行 `retry_index = prev.retry_index + 1`，状态 `pending`，继承 `preSnapshot`。scheduler 的 `pendingExisting` 谓词与 `resolveUpstreamInputs` 的 "latest by retryIndex" 都向后兼容。这样 task 详情 drawer 的 Prompt-tab attempts 切换器可以列出每一轮 review 重跑各自实际发出去的 prompt（review iterate / reject 之前的 prompt 不再被覆写）。同一 (taskId, nodeId, iteration) 下因此可累积多条 `retry_index` 行 —— 既来自技术性 retry，也来自 review reject / iterate 重跑。
- **Clarify 节点（RFC-023）**：不主动调度。当上游 agent 吐出 `<workflow-clarify>` 信封，runner 在原 agent node_run 仍维持 `done`（agent 完成了一次有效"反问表达"）的同时调 `clarify.createClarifySession(...)`，mint 一行 clarify-node node_run 立即落 `awaiting_human`，**task.status 同步切 `awaiting_human`**（与 `awaiting_review` 互斥但 awaiting_human **优先级更高**：clarify 等用户答题比 review 等用户决议语义更主动、面板更紧迫）。submit answers 后 clarify service 把 clarify node_run 标 done、mint 一行 source agent 的 rerun：`clarify_iteration = source.clarify_iteration + 1`、`retry_index = 0`、`shard_key` / `parent_node_run_id` / `pre_snapshot` 透传。scheduler 的 resume "latest per node_id" 比较从 `retry_index` 单维改成 `(retry_index, clarify_iteration)` tuple，让 clarify rerun 行不被旧 done 行盖过。**agent-multi shard fanout**：每个反问 shard mint 独立 clarify_session + 独立 clarify node_run（按 source_shard_key 分组）；只要还有 shard `awaiting_human`，父 multi-process 节点维持 `awaiting_human` 不聚合。
- **clarify channel 边在调度图里被剔除**：`agent.__clarify__ → clarify.questions` + `clarify.answers → agent.__clarify_response__` 这两条由反向拖动注入的边形成一个**显式环**；`buildScopeUpstreams` 与 `topologicalOrder` 都跳过 portName 为 `__clarify__` / `__clarify_response__` 的边，所以拓扑序里 clarify 节点不挂 agent 的上游、agent 也不依赖 clarify。answer 通过 `clarify_sessions.answers_json` + `buildClarifyPromptContext(...)` 注入到 agent 下一轮 prompt，并非沿这条 visual 边走 dataflow。

---

## 10、安全

### 10.1 网络绑定

- 默认绑 `127.0.0.1` + 随机端口（避免与其他本机服务冲突）
- Settings 可改 `bindHost: '0.0.0.0'` —— 此时强制要求 token，且不在 stdout 重复打印 token
- bind host/port 修改后需重启 daemon 才生效

### 10.2 Token 流程

- daemon 启动时检查 `~/.agent-workflow/token`：不存在则生成 32 字节 hex（`crypto.randomBytes(32).toString('hex')`），写入并 chmod 600
- 启动 stdout 打印一次 `http://127.0.0.1:{port}/?token=...`（仅当 bindHost = '127.0.0.1'）
- 浏览器从 URL query 读 token → 存 localStorage → 之后所有 API 用 `Authorization: Bearer ${token}`，WS 用 `?token=...`
- Settings 提供"重生 token"按钮 + CLI `agent-workflow config rotate-token` —— 重生后所有现有 session 都被注销

### 10.3 单机单用户

不做用户系统。希望局域网共享：用户自行启用 `bindHost=0.0.0.0` + 反代加 IP 白名单 / VPN。

### 10.4 子进程权限

- 默认带 `--dangerously-skip-permissions`（用户对自己的仓负责）
- Settings 与节点级别都可关闭；关闭后 permission 询问由 opencode 默认非交互行为 reject
- agent.permission 字段透传到 inline JSON，opencode 自身判定是否 ask / deny

---

## 11、配置

`~/.agent-workflow/config.json` schema（带 `$schema_version`）：

```ts
type Config = {
  $schema_version: 1
  // 运行时
  opencodePath?: string // 不填则 PATH 找 'opencode'
  defaultModel?: string // 'anthropic/claude-opus-4-7' 等
  defaultVariant?: string
  defaultTemperature?: number
  maxConcurrentNodes: number // 默认 4
  multiProcessSubprocessConcurrency: number // 默认 4，多进程节点内部子进程的独立并发上限
  // 限额（默认值，workflow 与启动表单可覆写）
  defaultPerTaskMaxDurationMs: number // 默认 60 * 60 * 1000（1 小时）
  defaultPerTaskMaxTotalTokens: number // 默认 0 = 不限
  defaultPerNodeTimeoutMs: number // 默认 30 * 60 * 1000（30 分钟）
  // GC
  worktreeAutoGc: {
    // 默认关闭
    enabled: boolean
    olderThanDays?: number
    onlyMerged?: boolean
  }
  eventsArchiveThresholds: {
    // 后台任务每小时跑一次扫描
    perNodeRunRows: number // 默认 50_000
    globalRows: number // 默认 1_000_000
  }
  // 大输出
  largeOutputThresholdBytes: number // 默认 1_048_576 (1MB)
  // 网络（重启后生效）
  bindHost: string // 默认 '127.0.0.1'
  bindPort?: number // 不填随机
  // i18n / theme
  language: 'zh-CN' | 'en-US' // 默认 'zh-CN'
  theme: 'system' | 'light' | 'dark' // 默认 'system'
  // —— 人审 markdown 渲染（RFC-005，PR-C） ——
  // PlantUML 渲染走 Kroki 兼容协议（GET deflate+base64，回退 POST 原文），不内置 plantuml.jar。
  // 留空 → 不渲染 PlantUML 块，仅显示原码块。建议自托管或填官方公共实例。
  plantumlEndpoint?: string // 形如 'https://kroki.io/plantuml'
  plantumlAuthHeader?: string // 可选：直传 Authorization header（私有 Kroki 部署）
  // —— 反问澄清（RFC-023）：本 RFC 不引入新 config 字段。 ——
  // 草稿（前端 IndexedDB store `clarify-drafts`）的字段长度由前端 maxLength +
  // shared schema `z.string().max(CLARIFY_MAX_CUSTOM_TEXT_LEN = 2000)` 双闸门兜底；
  // 每问题选项数 / 每信封问题数硬上限分别是 `CLARIFY_MAX_OPTIONS_PER_QUESTION = 4`
  // / `CLARIFY_MAX_QUESTIONS = 5`，在 `packages/shared/src/schemas/clarify.ts`
  // 集中定义；agent 超额时框架截到上限并在下一轮 prompt 回灌 truncationWarnings。
}
```

### 11.1 配置生效方式

- **大多数项保存即热生效**（运行时参数、限额默认、GC、模型、language/theme）
- **bindHost / bindPort** 仅 daemon 重启后生效；UI 在保存这些字段后会 toast"重启 daemon 后生效"
- **`maxConcurrentNodes`** 改动 → 立即调整 semaphore 容量；正在等待的节点根据新容量重新唤醒

### 11.2 启动健康检查

- 检测 `opencode --version` 是否可执行；版本 < 文档要求的最低 → 启动失败 + UI 引导
- 检测 SQLite 文件存在性 + WAL mode + 应用所有 pending migration
- 检测 `git --version` ≥ 2.5（worktree 命令可用）
- 检测 `~/.agent-workflow/token` 存在且 chmod 600

### 11.3 CLI `doctor` 命令

`agent-workflow doctor` 跑全套健康检查并打印结果（不启动 daemon）：

- opencode：在 PATH 里？版本？`opencode models` 是否能拿到至少一个 model？
- git：版本？
- DB：migration 状态？
- 磁盘：`~/.agent-workflow` 用量？
- 网络：bindHost / bindPort 占用？
- token：文件存在？权限正确？

---

## 12、前端结构

### 12.1 技术栈

- **构建**：Vite
- **框架**：React 19
- **路由**：TanStack Router（与 TanStack Query 同生态、TS 类型友好）
- **数据**：TanStack Query
- **客户端状态**：Zustand
- **UI**：shadcn (Base UI variant，与 multica 一致) + Tailwind
- **画布**：xyflow v12
- **Markdown**：react-markdown + remark-gfm
- **Diff 渲染**：diff2html
- **i18n**：i18next + react-i18next（v1 仅 zh-CN locale，预留多语言）
- **主题**：CSS variables + class strategy（system / light / dark）

### 12.2 路由

```
/                  → 重定向到 /workflows
/agents            → list（DataTable + 搜索 + 行末菜单 + "新建"按钮）
/agents/:name      → detail / edit （混合：左 frontmatter 表单 + 右 Markdown Edit/Preview）
/skills            → list
/skills/:name      → detail / edit （文件树 + Markdown Edit/Preview）
/workflows         → list
/workflows/new     → 编辑器（新建）
/workflows/:id     → 编辑器（自动保存 + 多 tab sync）
/tasks             → list（按状态/仓/workflow 筛选）
/tasks/:id         → 状态视图（顶产出 / 中画布 / 下 diff，节点点击右抽屉）
/settings          → 全局配置（4 标签页：运行时/限额/GC/网络）
/settings/about    → 版本 / 健康检查 / "重生 token"
```

### 12.3 主要组件

- `<WorkflowCanvas>` —— xyflow v12 包装，节点类型自定义渲染
  - `<AgentNode>` / `<MultiProcessAgentNode>` —— 显示 agent 名 / fan-out 角标 / 端口
  - `<InputNode>` / `<OutputNode>`
  - `<GitWrapperNode>` / `<LoopWrapperNode>` —— xyflow group node，可拖拽改大小
- `<NodeInspector>` —— 右侧 480px 抽屉，Edit / Preview 双 tab
- `<TaskStatusCanvas>` —— 复用 WorkflowCanvas，readOnly + 状态色 overlay
- `<NodeDetailDrawer>` —— Prompt / Events / Output / Stats 四 tab
  - Events tab：WS 流 + 200ms throttle render + chip 过滤 + Raw stdout 切换
- `<TaskLauncher>` —— 启动表单根据 `workflow.inputs` 动态渲染控件 + 仓选择 + base 分支选择 + "从以往 task 填充"下拉
- `<WorktreeDiffViewer>` —— 嵌入 diff2html
- `<EditorSidebar>` —— Agents / Wrappers / IO 三分组 + agent 搜索框
- `<MarkdownEditor>` —— react-markdown + remark-gfm，支持 Edit / Preview tab
- `<SkillFileTree>` —— skill 详情页文件树
- `<DiffViewer>` —— 复用 worktree diff

### 12.4 状态管理

- **TanStack Query**：所有 REST 数据；通过 `queryClient.invalidate*` 反映 CRUD 变更
- **Zustand**：编辑器临时状态（画布缩放/选区/抽屉打开状态/已选节点 tab 记忆）、主题、token
- **TanStack Router**：URL state（route params / search params）
- **WS 处理**：事件不写 store，而是驱动 query invalidate 或 in-place 更新具体事件流（events tab）
- **localStorage**：token、theme 偏好、last-opened workflow / task

### 12.5 多 tab sync

- 前端订阅 `/ws/workflows`，收到 `workflow.updated` 且自己的 workflow query cache 是旧版本 → toast "其他 tab 修改了 workflow"，自动 refetch
- 编辑器内自动保存仍正常（后写胜出）
- localStorage 共享 token / theme，但每个 tab 独立 query cache

---

## 13、CLI 子命令

`agent-workflow` 二进制提供以下子命令：

| 命令                                            | 说明                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `start`                                         | 前台启动 daemon。stdout 打印 `http://127.0.0.1:{port}/?token=...`。日志同步写 stdout + `~/.agent-workflow/logs/daemon.log` |
| `stop`                                          | 读 `~/.agent-workflow/.daemon.lock` 拿 PID，发 SIGTERM；30s 后仍存活则提示                                                 |
| `status`                                        | 打印 daemon PID + 端口 + URL + 运行时长 + 当前 task 数                                                                     |
| `version`                                       | 打印 daemon 版本 + opencode 版本 + 最低兼容 opencode 版本                                                                  |
| `doctor`                                        | 执行 § 11.3 的全套健康检查，不启动 daemon                                                                                  |
| `config get [key]` / `config set <key> <value>` | 读 / 写 config.json 字段（点路径）                                                                                         |
| `config rotate-token`                           | 重生 token 并写入 `~/.agent-workflow/token`                                                                                |
| `migrate`                                       | 手动跑 drizzle migration（startup 时已自动跑，此命令仅 debug / 故障恢复用）                                                |
| `backup`                                        | 触发一次备份，输出 `~/.agent-workflow/backups/{date}.tar.gz` 路径                                                          |

---

## 14、构建与分发

### 14.1 开发模式

```bash
# 根目录
bun install

# 后端 dev (watch + reload)
bun --filter backend dev

# 前端 dev (Vite, port 5174)
bun --filter frontend dev

# 一键起两个
bun dev
```

后端 dev 模式下走源码 + 启动器拉起 Vite dev server 反代静态资源（HMR）。

### 14.2 生产构建

```bash
# 前端 → packages/frontend/dist/
bun --filter frontend build

# 嵌入前端到后端 + Bun build 单二进制
bun --filter backend build:binary

# 输出：dist/agent-workflow-{macos|linux}-{arch}
```

后端构建用 `Bun.build({ target: 'bun', outdir, compile: true })` 出独立可执行文件，包含 Bun runtime + 应用代码 + 嵌入的前端 dist。

### 14.3 分发

- GitHub Releases，每个 release 含两个二进制：
  - `agent-workflow-macos-arm64`（M1+）
  - `agent-workflow-linux-x86_64`
- 用户下载 → `chmod +x` → `./agent-workflow start`
- v1 不做自动更新；CLI `version` 提示新版本

---

## 15、测试策略

### 15.1 后端

- **bun:test** 单元 + 集成
- DB 测试用**内存 SQLite**（`Database(':memory:')`），每个 test case 独立实例
- 子进程相关测试：mock `Bun.spawn`，不真起 opencode（保持快速 + 不依赖网络）
- 集成测试：起 daemon + 用 stub opencode (一个本地 echo agent 模拟 stdout JSON 流) 跑完整 task

### 15.2 前端

- **vitest** + Testing Library + jsdom
- 关键组件：`<NodeInspector>`、`<TaskLauncher>`、`<WorkflowCanvas>` 几个交互密集组件
- 不强求覆盖率指标，定性覆盖关键 UX

### 15.3 端到端

- **Playwright**
- 测试流程：登录 → 创 agent → 创 workflow（拖拽 + 连边） → 启动 task → 看到节点变绿 → 看节点详情
- e2e 跑时仍 mock opencode（spawn 一个 stub bash 脚本）

### 15.4 CI

- GitHub Actions：单元 + e2e + Bun build 验证
- 不做 Windows job

---

## 16、备份与恢复

### 16.1 触发

- Settings 页面"导出备份"按钮 → 后台执行 → 完成后下载链接
- CLI `agent-workflow backup` → 终端打印路径

### 16.2 内容

```
backup-{ISO date}.tar.gz
├── db.sqlite                  # 事务 dump (.backup TO 命令)
├── skills/                    # 整个 skills 目录
├── workflows/                 # 自动 dump 所有 workflow 为 YAML
└── config.json                # 配置（token 文件不含在内，避免泄露）
```

不含：worktrees、runs、logs、backups。

### 16.3 恢复

无 UI 恢复流程；用户手动：

1. `agent-workflow stop`
2. 备份当前 `~/.agent-workflow/db.sqlite`
3. 解压 backup，覆盖 db.sqlite + skills/ + config.json
4. `agent-workflow migrate`（保险起见手动跑）
5. `agent-workflow start`

---

## 17、路线图

| 里程碑          | 范围                                                                                                                                                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1 骨架**     | Bun daemon + Hono API + drizzle migration + flock 单实例 + token 鉴权 + 前端 Vite 壳 + Agents / Skills CRUD（混合编辑器 + 文件树）+ 单节点线性 workflow + 单 task 串行执行（无 wrapper、无多进程）+ healthcheck endpoint + CLI `start/stop/status/doctor`            |
| **M2 编辑器**   | xyflow v12 编辑器（侧栏拖拽 / 右键菜单 / 撤销重做 / 多选 / 自动布局）+ 节点抽屉 Edit/Preview + 输入/输出节点 + 5 项静态校验 + 启动表单（4 控件 + 仓 + base 分支） + 任务状态视图三区 + WS 三频道 + since-id 重放 + 多 tab sync                                       |
| **M3 编排核心** | 多进程节点（含 3 种分片 + 重命名 / 二进制 / 空 diff 边界 + errors port） + git wrapper + 写入串行 / 只读并发 + retry / cancel / resume / single-node retry + 节点 start 前快照与回滚 + 流式 events 推送 + 节点详情四 tab + retries history + 子进程列表 + Raw stdout |
| **M4 高级编排** | loop wrapper（3 种退出条件）+ wrapper 任意嵌套（git in loop / loop in git） + worktree 可选 GC + YAML 导入导出（含冲突弹窗） + 资源限额执行 + interrupted 状态 + daemon 重启扫描                                                                                     |
| **M5 打磨**     | 历史 events 归档（每小时后台任务）+ token 统计 + 错误概述条 + i18n 中文 locale 完整 + dark mode 适配 + 备份 / 恢复 + Bun build 单二进制 + GitHub Releases + Playwright e2e                                                                                           |

---

## 18、未决项 / 风险点

下面这些在 v1 实现阶段可能需要再决策，但不阻塞设计落地：

1. ~~**opencode 最低版本号**~~：**已验证**（2026-05-11，opencode 1.14.25）。`OPENCODE_CONFIG_CONTENT` inline JSON 注入 agent 胜过 `$HOME/.opencode/agents` 与仓内 `.opencode/agents` 同名 agent；`OPENCODE_CONFIG_DIR` 与仓内 `.opencode/skills` 同时被发现，互不冲突；`prompt / description / model / variant / temperature / steps / permission / options.{outputs,readonly}` 字段全部能透传。**最低支持版本暂定 1.14.0**（启动时 semver 探测，更老版本可在 v1 实施期 bisect 下探）。验证脚本见后端 `tests/integration/opencode-isolation.test.ts`（M0 完成时落库）。
2. **大 diff 性能**：几 MB 量级 diff 多进程切片时 IO 密集；如有瓶颈考虑流式切片或限制单 task 最大 diff 大小
3. **opencode session 复用**：v1 每节点新 session（独立隔离）；若有"长上下文连续对话"需求再设计
4. **Loop wrapper 跨轮反馈端口**：v1 不做（仅靠 worktree 文件传递）；若实际跑出"非通过 worktree 反馈"的需求再设计 wrapper 级反馈端口绑定 UI
5. **多语言完整化**：v1 默认中文，i18n 框架预留；英文 locale 在 M5 后再补
6. **multi-process 子进程独立 semaphore 容量** 与 `max_concurrent_nodes` 的合理默认比例：v1 都给 4，运行时观察是否需要调
7. **agent.permission UI 高级 raw JSON**：v1 仅普通常见项；如果实际场景需要更细粒度（per-pattern allow/ask/deny），后期补 schema-driven 表单
8. **Skill 文件 binary 编辑**：v1 文件树仅展示 + 替换上传；不做内置二进制编辑
9. **Github token 在 settings 的存储**：v1 明文存 config.json；如需安全升级走 keychain
10. **Workflow 跨版本 schema 迁移**：`$schema_version=1` 时 noop；**v2（RFC-005）已落地**：`migrateDefinitionToLatest()` 在加载 v1 时把 `$schema_version` 升到 2 不破坏现有节点，新增的 review 节点写入时强制 v2。
