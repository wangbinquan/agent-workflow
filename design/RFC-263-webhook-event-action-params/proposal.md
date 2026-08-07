# RFC-263 · Webhook 事件参数补齐（按「事件之后能跟的动作」反推）

状态：**用户已批准（2026-08-07），实现中**（用户同批拍板：token 通道另立 RFC 排期（编号 RFC-265——RFC-264 已被并发的「资源名支持中文」占用），见 §9；设计门跳过，实现门按仓规仍跑）。前置：[RFC-257](../RFC-257-code-host-webhook-triggers/proposal.md)（触发器与归一化信封）、[RFC-259](../RFC-259-github-webhook-adapter/proposal.md)（GitHub adapter）。

## 1. 背景

用户原话：

> 在每个 webhook 的事件里，要把必要参数都提取出来啊，比如 MR 评论里，projectid、mrid、
> discussionid 这种参数，要给出来啊，不然我想要做一个自动回复评论的流水线，都没参数可用

核实结论——属实。当前归一化信封 `CodeHostEventSchema`（`packages/shared/src/schemas/webhook.ts:57-79`）与模板变量表（同文件 `:109-123`）一共只有 13 个变量：

```
event_type repo_path repo_http_url repo_ssh_url branch target_branch
mr_iid mr_title commit_sha comment_text comment_author pipeline_status event_json
```

两个 adapter **读到了 payload 却没往外传**的定位参数（都落在 `raw` 里）。下表行号是
**本 RFC 落档时（实现前）**的位置，实现后这些文件已扩写，按符号名检索为准：

| 平台 | 已丢弃的字段 | 代码位置 |
|---|---|---|
| GitLab | `project.id` / `project.web_url` / `project.default_branch` | `services/webhook/gitlabAdapter.ts:64-74`（`parseProject` 只取 3 个字段） |
| GitLab | `object_attributes.discussion_id` / `.id` / `.position` / `.url`（note） | `gitlabAdapter.ts:190-217` |
| GitLab | `object_attributes.id` / `.url`（MR、pipeline）、`merge_request.id` | `gitlabAdapter.ts:76-96、148-253` |
| GitLab | `user.id` / 顶层 `user_id` | `gitlabAdapter.ts:98-105` |
| GitHub | `repository.id` / `.owner.login` / `.name` / `.html_url` / `.default_branch` | `githubAdapter.ts:70-80` |
| GitHub | `comment.id` / `.html_url` / `.in_reply_to_id` / `.path` / `.line` / `.side` / `.commit_id` | `githubAdapter.ts:213-284` |
| GitHub | `pull_request.id` / `.html_url`、`workflow_run.id` / `.html_url` | `githubAdapter.ts:88-109、286-339` |

唯一兜底是 `{{event_json}}`，它有三个不能当契约用的缺陷：**①32 KiB 截断**（`shared/webhookTemplate.ts:22`，大 push / 大 MR payload 会被切在半路）；**②要求 agent 自己解析原始 JSON**——两个平台字段路径完全不同，等于把 provider 差异推给提示词作者；**③保存期无法静态校验**——写错路径要等真事件跑起来才发现。

**结论**：能不能回复一条 MR 评论，今天卡在平台没给参数。`discussion_id` 没有任何替代路径（`repo_path` URL-encode 后勉强能顶 GitLab 的 `:id`，但线程 id 无处可得）。

## 2. 目标 / 非目标

### 目标

- **G1 按「事件之后能跟的动作」反推字段集**（用户拍板的方法论）：不是「把 payload 里的 id 都抄一遍」，而是先列每类事件之后现实存在的后续动作（回复评论 / 新建行内评论 / resolve 线程 / 设 commit status / retry 流水线 / 拉 job 日志 / 建 MR…），再取这些动作的 API 必需参数的并集。§3 是该矩阵。
- **G2 全部 9 类事件一次补齐**（用户拍板），不做「先补评论、其余以后再说」。
- **G3 一等变量为主**：provider 无关命名、进保存期静态校验矩阵、UI 可点击插入、agent 侧零解析。
- **G4 行内评论位置打包成 `{{comment_position_json}}`**（用户拍板），且**原样可回传**给对应平台的建评论 API。
- **G5 文档给出「事件 → 可跟动作 → 用哪些变量 → 可直接跑的 curl」对照表**，两个平台各一套。

