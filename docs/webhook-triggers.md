# Webhook 触发器运维指引（RFC-257 / RFC-259 / RFC-268 / RFC-298 / RFC-300）

面向**商用内网部署**（自建 GitLab + 几百个仓库）的接入手册；§6 为 GitHub
（github.com / GHES，RFC-259）接入。产品/技术契约见
`design/RFC-257-code-host-webhook-triggers/`、`design/RFC-259-github-webhook-adapter/`、
`design/RFC-268-webhook-scratch-space/` 与
`design/RFC-300-webhook-terminal-workspace-cleanup/`。

## 1. 一次性接入（管理员）

### 1.1 平台侧

1. 确认 daemon 网络可达：`config.json` 的 `bindHost` 从默认 `127.0.0.1` 改绑
   内网地址（或前置反代）。**影响**：整个 `/api/*` 管理面随之暴露到内网——
   所有管理路由强制鉴权，但建议配合防火墙/反代收窄来源。
2. 配置 `publicBaseUrl`（生成给 GitLab 填的完整 URL 的唯一来源；建议指向反代
   的 HTTPS 地址——`X-Gitlab-Token` 是明文 header，GitLab → daemon 链路要么
   走可信内网段要么由反代终止 TLS）。
3. 设置 → Webhook 端点 → 新建端点。**Secret 只显示这一次**，当场复制。

### 1.2 GitLab 侧

- 几百仓共用一个 hook：**Group → Settings → Webhooks**（组级，付费版；评论
  事件齐全）或 **Admin Area → System Hooks**（实例级；**原生没有 Note/评论
  事件**——评论指令场景必须用 group/project 级 hook）。
- 粘贴平台给的 URL 与 Secret token，勾选事件：Push events / Tag push events /
  Merge request events / Comments / Pipeline events。
- 保存后用 GitLab 的 Test 按钮发一条，平台投递历史页应出现记录。

### 1.3 bot 账号（修复类场景必需）

1. GitLab 建专用 bot 账号（如 `aw-bot`），对目标仓库群授予 Developer+。
2. 发一个 `write_repository` scope 的 PAT，配进 **daemon 宿主机**的 git
   credential helper（或把宿主机 ssh key 加到 bot 账号）——修复产出要
   push 回 MR 源分支，凭据由宿主机管理，平台不托管。
3. **把 bot 的 username 填进每个触发器的「忽略用户名单」**——bot 自己的
   push / MR 更新 / 评论不再触发（防自触发风暴）。注意：**流水线事件不受
   此名单过滤**，这是修到绿循环的前提（bot push 引发的 pipeline_failed 仍
   会触发下一轮修复，循环由熔断上限兜底）。

## 2. 触发器配置要点

- **触发器绑规则不绑仓**：repo 范围（全部 / path 前缀 / 精确清单）× 事件
  类型 × 分支 glob × 评论指令前缀。几百仓用一条「前缀 = group path」的触发
  器罩住。
- **执行空间有两种**：默认“事件仓库”会使用事件对应的仓库与分支；事件仓未
  导入平台时默认按 payload URL 自动 clone（触发器可关）。“临时工作区”则每次
  触发新建一个带空根提交的 `main` Git 仓库，不读取事件仓缓存、不 clone、不带
  remote，也不会自动 push；事件变量仍照常渲染进提示词或 workflow 输入。
- 临时工作区下“自动注册仓库”固定关闭。切回事件仓库后平台不会自动恢复该
  开关，需要管理员按需手动开启。事件仓模式还需注意 **URL 形态统一**：内外网
  双 host / 大小写路径别名会造成同一仓的双份缓存——代码平台侧应保证 HTTP/SSH
  URL 形态稳定。
- workflow 的“分支来自事件”是输入元数据，不是工作区 checkout。即使选择临时
  工作区，无分支事件仍会代包空 `ref` 并在启动校验时报错；不要为 GitHub 普通
  PR 评论选择带该必填 git 映射的 workflow。
- 临时工作区只隔离、回收本地文件；任务已经发出的 HTTP 请求、评论、通知等
  外部副作用不会随重试、取消或工作区清理回滚，非幂等动作仍需自行加幂等保护。
- **降级兼容**：不认识 RFC-268 的旧 daemon 会把含 `scratch` 的模板判成损坏并
  跳过，不会悄悄回落成事件仓执行。回滚版本前先把这些规则切回“事件仓库”。
