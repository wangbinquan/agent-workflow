# RFC-308 任务 Git 提交、平台工作目录与自动排除规则归一——实施账

> 产品裁决见 [proposal.md](./proposal.md)，技术边界见 [design.md](./design.md)。
> 状态：**Done（2026-08-17）**。用户批准后一次性硬切；无旧目录/字段兼容读取。

## 0. 交付裁决

本 RFC 已按用户要求完成三件事，顺序未倒置：

1. 先把普通 task auto-publish 与 code-capability 的候选选择、commit、preview/freeze、publish/history guard 收到
   `source-control` 的同一机制；code-capability 只拿 `task-execution/public` 的四方法、path-free participant；
2. 把仓内平台文件统一为 `/.agent-workflow/{inputs,runs,fusion}/`，RFC-248 与 Fusion 的内置 ignore 统一为
   per-worktree platform profile；不再修改或提交业务仓 `.gitignore`，也不写 common `.git/info/exclude`；
3. 增加全局 `taskCommitExcludePatterns`、Settings → Git 配置入口、tracked/staged/rename/submodule 严格过滤与
   outgoing-history 拒推；任务详情展示有界排除回执。

用户明确“旧名字还没人用、不要兼容性读取”，因此没有把旧目录探测器做成生产 reader：迁移 0173 直接删列，生产源码
zero-ratchet 锁定旧目录、旧 preset symbol 与旧 wire 为 0；历史 migration 测试仍保留当时物理 schema 的事实。

## 1. A——工作目录与 platform profile（全部完成）

| 任务                    | 落地                                                                                                                          | 证据                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| A1 canonical convention | ✅ shared `workspaceConvention.ts`；root/subdir/safe segment 单点                                                             | `rfc308-workspace-convention.test.ts`             |
| A2 Agent/group upload   | ✅ Agent 与 group prefix 迁至 canonical inputs；packed path 使用真实落点                                                      | RFC-218/248/262/107 定向套件                      |
| A3 code/Fusion          | ✅ code run dir 与 Fusion manifest 迁至 canonical runs/fusion；copy 跳过整个 root                                             | `fusion-engine.test.ts`、code commit 集成测试     |
| A4 profile owner        | ✅ `WorkspaceExcludeManager` 写 per-worktree profile + `core.excludesFile`；继承既有 effective exclude；冲突/反选 fail closed | `rfc308-workspace-exclude.test.ts`                |
| A5 RFC-248 hard cut     | ✅ 删除 preset service/util/test；不动 `.gitignore`、HEAD/baseCommit；nested mount 由 profile 排除                            | `rfc248-materialize-group.test.ts`                |
| A6 schema/wire cut      | ✅ migration 0173 删除 `gitignore_commit`，新增 version/digest receipt；shared/mapper/scheduler 旧字段归零                    | `migration-0173-rfc308-workspace-profile.test.ts` |
| A7 admission/safety     | ✅ tracked `/.agent-workflow/` 拒绝启动；canonical mkdir 拒 symlink/非目录/越界                                               | materialize + workspace exclude tests             |
| A8 production zero      | ✅ 四旧目录、preset symbol、old wire 生产引用为 0                                                                             | `rfc308-source-cutover.test.ts`                   |

## 2. B——统一 task workspace commit capability（全部完成）