### 非目标

- **N1 平台侧出站回写**（RFC-257 design §12 预留的 `ReportSink`）。用户拍板：只给参数，回帖动作由 workflow 里的 agent 自己完成。
- **N2 平台托管代码平台 API token**。凭据面现状见 §6，本 RFC 不新增凭据通道。
- **N3 向 provider 反查 API 补字段**。RFC-257 D3「零平台 API」不破：**只从 payload 里已有的字节提取**。payload 没有的（如 GitHub 普通 PR 评论的分支）继续缺省，不去调 API 补。
- **N4 扩大事件覆盖面**。note 仍只处理 MR/PR 评论（Issue 评论、commit 评论仍是 `unsupported-event`）；不新增事件类型。
- **N5 归一化 job / build 级参数**。GitLab pipeline 事件带 `builds[]`（多个 job），GitHub `workflow_run` 完全不带 job——两边不对称，强行归一化会造出一个在 GitHub 上恒空的变量。改为提供 `{{pipeline_id}}`，文档指引用它调 jobs 列表 API（两边对称：GitLab `/projects/:id/pipelines/:pipeline_id/jobs`、GitHub `/repos/{o}/{r}/actions/runs/{run_id}/jobs`）。

## 3. 动作矩阵（本 RFC 的推导依据）

外部依据均为 2026-08-07 查证：GitLab `lib/gitlab/hook_data/note_builder.rb` 的 `SAFE_HOOK_ATTRIBUTES`（确认含 `discussion_id` / `position` / `line_code` / `noteable_id` / `project_id` / `id`；`url` 经 `.merge()` 加入）、GitLab Discussions API 文档、GitHub REST `pulls/comments` 与 `commits/statuses` 文档、`octokit/webhooks` 的 `common/pull-request-review-comment.schema.json`。

| 事件 | 之后能跟的动作 | API | 必需参数 | 今天缺 |
|---|---|---|---|---|
| **note**（MR/PR 评论） | **回复到同一线程** | GL `POST /projects/:id/merge_requests/:iid/discussions/:discussion_id/notes`<br>GH `POST /repos/{o}/{r}/pulls/{n}/comments/{comment_id}/replies` | project_id、mr_iid、**discussion_id**／owner、repo、pr_number、**comment_id** | ✅ 全缺 |
| note | 在 MR 上新开一条评论 | GL `POST .../merge_requests/:iid/notes`<br>GH `POST .../issues/{n}/comments` | project_id、mr_iid | ✅ project_id |
| note | 在 diff 某一行新建线程 | GL `POST .../discussions` + `position[...]`<br>GH `POST .../pulls/{n}/comments`（commit_id+path+line 必需） | position 全套 / commit_id·path·line·side | ✅ 全缺 |
| note | 编辑 / 删除自己发的评论、加 emoji | GL `PUT .../notes/:note_id`<br>GH `PATCH .../pulls/comments/{id}` | note/comment id | ✅ 缺 |
| note | resolve 线程 | GL `PUT .../discussions/:discussion_id`（`resolved=true`） | discussion_id | ✅ 缺 |
| note | 回帖里贴回原评论链接 | — | comment 的 web url | ✅ 缺 |
| **mr_opened/updated/merged/closed** | 评论 MR / 提审阅意见 | 同上 notes API | project_id、mr_iid | ✅ project_id |
| mr_* | 把审计结论挂成 commit status | GL `POST /projects/:id/statuses/:sha`<br>GH `POST /repos/{o}/{r}/statuses/{sha}` | project_id·sha / owner·repo·sha | ✅ project_id、owner/repo |
| mr_* | 打 label / 指派 / approve / merge | GL `PUT .../merge_requests/:iid` 等 | project_id、mr_iid、（指派用 user id） | ✅ project_id、author_id |
| mr_* | 回帖里贴 MR 链接、按 global id 走 GraphQL | — | mr 的 web url、mr global id | ✅ 缺 |
| **push / tag_push** | 设 commit status | 同上 statuses | project_id、sha | ✅ project_id |
| push | 对本次推送的改动范围做评论 / 比对 | — | before sha（与已有 `commit_sha`=after 配对） | ✅ before |
| push | 自动建 MR | GL `POST /projects/:id/merge_requests`<br>GH `POST .../pulls` | project_id、source branch、**默认分支**作 target | ✅ project_id、default_branch |
| tag_push | 建 release | GL `POST /projects/:id/releases` | project_id、tag（= 已有 `branch`） | ✅ project_id |
| **pipeline_failed / succeeded** | 拉失败 job 日志定位原因 | GL `/projects/:id/pipelines/:pid/jobs` → `/jobs/:job_id/trace`<br>GH `/actions/runs/{run_id}/jobs` → logs | project_id、**pipeline/run id** | ✅ 全缺 |
| pipeline_* | retry / cancel | GL `POST .../pipelines/:pid/retry`<br>GH `POST .../actions/runs/{run_id}/rerun` | pipeline/run id | ✅ 缺 |
| pipeline_* | 把失败结论回帖到 MR | 同 notes API | project_id、mr_iid | ✅ project_id |
| pipeline_* | 回帖里贴流水线链接 | — | pipeline web url | ✅ 缺 |
| **全部事件** | 任何 API 调用都要知道打给谁、打到哪个实例 | — | **provider 判别**、**API base URL**（自建 GitLab / GHES 各不同） | ✅ 全缺 |