- 分支过滤语义：MR 类事件按**目标分支**匹配（`main` = 只审进主干的 MR），
  push/tag 按事件分支。
- 修到绿循环 = pipeline_failed 反复触发 + supersede（新事件取消同 MR 在跑
  的旧任务）+ 熔断（同一 MR 连续触发默认 3 次后跳闸；开发者本人 push 会
  重置计数，或在触发器的「触发记录」里手动重置）。

## 3. 排障对照表

| 现象                                  | 看哪里                                 | 处置                                                                                                                                               |
| ------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitLab Recent Deliveries 红色 401     | 平台投递历史 `rejected(invalid-token)` | Secret 不一致：平台轮换后重贴 GitLab                                                                                                               |
| GitLab 显示超时                       | ——                                     | 不应发生（平台三段式立即应答）；检查网络/反代超时设置                                                                                              |
| 事件到了但没起任务                    | 投递历史 `ignored(no-trigger-matched)` | 规则没罩住该仓/事件类型/分支；核对触发器                                                                                                           |
| 触发了但任务失败                      | 触发器 → 触发记录 `launch-failed`      | 看 error（repo clone 凭据 / 模板渲染 / 目标不可用）                                                                                                |
| 临时工作区里没有项目文件或 remote     | 任务工作区                             | 这是预期行为：临时模式从空 Git 仓开始；需要读/改事件仓代码时把规则切回“事件仓库”                                                                   |
| `skipped-owner-invalid`               | 同上                                   | 触发器 owner 被禁用或对目标失去权限；admin 改 owner 后重放                                                                                         |
| `skipped-circuit-open`                | 同上                                   | 熔断：人工重置或等开发者 push                                                                                                                      |
| daemon 重启后有 `failed(interrupted)` | 投递历史                               | GitLab 不自动重投——用重放按钮恢复                                                                                                                  |
| **hook 整个不发了**                   | GitLab webhook 编辑页                  | **auto-disable**：GitLab 对连续失败的 hook 自动禁用（4xx 永久、5xx 退避）。平台侧已把可忽略情形一律 200 规避；若仍发生，在 GitLab 重新启用并排根因 |

## 4. 恢复语义（重要）

- **自建 GitLab 对失败投递不自动重试**，只有 Recent Deliveries 里的手工
  Resend。平台侧的**重放**（投递历史页）是主恢复路径：验签失败的投递不可
  重放（先修 Secret 再 Resend）；重放新建投递行并绕过去重。
- 投递原始 body 默认保留 30 天（之后清空，重放不可用）、行默认保留 90 天。
  RFC-261 起两者在 设置 → GC 可配（1–3650 天，body ≤ 行，改动免重启热生效）；
  高流量部署（10 万投递/天量级）建议按磁盘预算调小 body 保留。
- 投递历史页支持按状态 / 事件类型 / 仓库过滤 + 页码分页（每页 50 条，总数
  实时显示）；仓库下拉列出保留窗内出现过的仓库。
- **终态工作区即时清理（RFC-300，默认关闭）**：设置 → GC 的「Webhook 任务完成或
  取消后清理工作区」只影响开关开启后新进入 `done` / `canceled` 的直接 Webhook
  根任务。事件仓模式会删除该任务的 linked worktree 与 snapshot refs；临时工作区模式
  会递归删除整座 scratch Git 仓库。`failed` / `interrupted`、普通任务、继承子任务与
  开启前已经终态的历史任务仍保留工作区。开关关闭只阻止未来认领，已经落 durable
  claim 的清理仍会完成；删除失败由 daemon 启动恢复与 GC ticker 续做。
- 开启上述开关前确认能力影响：任务行、日志、会话、node run 与已持久化/归档结果仍在，
  但被删任务的 live 文件、diff、节点 retry 与 workflow sync 不再可用；scratch 中未持久化
  的临时文件以及 linked worktree 的未提交修改无法恢复。若需要继续处理，请新建任务。
- **备份迁移**：webhook Secret 用 `secret.key` 密封，备份包不含该文件——
  restore 到新机后所有端点 Secret 失效，需在 UI 重新生成并重贴 GitLab。

## 5. 安全模型速记

