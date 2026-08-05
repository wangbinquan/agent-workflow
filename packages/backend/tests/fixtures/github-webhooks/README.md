# GitHub webhook fixtures（RFC-259）

本目录存放**真实 GitHub（github.com / GHES）**导出的 webhook payload（脱敏后）。
在真实 fixture 落地前，`tests/rfc259-github-adapter.test.ts` 使用按 GitHub 官方
文档形态手写的 builder payload——**字段路径以真实 fixture 为准，不符处回改
`services/webhook/githubAdapter.ts` 与 `design/RFC-259-*/design.md §2.2`**。

## 实测清单（proposal §8；逐项在真实 GitHub 上核准）

1. **`workflow_run.actor.login` 是否 = 引发该 run 的 push 者**（与 `triggering_actor`
   的差异一并记录）——这是 RFC-257 D14/D22 熔断重置语义的前提（bot push →
   pipeline_failed 的 author 必须是 bot）。
2. **fork PR 的 `workflow_run.pull_requests` 为空数组**（文档未明言、社区周知）；
   同仓 PR 是否稳定填充。空数组时 streamKey 降级为 `repo|branch:<head_branch>`
   ——fork 的 head_branch 与 upstream 分支撞名（都叫 `main`）会共享同一流
   （supersede / 熔断桶），确认该降级形态是否可接受；若 `head_repository.full_name`
   可稳定判别 fork，考虑把 fork run 收窄为 unsupported。
3. **Redeliver 复用同一 `X-GitHub-Delivery`**（官方文档已载，实测复核）：
   Settings → Webhooks → Recent Deliveries → Redeliver，平台侧应表现为原行
   bump `attempt_count`、不重复分发。
4. **org 级 webhook 的 `ping` payload 无 `repository` 对象**：adapter 对 ping 在
   repository 解析之前返回 unsupported——实测确认投递历史是
   `ignored(unsupported-event)` 而非 parse-failed 噪音。
5. `pull_request_review_comment` 的 `comment.commit_id` 与 `pull_request.head.sha`
   的差异（行内评论挂在旧 commit 上时二者不同；现取 head.sha）。
6. **极端大 push 的 payload 实测尺寸**（GitHub push 的 commits 数组远大于 GitLab
   的 20 条上限）：批量 push 是否会超出平台 1 MiB body 上限 → 413 丢事件
   （GitHub 不重试）。若常超限，考虑 per-provider body 上限（后续 RFC）。

## 采集方法

GitHub → 仓库/组织 Settings → Webhooks → Recent Deliveries → 展开某条 →
Payload 原样保存为 `<event>.<变体>.json`（如 `workflow_run.completed-failure.json`），
把真实 org/repo/用户名替换为 `acme/api` / `user-a` 等占位；**保留字段结构与
类型**（数字 id 别改成字符串）。Headers 页签里的 `X-GitHub-Event` /
`X-GitHub-Delivery` / `X-Hub-Signature-256` 记进同名 `.headers.json`。