## 4. 交付物：17 个新变量

| 变量 | 语义 | 服务的动作 |
|---|---|---|
| `{{provider}}` | `gitlab` \| `github` | 提示词里分支判断；决定 position JSON 形态 |
| `{{api_base_url}}` | GL `https://实例/api/v4`；GH `https://api.github.com` 或 GHES `https://实例/api/v3` | 所有 API 调用 |
| `{{project_id}}` | GL `project.id`（填进 `/projects/:id`）；GH `repository.id` | GitLab 全部 API |
| `{{repo_owner}}` / `{{repo_name}}` | GH `{owner}` / `{repo}` 路径段；GL 为 namespace / project path | GitHub 全部 API |
| `{{project_web_url}}` | 仓库网页地址 | 贴链接；自行拼 base |
| `{{default_branch}}` | 仓库默认分支 | 建 MR 的 target |
| `{{author_id}}` | 事件作者的平台用户 id | 指派 / 审计 |
| `{{mr_id}}` | MR/PR 的 **global id**（区别于已有 `mr_iid`） | GraphQL、少数按 global id 的 API |
| `{{mr_url}}` | MR/PR 网页地址 | 贴链接 |
| `{{comment_id}}` | 评论本体 id | 编辑 / 删除 / emoji；GitHub 的回复端点 |
| `{{comment_thread_id}}` | **线程 id**：GL = `discussion_id`；GH = `in_reply_to_id ?? comment.id`（行内评论），普通 PR 评论无线程 → 空 | **回复到同一线程**（核心诉求） |
| `{{comment_url}}` | 评论网页地址 | 贴链接 |
| `{{comment_position_json}}` | 行内评论位置，**原样可回传**给该平台的建评论 API（形状见 design §5） | 在具体某一行新建线程 |
| `{{pipeline_id}}` | GL pipeline id；GH workflow run id | retry / 列 jobs / 拉日志 |
| `{{pipeline_url}}` | 流水线网页地址 | 贴链接 |
| `{{commit_before}}` | push 的前一个 sha（与 `commit_sha` = after 配对） | 比对本次推送范围 |

命名说明（三处刻意不跟平台字面走）：

- **`project_id` 不叫 `repo_id`**——这个值的主要用途就是填进 GitLab 的 `/projects/:id`，贴用途比贴 `repo_*` 前缀族更少误导；GitHub 侧调 API 用 `repo_owner`/`repo_name`，那两个才跟 `repo_*` 族一致。
- **`comment_thread_id` 不叫 `discussion_id`**——GitHub 有一个叫 **Discussions** 的独立产品功能，同名变量会让 GitHub 用户以为在指那个。文档与 UI 提示里显式写「GitLab 即 `discussion_id`」。
- **`mr_id` 与既有 `mr_iid` 并存**——GitLab 的 REST 路径几乎都用 `iid`，global `id` 只在 GraphQL 和少数端点用；两个都给并在文档里写清楚「REST 用 `mr_iid`」，避免用户拿 global id 去填 `:merge_request_iid`（会 404 或改错 MR）。