授权主体是**触发器 owner**（建触发器 = 预授权「命中规则的事件以我的身份跑
这个目标」），每次触发都重建 owner 身份并重校验目标权限；GitLab 侧评论者
身份不做平台侧鉴权（内网全员可信，D10）。端点 Secret 面走
`webhook-endpoints:manage`（admin/manager，任何 PAT 拿不到）。

## 6. GitHub 接入（RFC-259）

触发器 / 投递审计 / 熔断 / supersede 与 GitLab 完全同一套；差异只在端点与
GitHub 侧配置。

### 6.1 平台侧

设置 → Webhook → 端点 → 新建，**代码平台选 GitHub**。其余同 §1.1（`publicBaseUrl`
必配；**github.com 的出站 webhook 要求该地址公网可达**——内网 daemon 用隧道转发
（smee.io / `cloudflared` 等，转发必须原样保留 header 与 body 字节，HMAC 按字节
验签）；GHES 内网部署与 GitLab 场景同形，无需公网）。

### 6.2 GitHub 侧

- 单仓：**Repo → Settings → Webhooks → Add webhook**；多仓共用一个 hook：
  **Org → Settings → Webhooks**（免费；对应 GitLab 的 group hook）。
- Payload URL = 平台给的完整 URL；**Content type 必须选 `application/json`**
  （GitHub 默认 form-urlencoded——忘改的症状：投递历史 `ignored(parse-failed)`、
  GitHub Recent Deliveries 显示 400）；Secret 粘贴平台一次性 Secret。
- 事件勾选（Let me select individual events）：Pushes / Pull requests /
  Issue comments / Pull request review comments / Workflow runs。
- 保存后 GitHub 发 `ping`：平台投递历史出现一条 `ignored(unsupported-event)`
  （HTTP 200，GitHub UI 绿勾）即连通。

### 6.3 与 GitLab 的行为差异（运维要点）

- **事件对应**：PR ↔ MR（同一套内部事件类型）；GitHub Actions run 完成后按
  conclusion 归 `pipeline_failed`（含 `timed_out`——GitLab 把超时判 failed，语义
  对齐）/ `pipeline_succeeded`；tag push 是 push 事件的 `refs/tags/` 前缀。
- **流水线事件基数（重要）**：GitLab 每 commit 一条 pipeline 事件；GitHub 是
  **每条 workflow 一个 run 事件**——一次 push 跑 N 条 workflow 就到达 N 个
  completed。同 commit 的兄弟 workflow 失败会落同一流：互相 supersede（后到的
  失败取消上一条刚起的修复任务重新起）、熔断计数按 push×N 消耗（bot 迭代
  约 ⌈上限/N⌉ 轮即跳闸）。**多 workflow 仓建议只让一条主 CI workflow 参与
  修到绿**（合并成一条聚合 workflow，或按需上调触发器的连续触发上限）。
- **评论指令的分支限制**：PR **普通评论**（issue_comment）的 payload 不含分支
  （零平台 API 拿不到）→ 该类事件不带源/目标分支——**评论指令触发器要罩
  GitHub 普通评论就把分支过滤留空**。事件仓模式下，目标**不含 git 输入映射**
  （agent / workgroup / 纯 text 输入的 workflow）时任务跑在仓库**默认分支**；
  临时工作区模式始终从空仓开始。无论选择哪种空间，目标 workflow 带**「分支
  来自事件」的 git 输入映射**时该组合都**必然 launch-failed**（代包渲染出空
  分支，保存期彩排拦不住）——这类触发器不要勾 GitHub 普通评论事件。要让指令
  带上 PR 源分支上下文，用
  **diff 行内评论**（Files changed 页上的 review comment），其 payload 带完整
  PR 对象。
- **fork PR**：workflow_run 的 `pull_requests` 为空 → 修到绿循环按分支维度
  串流，且修复产出 push 不进 fork 仓——**不建议对 fork PR 接修到绿**。
- **Redeliver**：GitHub 的 Redeliver 复用同一 `X-GitHub-Delivery` → 平台按去重
  bump、不重复分发（与 GitLab Resend 同语义）；失败投递 GitHub 同样**不自动
  重试**，恢复主路径仍是平台投递历史页的重放按钮。
- **bot 凭据**：修复 push 回 PR 源分支需要 daemon 宿主机 git 凭据对 GitHub 仓库
  有写权限（bot 账号 PAT 配 credential helper，或机器 ssh key）；bot username
  照 §1.3 填进触发器忽略名单（pipeline 类事件不受名单过滤的语义相同）。

