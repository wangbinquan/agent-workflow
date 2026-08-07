# 代码平台调用节点（RFC-269）

工作流里的**代码平台调用节点**用管理员配置的凭据直接调 GitLab / GitHub API：回帖、设
commit status、触发流水线、拉 job 日志……**令牌只留在 daemon 进程里**，不进 agent 进程，
也不进模型上下文。

配套阅读：[webhook-triggers.md](./webhook-triggers.md)（入站事件与 `{{trigger.*}}` 变量来源）。

## 1. 配置凭据（管理员）

设置页 → **代码平台**，两家各一组：

| 平台   | API 根地址                                                           | 令牌类型                                                   |
| ------ | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| GitLab | `https://gitlab.example.com/api/v4`（子路径部署也以 `/api/v4` 结尾） | Personal / Project / Group access token（`PRIVATE-TOKEN`） |
| GitHub | `https://api.github.com`；GHES 用 `https://host/api/v3`              | PAT（`Authorization: Bearer`）                             |

- 只配一家也能用，另一家的动作在节点里会提示未配置。
- **建议用专用 bot 账号 + 最小权限**：GitLab 勾 `api`（或更细的 project access token）；
  GitHub 用 fine-grained PAT，按仓库限定 Pull requests / Commit statuses 权限。
- 保存后点**测试连接**。失败原因是可区分的：令牌无效 / 地址不是 API 根 / 网络不通 /
  响应不是身份信息（通常是被反代拦到了登录页）。
- 令牌加密存储（`secretBox`，与 webhook 验签 secret 同一把 `~/.agent-workflow/secret.key`）。
  读取时只显示尾号。**丢失 `secret.key` 后需要重录令牌**。
- 只改 API 根地址时令牌留空即可，不必重录。清除整套凭据用「删除」按钮。

## 2. 谁能用

- **配置凭据**：admin（设置页权限）。
- **在工作流里放这个节点**：需要 `code-host-calls:author`，默认 **admin + manager**。
  这个点**永不进 PAT / MCP 令牌** —— 一枚勾满了所有矩阵权限的令牌也写不了这类节点。
- 普通用户可以运行含该节点的工作流，但**看不到也改不了**节点参数（RFC-270，2026-08-08）：
  `GET /api/workflows/:id`、任务快照与 YAML 导出对无该权限的调用方一律把 `params` /
  `request.path` / `request.body` / `request.query` 的**值**遮成 `***`（键与 `provider` /
  `action` / `method` 保留，图仍然可读），Inspector 换成「无权限查看」占位；保存时服务端
  再用库里的值回填这些字段，所以普通用户编辑同一份工作流的其它部分不会把它们抹掉。

理由：这个节点携带的是管理员令牌的写权限，而平台侧的资源 ACL 约束不了它能碰到的仓库
（权限在代码平台那边，不在这里）。

## 3. 内置动作

按类别分组，选中平台后不支持的动作会置灰并说明原因。

| 类别    | 动作                                                                                      |
| ------- | ----------------------------------------------------------------------------------------- |
| 评论    | 回复评论线程 / 在 MR·PR 上新开评论 / 在 diff 行新建线程 / 编辑自己发的评论 / resolve 线程 |
| MR 状态 | 设 commit status / 打 label / 指派 / 批准 / 合并 / 创建 MR·PR                             |
| 流水线  | 触发 / 重跑失败作业 / 取消 / 列出作业 / 拉取作业日志                                      |
| 读取    | 拉 MR·PR diff / 列出 MR·PR / 读仓库文件                                                   |
| 自定义  | 任意 method + 相对路径 + JSON body                                                        |

**两边不对称、需要知道的几处**：

- **resolve 线程在 GitHub 上不可用**：REST 面没有这个端点（只有 GraphQL），而且线程的
  `PRRT_` id 在 REST 里根本拿不到。
- **触发流水线**：GitHub 走 `workflow_dispatch`，**必须**指定工作流文件名（如 `ci.yml`）；
  GitLab 不需要这个字段，所以它只对 GitHub 显示。
- **列出作业的过滤**：GitLab 按作业状态（failed / success…），GitHub 只能选「最后一次尝试 /
  全部」。两个独立字段，各自只对自家显示。
- **指派**：GitLab 要用户**数字 id**，GitHub 要 **login**。同一个字段、不同含义。
- **commit status 的状态**只有三档 `进行中 / 通过 / 不通过`，平台各自映射（GitHub 用
  `failure` 而不是 `failed`）。

## 4. 参数从哪来

节点的每个字段都是模板，两个命名空间：

- `{{端口名}}` —— 上游节点的输出（连线后可用，与 agent 提示词模板同一套机制）。
- `{{trigger.xxx}}` —— webhook 触发上下文，共 29 个变量（`{{trigger.mr_iid}}`、
  `{{trigger.project_id}}`、`{{trigger.comment_thread_id}}`…完整清单见 Inspector 里的变量
  区，语义见 [webhook-triggers.md](./webhook-triggers.md) §7.1）。**手动启动的任务没有触发
  上下文**，这时引用它们会明确报错而不是发一个空参数出去。

**项目字段留空 = 用当前任务的仓库**。仓库不属于所配置的平台实例时会明确拒绝（不会拿去改一个
同名的、不相干的项目）；多仓任务必须显式填写。

## 5. 输出与失败

- 两个固定输出端口：`response`（响应体原文）与 `status`（HTTP 状态码）。都可以不连。
- 响应体超过 256 KiB 会截断，并在尾部留下显式标记 —— 不会静默截断。
- **非 2xx 即节点失败**（与脚本节点非零退出码同档）。可以单节点重试。
- 自动重试是**按幂等分档**的：429 一律重试；5xx 与网络错误只对 GET/PUT/PATCH/DELETE 重试，
  **POST 不自动重试** —— 重发一次评论就是第二条评论。
- 平台**不跟随跨主机重定向**（唯一例外是 GitHub 拉作业日志，它会 302 到签名 URL；跟随时
  平台会剥掉认证头）。

## 6. 自定义请求

覆盖内置清单以外的端点：

- 路径必须是**相对路径**（拼在所配 API 根之后），不能是绝对 URL，不能含 `..`。
- 方法默认只有 GET/POST/PUT/PATCH；**DELETE 要在节点上显式勾选「允许破坏性方法」**。
- body 是 JSON 模板，**变量只能写在 JSON 字符串里**（`{"body": "{{结论}}"}` 可以，
  `{"n": {{数量}}}` 会在保存时被拒）。这条规则保证上游内容改不了请求结构 —— 上游往往是模型
  写的，一个能改结构的值等于让模型替你决定调用了什么。

## 7. 常见问题

| 现象                                   | 多半是                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| 节点报 `code-host-not-configured`      | 设置页没配那家的 base URL / 令牌，或 `secret.key` 换过导致解封失败（重录令牌） |
| 报 `code-host-project-foreign`         | 任务仓库不在所配置的实例上；显式填项目字段，或改配置                           |
| 报 `code-host-trigger-context-missing` | 工作流引用了 `{{trigger.*}}`，但这个任务不是 webhook 起的                      |
| 回帖 403                               | 令牌 scope 不够，或 bot 账号在那个项目上没有权限                               |
| 回帖发了两条                           | 检查是否在 `wrapper-loop` 里（挪进循环会按迭代次数重复发送）                   |
| 测试连接报「响应不是身份信息」         | base URL 指到了反代的登录页，而不是 API 根                                     |