## 5. 用户故事与验收标准

**US-1（核心）**：开发者在 MR 里评论 `@aw 帮我看下这个函数`，触发器命中 → workflow 跑完 → agent 用 `{{api_base_url}}/projects/{{project_id}}/merge_requests/{{mr_iid}}/discussions/{{comment_thread_id}}/notes` 把结论回复到**同一条线程**下。

**US-2**：CI 挂了 → `pipeline_failed` 触发 → agent 用 `{{pipeline_id}}` 拉失败 job 日志 → 修完 push → 用 `{{project_id}}` + `{{commit_sha}}` 打一条 commit status。

**US-3**：审阅 agent 对 MR 的具体某一行提意见 → 用 `{{comment_position_json}}` 原样回传新建一条 diff 行内线程。

- **AC-1** 17 个新变量全部进 `WEBHOOK_TEMPLATE_VARS` 与 `WEBHOOK_EVENT_VAR_MATRIX`，保存期静态校验对「事件类型不提供该变量」如实拒绝。
- **AC-2** GitLab note 事件的 `comment_thread_id` = payload 的 `object_attributes.discussion_id`；GitHub 行内评论 = `in_reply_to_id ?? comment.id`；GitHub 普通 PR 评论 = 空串（不编造）。
- **AC-3** `{{api_base_url}}` 对四种形态正确：github.com、GHES、根路径自建 GitLab、**子路径部署的 GitLab**（`https://host/gitlab/...`）；推导不出时渲染空串而非猜测。
- **AC-4** `{{comment_position_json}}` 在 GitLab 侧是 `object_attributes.position` 的原样 JSON（键名与 `position[...]` API 参数一一对应）；GitHub 侧是 `{path,line,side,start_line,start_side,commit_id}`（键名与建评论 API 参数一一对应）；非行内评论渲染空串。
- **AC-5** 所有新变量在缺值时渲染**空串**，不渲染 `undefined` / `null` 字面量。
- **AC-6** 旧触发器零影响：不引用新变量的既有 `launch_payload` 渲染结果逐字节不变。
- **AC-7** 旧投递 replay（`routes/webhookDeliveries.ts:215` 重新 normalize）能提取出新字段——只要 `body_json` 还在保留窗口内。
- **AC-8** 前端变量 chips 分组展示（基础上下文 / API 定位），每个变量带说明 tooltip；28 个变量不挤成一坨。
- **AC-9** `docs/webhook-triggers.md` 有事件→动作→变量→curl 对照表，GitLab / GitHub 各一套可直接抄的回帖样例。
- **AC-10** 无数据库迁移：`CodeHostEvent` 是运行时构造物，不落库（落库的是 `body_json` 原文 + 摘要列）。

## 6. 凭据通道现状（必须先让用户知道的一条）

用户 Q4 拍板「只给参数，agent 自己调 API」。**参数给了，但今天的受控执行面里 agent 拿不到 token**——这是实现前必须摆上台面的事实：

1. **daemon 环境变量到不了 agent**。OpenCode 进程的环境是**白名单转发**：`SAFE_FORWARD_ENV`（`services/runtime/opencode/hermetic.ts:93-109`）只有 `LANG / LC_* / TERM / TZ / *_PROXY / GIT_AUTHOR_* / GIT_COMMITTER_*` 共 14 项，逐项 copy（同文件 `:637-639`）。在 daemon 上 `export GITLAB_TOKEN=...` **不会**出现在 agent 的 shell 里。
2. **PATH 也是白名单**：POSIX 上只有 `/usr/bin` + `/bin`（`util/platformExec.ts:156-168`）。`curl` / `python3` 在（自带），**`glab` / `gh` 不在**（通常装在 `/usr/local/bin`、`/opt/homebrew/bin`）。
3. **网络本身是通的**：outer sandbox 从不限制网络（`services/sandbox/policy.ts:49-56` 明载 `networkDeny` 默认 off，只有显式声明无网的节点才关）。所以 `curl` 打得出去。