### 6.4 排障补充（对照 §3）

| 现象                                                              | 看哪里                                   | 处置                                                                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Recent Deliveries 红 401                                   | 平台投递历史 `rejected(invalid-token)`   | Secret 不一致：平台轮换后重贴 GitHub                                                                                                                                          |
| 投递历史 `ignored(parse-failed)` + GitHub 显示 400                | ——                                       | **Content type 是 form-urlencoded**，改成 application/json                                                                                                                    |
| 事件到了但没起任务                                                | `ignored(no-trigger-matched)`            | 规则没罩住该仓（GitHub 的 repo path 是 `owner/repo` 形态）/事件类型/分支                                                                                                      |
| 评论指令没触发且触发器带分支过滤                                  | 触发器规则                               | 普通 PR 评论无目标分支（§6.3）：分支过滤留空或改用行内评论                                                                                                                    |
| 普通 PR 评论触发后 fire 显示 `launch-failed`（git-value-invalid） | 触发器 → 触发记录                        | 目标 workflow 带「分支来自事件」映射而普通评论无分支（§6.3 必败组合）：改用行内评论或换无 git 映射的目标                                                                      |
| GitHub Recent Deliveries 显 413                                   | ——                                       | 批量 push 超平台 1 MiB body 上限被拒（GitHub 不重试，该事件丢失）；GitHub push 的 commits 数组可达千级，远超 GitLab 的 20 条。罕见；频繁出现请开 issue 评估 per-provider 上限 |
| 修到绿频繁跳闸熔断                                                | 触发器 → 触发记录 `skipped-circuit-open` | 多 workflow 仓的事件基数放大（§6.3）：收敛到单条主 CI workflow 或上调连续触发上限                                                                                             |

## 7. 事件变量与「回帖 / 调接口」动作对照（RFC-263）

所有会在运行期渲染模板的字段，统一在字段旁提供一个「插入参数」按钮。打开后按
「全局参数 → Trigger → Webhook → 功能分组 → 字段」分类，可搜索字段名、规范 token 或文字解释；
选择后插入当前字段的光标处。页面默认不展开 30 个变量，非 Webhook 作者不会被一整面事件上下文干扰。

Webhook 规则编辑器知道当前选择的事件类型，因此只列这些事件**共同可用**的字段；工作流节点编辑器
无法预知将来由哪条规则启动，所以仍可按需查到完整 Webhook 目录，并明确提示这些值只在 Webhook
启动时提供。每一行都会同时显示可读名、规范 token 与用途说明。

### 7.1 变量速查

**事件上下文**：`event_type` `provider` `repo_path` `repo_http_url` `repo_ssh_url`
`branch` `target_branch` `default_branch` `mr_iid` `mr_title` `commit_sha`
`commit_before` `comment_text` `comment_author` `pipeline_status` `event_json`

**API 定位**：`api_base_url` `project_id` `project_web_url` `repo_owner` `repo_name`
`author_id` `mr_id` `mr_url` `comment_id` `comment_thread_id` `comment_url`
`comment_position_json` `pipeline_id` `pipeline_url`

模板中一律写完整路径 `trigger.webhook.<字段名>`（外层再加双花括号），例如
`{{trigger.webhook.mr_iid}}`。这 30 个字段是冻结的 trigger 运行上下文，不是 workflow
根参数：不要创建同名 workflow `inputs[]`、input 节点或边。规范路径可直接用于 webhook
launch payload、agent `promptTemplate`、call-workgroup `goalTemplate`、review
`commentInjectTemplate` 与 code-host-call 的 preset/custom path/query/body。普通手动启动或定时
启动若引用这些字段，会在任何任务/仓库/HTTP/模型副作用前报 `trigger-context-missing`。

Webhook 直接启动 Agent 时，零输入端口 Agent 编辑的是任务提示模板；声明了兼容文本输入端口的
Agent 则逐端口填写模板，二者严格互斥。上传、路径、signal 或无效端口会在保存前给出阻断说明；
存量孤儿值会保持可见，只有明确执行修复才会删除。

**三个最容易用错的**：