| 任务                     | 落地                                                                                                         | 证据                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| B1 source-control engine | ✅ `repositoryCommit.ts` 唯一拥有 add/name-status/temp-index/commit/push/history Git argv                    | source cutover ratchet                    |
| B2 task authority        | ✅ `TaskWorkspaceCommitParticipant` 仅 4 方法：preview/freeze/publish/release；DTO 无 absolute path          | backend typecheck + source ratchet        |
| B3 dependency direction  | ✅ production 为 `code-capability → task-execution.public → source-control composition/application`          | source cutover ratchet                    |
| B4 ordinary task         | ✅ `commitPushRunner` 保留 NodeRun/message/repair/non-FF 语义，候选、commit 与所有 push 委托统一 participant | `commit-push-runner.test.ts`              |
| B5 code capability       | ✅ Git adapter 删除 add/commit/push/update-ref 实现；artifact hooks/identity/CAS/new branch 语义保留         | RFC-304 Git/identity + RFC-308 code tests |
| B6 submodule             | ✅ parent mount 整棵排除；否则 child-root 重新解释规则；commit/publish 同一引擎                              | RFC-210 subrepo tests                     |
| B7 outgoing guard        | ✅ normal/CAS/new/submodule push 只能通过先扫 history 的 publish API；引入后又删除仍拒推                     | repository/code/ordinary tests            |

## 3. C——配置、回执与界面（全部完成）

| 任务                  | 落地                                                                                                         | 证据                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| C1 schema             | ✅ 最多 256 条、单条 1024 UTF-8 bytes、合计 64 KiB；NUL/newline/host path/`../` 拒绝；PATCH null reset       | shared config tests                |
| C2 operation snapshot | ✅ 每次 commit/freeze 读取一次当前配置；保存影响下一 operation；读取失败回落 launch snapshot                 | `rfc308-operation-config.test.ts`  |
| C3 strict selection   | ✅ Gitignore 顺序/注释/反选；hard root 最后求并；tracked/untracked/delete/rename/奇异路径用 literal pathspec | `rfc308-repository-commit.test.ts` |
| C4 Settings Git       | ✅ `Field + TextArea monospace`，一行一条且不 trim/逗号拆分；字段旁错误与双语边界说明                        | frontend RFC-308 tests             |
| C5 task detail        | ✅ mixed/all/history-block 三态；最多 100 条 repo-relative path + truncated/digest/history flag              | task detail source/type tests      |
| C6 config funnel      | ✅ root task、resume/retry、child task 与四条 code capability 共用同一 operation slice                       | launch/child inheritance tests     |

## 4. RFC-294 对账

- 新机制落在 `modules/source-control/{domain,application,infrastructure,public,composition}`；Gitignore 匹配、index、commit、
  publish 与 history 不再复制进业务模块。
- task-execution 铸 path-free `TaskWorkspaceCommitParticipant`；code-capability production source 对 source-control internal import=0。
- absolute `repoPath/worktreePath` 只进入两个 composition binder；它们登记为 RFC-294 W5 正式 `WorkspaceRef` cutover 时删除的
  过渡 seam，不升级成 public path API。
- 普通任务的 NodeRun/message/repair orchestrator 暂仍在 `services/commitPushRunner.ts`；它已不拥有候选/commit/push Git argv。
  把 facade 物理搬入 task-execution application 属 W5 文件迁移，不为本功能再造第二套行为。
- Fusion profile 仍经 composition-only adapter；RFC-294 W4 `InternalWorkspacePreparationPort` 落地后删除。

## 5. 验收门

- 定向真实 Git：ordinary mixed/all/history、code preview/freeze/CAS/new、nested repo-group、submodule、Fusion 均通过；
- schema migration 与 `drizzle-kit check` 通过；
- shared/backend/frontend typecheck 通过；
- 完整 `bun run gate:local`：7m27s 全绿（backend 12007 pass / 35 skip、shared 2186、frontend 6571）；
- 提交只包含 RFC-308 owned paths，带 Codex co-author trailer；push 后按 exact/containing SHA 等待 hosted CI 终态。

## 6. 非遗留项

以下不是本 RFC 未完成任务：per-task/per-repo override、拦截 agent 自己执行的 Git、重写已推远端历史、迁移旧目录、
完成 RFC-294 W5 的全部 repo/cache/worktree SCC，以及把管理员规则写入 worktree profile。它们均在 proposal 的非目标中；
管理员规则刻意只作用于平台代理 commit，profile 只负责 canonical root 与动态 mount 的 Git 视图。