于是今天可行的 token 路径只有两条：

- **(a) remote MCP**：远端 MCP 的 `headers` 是受支持的配置字段（`shared/schemas/mcp.ts:133`），token 放 header，agent 通过 MCP 工具回帖。**这是目前唯一干净的路径**（local MCP 走无网子边界，不能用）。
- **(b) 把 token 写进触发器模板 / agent 提示词**：可行但 token 会进数据库、进任务日志、进模型上下文，安全上很差，不推荐。

**本 RFC 不解决这个**（N2）。如果希望「daemon 上配一个 token 环境变量，agent 的 curl 直接能用」，那是对受控执行面白名单的扩张（RFC-224/251 的边界），按 CLAUDE.md 第 7 条属于要单独立 RFC + 逐项呈报的改动。§9 把它记为后续项，`docs/webhook-triggers.md` 会写清这三条现状，避免用户按「参数齐了就能跑」的预期去配置然后撞墙。

## 7. 能力影响清单

本 RFC **不关闭任何既有能力**（CLAUDE.md 第 7 条的门槛不触发），但仍逐项列出新增面的代价：

- **C1 提示词里可注入的字段变多**：新变量的值全部来自 payload，而 payload 原文本来就能通过 `{{event_json}}` 整体注入——**没有任何字段是本 RFC 新暴露给模型的**，只是从「32 KiB 截断的原始 JSON」变成「精确取值」。
- **C2 变量表 13 → 30**：模板作者要面对更长的变量列表。缓解 = UI 分组 + tooltip 说明 + 文档对照表（AC-8/AC-9）。
- **C3 `api_base_url` 是推导值不是原文**：推导规则写在 design §4，失败时渲染空串并在文档里指明兜底（用 `{{project_web_url}}` 自己拼）。误推导的后果是 agent 打错端点拿 404，不会写坏数据。
- **C4 更长的 payload 解析面**：adapter 多读十几个字段，任何一个类型不符都不能让整条投递变成 `parse-failed`——design §2/§3 规定新字段一律**软提取**（缺失/类型不符 → undefined → 空串），只有既有的必填字段仍维持硬校验。

## 8. 待实证清单（fixtures）

沿 RFC-257/259 惯例，以下按官方文档/源码形态实现，真实投递到手后以 fixture 为准回改：

1. GitLab note 的 `object_attributes.discussion_id` 在**部署侧 GitLab 版本**上确实存在且非空（源码级已确认在 `SAFE_HOOK_ATTRIBUTES` 内）。
2. GitLab note 的 `object_attributes.position` 在 DiffNote 上的完整键集（尤其 `line_range` 多行评论形态）。
3. GitLab pipeline 事件的 `object_attributes.url` 与 `merge_request.url` 是否稳定填充。
4. GitHub GHES 的 `repository.html_url` 主机名与 API base 的对应（`https://host/api/v3`）。
5. GitHub `issue_comment` 的 `comment.in_reply_to_id` 恒不存在（普通评论无线程），确认 `comment_thread_id` 空串是正确表达而非提取遗漏。
6. 子路径部署的 GitLab（`https://host/gitlab/group/repo`）的 `project.web_url` 形态。

## 9. 后续演进（非本 RFC）

- **RFC-265（已排期——用户 2026-08-07 拍板从本 RFC 拆出；编号避开并发占用的 RFC-264）**：受控执行面的**自定义环境变量注入通道**，让 token 能到达 agent 的 shell（§6）。它触及 RFC-224/251 的密封边界（`SAFE_FORWARD_ENV` 白名单是那两个 RFC 的承重结构），需要独立设计 + 按 CLAUDE.md 第 7 条逐项呈报能力影响，不塞进本 RFC。**在该 RFC 落地前，回帖动作的 token 走 remote MCP headers**（proposal §6 路径 a）。
- 平台侧出站回写 `ReportSink`（RFC-257 design §12）。
- note 事件扩到 Issue 评论 / commit 评论。
- GitLab `builds[]` 的 job 级归一化（若将来 GitHub 侧出现对称信息）。