| 变量                | 说明                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mr_iid` vs `mr_id` | **REST 路径一律用 `mr_iid`**（GitLab 的 MR iid / GitHub 的 PR number）。`mr_id` 是全局 id，只在 GraphQL 等少数接口用；拿它去填 `:merge_request_iid` 会 404 或改到别的 MR     |
| `comment_thread_id` | 回复到同一线程用它。GitLab 即 `discussion_id`；GitHub **行内评论**为线程根评论 id（自动处理了 `in_reply_to_id`）；GitHub **普通 PR 评论没有线程 ⇒ 此变量为空**，只能新开一条 |
| `project_id`        | 只用于 GitLab 的 `/projects/:id`。GitHub 侧调接口请用 `repo_owner` + `repo_name`（`project_id` 在 GitHub 是 repository 的数字 id，绝大多数端点用不上）                       |

所有变量在该事件没有对应值时渲染**空串**（例如分支流水线的 `mr_iid`、普通评论的
`comment_position_json`）。触发器保存时会静态校验：引用了所选事件类型不提供的变量
直接 422，不会等到真事件跑起来才发现。

### 7.2 事件 → 之后能跟的动作

| 事件                 | 能跟的动作                                                                     | 主要用到                                                                       |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `note`（MR/PR 评论） | 回复同线程 / 新开评论 / 在 diff 行新建线程 / 编辑删除自己的评论 / resolve 线程 | `comment_thread_id` `comment_id` `comment_position_json` `mr_iid` `project_id` |
| `mr_*`               | 评论 MR / 设 commit status / 打 label / 指派 / merge                           | `mr_iid` `commit_sha` `author_id`                                              |
| `push` `tag_push`    | 设 commit status / 评论 commit / 自动建 MR / 建 release                        | `commit_sha` `commit_before` `branch` `default_branch`                         |
| `pipeline_*`         | 列 job 拉失败日志 / retry / 把结论回帖到 MR / 贴流水线链接                     | `pipeline_id` `pipeline_url` `mr_iid`                                          |

### 7.3 GitLab 样例

回复到评论所在线程（自动回复评论流水线的核心动作）：

```bash
curl -sS -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --data-urlencode "body=审计结论：……" \
  "{{trigger.webhook.api_base_url}}/projects/{{trigger.webhook.project_id}}/merge_requests/{{trigger.webhook.mr_iid}}/discussions/{{trigger.webhook.comment_thread_id}}/notes"
```

在 MR 上新开一条评论 / 在 diff 某一行新建线程：

```bash
curl -sS -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --data-urlencode "body=……" \
  "{{trigger.webhook.api_base_url}}/projects/{{trigger.webhook.project_id}}/merge_requests/{{trigger.webhook.mr_iid}}/notes"

# {{trigger.webhook.comment_position_json}} 的键与 position[...] 参数一一对应，原样回传即可
curl -sS -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg b "……" --argjson p '{{trigger.webhook.comment_position_json}}' '{body:$b, position:$p}')" \
  "{{trigger.webhook.api_base_url}}/projects/{{trigger.webhook.project_id}}/merge_requests/{{trigger.webhook.mr_iid}}/discussions"
```

把结论挂成 commit status / 拉失败 job：

```bash
curl -sS -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "{{trigger.webhook.api_base_url}}/projects/{{trigger.webhook.project_id}}/statuses/{{trigger.webhook.commit_sha}}?state=success&name=aw-audit"

curl -sS -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "{{trigger.webhook.api_base_url}}/projects/{{trigger.webhook.project_id}}/pipelines/{{trigger.webhook.pipeline_id}}/jobs?scope[]=failed"
```

### 7.4 GitHub 样例

```bash
# 行内评论：回复到同一线程
curl -sS -X POST -H "Authorization: Bearer $GITHUB_TOKEN" -H 'Accept: application/vnd.github+json' \
  -d '{"body":"……"}' \
  "{{trigger.webhook.api_base_url}}/repos/{{trigger.webhook.repo_owner}}/{{trigger.webhook.repo_name}}/pulls/{{trigger.webhook.mr_iid}}/comments/{{trigger.webhook.comment_thread_id}}/replies"

# 普通 PR 评论没有线程，只能新开一条
curl -sS -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  -d '{"body":"……"}' \
  "{{trigger.webhook.api_base_url}}/repos/{{trigger.webhook.repo_owner}}/{{trigger.webhook.repo_name}}/issues/{{trigger.webhook.mr_iid}}/comments"

