# 代码平台调用节点（RFC-269）

工作流里的**代码平台调用节点**用管理员配置的凭据直接调 GitLab / GitHub API：回帖、设
commit status、触发流水线、拉 job 日志……**令牌只留在 daemon 进程里**，不进 agent 进程，
也不进模型上下文。

配套阅读：[webhook-triggers.md](./webhook-triggers.md)（入站事件与
`{{trigger.webhook.*}}` 变量来源）以及
[代码提交身份与推送凭据](./code-host-push-credentials.md)（个人优先 Git publication 与
SSH→HTTP(S) 解析）。

## 1. 配置凭据（管理员）

设置页 → **代码平台**，两家各一组：

| 平台   | API 根地址                                                           | 令牌类型                                                   |
| ------ | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| GitLab | `https://gitlab.example.com/api/v4`（子路径部署也以 `/api/v4` 结尾） | Personal / Project / Group access token（`PRIVATE-TOKEN`） |
| GitHub | `https://api.github.com`；GHES 用 `https://host/api/v3`              | PAT（`Authorization: Bearer`）                             |

- 只配一家也能用，另一家的动作在节点里会提示未配置。
- **建议用专用 bot 账号 + 最小权限**：GitLab 勾 `api`（或更细的 project access token）；
  GitHub 用 fine-grained PAT，按仓库限定 Pull requests / Commit statuses 权限。
- 这份连接 token 同时是 Git publication 在用户没有个人配置时的公共 fallback；若启用自动推送，
  还必须给目标仓库写权限。个人 push token 不接管本页描述的 REST 节点动作。
- 保存后点**测试连接**。失败原因是可区分的：令牌无效 / 地址不是 API 根 / 网络不通 /
  响应不是身份信息（通常是被反代拦到了登录页）。
- GitLab 默认开启“验证 HTTPS 证书”。如果内网 GitLab 的证书链暂时不完整，可以显式关闭；
  平台会仅对这套 GitLab 连接的测试与真实 API 请求设置 `rejectUnauthorized: false`。
  **关闭会跳过对端证书身份校验并降低中间人攻击防护**，应优先修复证书链；GitHub 与第三方
  重定向不继承该例外。
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
- **部署版本兼容**：拉 GitLab MR diff 优先调用 `/diffs`，路由不存在时兼容旧版
  `/changes`；回复 GitHub review comment 优先调用专用 `/replies` 路由，旧版 GHES 没有该
  路由时改用 `in_reply_to` 写法。

## 4. 参数从哪来

节点的每个字段都是模板，两个命名空间：

- `{{端口名}}` —— 上游节点的输出（连线后可用，与 agent 提示词模板同一套机制）。
- `{{trigger.webhook.<field>}}` —— webhook 触发上下文，共 30 个字段（包括
  `{{trigger.webhook.event_type}}`、`{{trigger.webhook.mr_iid}}`、
  `{{trigger.webhook.project_id}}`、`{{trigger.webhook.comment_thread_id}}` 与有 32 KiB
  上限的 `{{trigger.webhook.event_json}}`；完整清单见 Inspector，语义见
  [webhook-triggers.md](./webhook-triggers.md) §7.1）。**手动启动的任务没有触发上下文**，
  这时引用它们会在发 HTTP 请求前明确报 `trigger-context-missing`。

这是 trigger 类型的运行上下文，不是 workflow input。不要为这些字段新建根级 `inputs[]`、
input 节点或搬运边；agent prompt、call-workgroup goal、review comment template 与本节点使用
同一套规范路径。

每个实际会执行的参数、path、query value 与 body 旁都使用同一个「插入参数」选择器；它按
局部/全局、参数类型、来源、功能组和字段分类，并在每一项常显可读名、规范 token 与解释。
枚举字段选择参数时会整体替换当前字面值，关闭下拉后仍显示完整 token；业务枚举列表本身不会
混入伪造的 token 选项。query **key** 是固定结构，不是模板目标，只有 value 有选择器。

切换 action 或 provider 不会静默删除之前填写的 `params` / `request`。当前操作不会执行的存量值
会集中显示为「当前不执行」，不参与当前保存校验或运行期预检；可以切回原操作继续编辑，也可经
二次确认显式清理，清理是一条可撤销的画布历史操作。

若要回退到 RFC-295 之前的版本，必须先在停止回退部署前运行只读兼容性门：

```bash
agent-workflow downgrade-audit rfc-295
```

它会扫描当前 workflow revision，以及仍在运行或可恢复任务的根快照和冻结调用闭包；报告
workflow / revision / task / node / pointer / ref。结果为 `BLOCKED` 时必须在当前版本中显式
清理这些 inactive 值、切回对应 action 修复，或放弃回退继续 roll-forward；命令没有忽略清单或
强制放行参数，也不会修改数据库。

**项目字段留空 = 用当前任务的仓库**。仓库不属于所配置的平台实例时会明确拒绝（不会拿去改一个
同名的、不相干的项目）；多仓任务必须显式填写。

## 5. 输出与失败

- 两个固定输出端口：`response`（响应体原文）与 `status`（HTTP 状态码）。都可以不连。
- 内置动作若有经过核实的兼容写法，只在首选路由返回 **404 / 405** 时尝试下一条。403、422、
  429、5xx 与网络错误不会换路径，避免掩盖权限、参数或服务故障；成功后的 `response` 仍是实际
  命中接口的响应体原文。
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

| 现象                              | 多半是                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------ |
| 节点报 `code-host-not-configured` | 设置页没配那家的 base URL / 令牌，或 `secret.key` 换过导致解封失败（重录令牌） |
| 报 `code-host-project-foreign`    | 任务仓库不在所配置的实例上；显式填项目字段，或改配置                           |
| 报 `trigger-context-missing`      | 工作流引用了 `{{trigger.webhook.*}}`，但这个任务不是 webhook 起的              |
| 回帖 403                          | 令牌 scope 不够，或 bot 账号在那个项目上没有权限                               |
| 回帖发了两条                      | 检查是否在 `wrapper-loop` 里（挪进循环会按迭代次数重复发送）                   |
| 测试连接报「响应不是身份信息」    | base URL 指到了反代的登录页，而不是 API 根                                     |