# 新建行内评论：position 包补上 body 即为完整请求体
curl -sS -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  -d "$(jq -n --arg b "……" --argjson p '{{trigger.webhook.comment_position_json}}' '$p + {body:$b}')" \
  "{{trigger.webhook.api_base_url}}/repos/{{trigger.webhook.repo_owner}}/{{trigger.webhook.repo_name}}/pulls/{{trigger.webhook.mr_iid}}/comments"

# commit status / 重跑 workflow
curl -sS -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  -d '{"state":"success","context":"aw-audit"}' \
  "{{trigger.webhook.api_base_url}}/repos/{{trigger.webhook.repo_owner}}/{{trigger.webhook.repo_name}}/statuses/{{trigger.webhook.commit_sha}}"

curl -sS -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  "{{trigger.webhook.api_base_url}}/repos/{{trigger.webhook.repo_owner}}/{{trigger.webhook.repo_name}}/actions/runs/{{trigger.webhook.pipeline_id}}/rerun"
```

### 7.5 凭据：token 怎么到 agent 手里（配置前先读）

参数齐了，但 **token 不会自动出现在 agent 的 shell 里**。三条平台现状：

1. **daemon 的环境变量不转发**：agent 进程的环境是白名单（`LANG` / `LC_*` / `TERM` /
   `TZ` / `*_PROXY` / `GIT_AUTHOR_*` / `GIT_COMMITTER_*`）。在 daemon 上
   `export GITLAB_TOKEN=…` **到不了 agent**。
2. **PATH 也是白名单**：POSIX 上只有 `/usr/bin` 与 `/bin`。`curl`、`python3` 可用；
   **`glab` / `gh` 不可用**（通常装在 `/usr/local/bin`、`/opt/homebrew/bin`）。
3. **网络本身不受限**：沙箱默认不拦截出站，`curl` 打得出去。

**回帖 / 调接口的推荐做法是让平台代发，而不是把 token 交给 agent**：在设置页
「代码平台」分区配好 GitLab / GitHub 的 base URL 与令牌，然后在工作流里放一个
**代码平台调用节点**（RFC-269）。节点里可以直接引用
`{{trigger.webhook.mr_iid}}` / `{{trigger.webhook.comment_thread_id}}` 等本节列出的变量，
无需为每个参数接一条 input 连线。
令牌只留在 daemon 进程里，不进 agent 环境、不进提示词、不进模型上下文 —— 上面三条
平台现状因此**一条都不需要松动**。

如果确实需要 agent **自己**调 API（而不是平台代发），仍然只有两条路：

- **remote MCP（推荐）**：配一个远端 MCP server，token 放在它的请求 header 里，agent
  通过 MCP 工具回帖。token 不进提示词、不进数据库。（本地 MCP 走无网络子边界，用不了。）
- **写进触发器模板 / 提示词**：可行但 token 会落进数据库、任务日志和模型上下文，**不推荐**。

（「在 daemon 上配一个环境变量、agent 的 curl 直接能用」曾排期为 RFC-265，已由
RFC-269 的平台侧出站取代，不再计划实现。）

## 8. 任务详情的原始事件入口（RFC-298）

Webhook 启动的任务会在详情页标题下方、任务 ID 后显示一个文字链接，例如
「查看原始评论」。界面不会直接铺出 URL；文案表示**最终实际打开的对象**，所以评论地址
缺失并退到 MR/PR 时会写「查看原始 MR/PR」，不会继续误写成评论。

| 事件类型        | 选择顺序                    |
| --------------- | --------------------------- |
| `note`          | 评论 → MR/PR → 项目         |
| `mr_*`          | MR/PR → 项目                |
| `pipeline_*`    | 流水线 → MR/PR → 项目       |
| `push/tag_push` | GitHub/GitLab 提交页 → 项目 |

链接只从任务已经冻结的 `trigger.webhook.*` 上下文派生，不回查 webhook trigger、delivery
或代码平台 API。调用节点创建并继承该上下文的子任务也显示同一个入口，即使原 trigger/delivery
之后被删除仍不受影响。

安全边界：只接受有 host、无内嵌用户名/密码的 `http`/`https` 地址；坏候选会继续下一层，
全部不可用时连分隔点和占位文字都不显示。push/tag 的提交 SHA 必须是 7–64 位十六进制且
不能是全零删除 sentinel，否则退到项目页。链接在新窗口打开并带
`rel="noopener noreferrer"`。
