# 代码提交身份与推送凭据（RFC-320 / RFC-321）

Agent Workflow 把两件容易混淆的事分开管理：

- **Git 提交身份**决定 commit 里的 `user.name` / `user.email`；任务创建后冻结，不随 token 改变。
- **代码平台推送凭据**决定 GitLab / GitHub 看到的 push 认证账号；只用于平台拥有的 Git 发布。

登录后进入 **我的账号 → 代码提交与推送**，可以在同一页看到两张独立、同宽的卡片，但它们使用
不同 API 与存储合同。校验 token 得到的平台账号不会反写提交姓名或邮箱。

## 1. 管理员先配置公共连接

设置页 → **代码平台**按 provider 配置 API 根地址和公共 token：

| 平台   | API 根地址示例                                          | 公共 token 要求                                                           |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| GitLab | `https://gitlab.example.com/api/v4`                     | REST 动作需要相应 API scope；若要作为 fallback 推送，还要有目标仓库写权限 |
| GitHub | `https://api.github.com`；GHES 为 `https://host/api/v3` | fine-grained PAT 按需授予 REST 与目标仓库 Contents 写权限                 |

公共 token 仍是 MR/PR、评论、审批、流水线等代码平台 REST 调用的唯一业务凭据。个人 token **不会**
接管这些动作，只参与 Git publication 与账号本人主动发起的身份校验。

自建实例若 SSH 与 Web 地址不同，在连接卡片里增加 transport mapping：

```text
SSH host/port/path prefix  →  HTTP(S) base URL
ssh.company.net:22/team    →  https://code.company.net/git/team
```

最长 path prefix 胜出；同长度冲突会拒绝保存。默认只允许 HTTPS。明文 HTTP 必须由管理员 mapping
明确声明；GitLab 自签 HTTPS 只沿用该连接显式的“关闭证书验证”选项。

修改 API authority、mapping 或 TLS trust boundary 会撤销该连接下全部个人 push token。页面先显示
受影响数量并要求二次确认；确认带一次性 CAS digest，另一位管理员已改过配置时旧确认会返回 409，
不会变成 last-writer-wins。只轮换公共 token 不清除个人配置。

## 2. 用户保存与校验个人 token

在 **我的账号 → 代码提交与推送**对应 provider 卡片中：

1. 输入个人 token；输入框永远为空，不会读回已保存明文。
2. 点 **校验 token**。平台只调用该 provider 的身份端点，并显示合法性与对应账号；草稿 token
   只用于这一次请求，不会自动保存。
3. 点 **保存凭据**。之后只显示末四位和更新时间；再次输入并保存表示替换。
4. 点 **删除凭据**并确认，下一次发布才回退公共 token。

未输入草稿时“校验 token”测试本人已保存的 token。本人没有保存记录时会明确报 unavailable，绝不
用公共 token 冒充校验成功。只有交互式登录 session 能调用这组账号 API；PAT、daemon token、匿名
和跨用户管理员读取都被拒绝。管理员只能整体删除代码平台连接，不能读取或替换某个用户的 token。

## 3. 发布时如何选凭据

每次 publication attempt 开始时，平台按工作的持久归属主体选择：

```text
有效个人记录 → 公共 connection token → 两者都不存在时沿用 legacy URL/SSH transport
```

- task 使用 `owner_user_id`；schedule、event 与 child task 继续传播这个 owner。
- development mission 使用 `created_by`；数字员工 case 使用持久 `owner_user_id`。
- system/legacy 工作跳过个人层；push 当下谁打开页面或发起重试不会改变 subject。
- 个人记录一旦被选中，过期、无权或密文损坏都直接失败，**不会**偷偷再试公共 token。
- 删除或替换只影响下一次 attempt；已经打开的几秒级 session 固定同一 credential revision。

task auto-push、non-fast-forward repair、候选/冲突交付、post-verify 和变更 submodule 发布都走同一
source-control transport participant。每个 submodule 使用自己的 remote 独立解析，父仓 token 不会
响应 sibling project、不同 host、protocol、port 或 path 的 helper 请求。

## 4. SSH remote 如何变成 HTTP(S)

Git 协议没有“拿 SSH URL 查询 HTTP URL”的通用命令。平台只采用以下证据，按顺序解析：

1. 用**公共 connection token**查询 GitHub repository metadata 的 `clone_url` 或 GitLab project
   metadata 的 `http_url_to_repo`，再校验 generation、authority、path 与允许集合；
2. 管理员显式 transport mapping；
3. `github.com` / `gitlab.com` 的内置 HTTPS 约定。

未知 server 不做字符串猜测。已经选中受管 token 但无法得到可信 HTTP(S) endpoint 时返回
`repository-http-endpoint-unresolved` / `repository-http-endpoint-untrusted`；未命中任何受管连接的
legacy SSH/file fixture 保持原行为。转换只作用于本次命令，不改 `origin`、`.gitmodules` 或镜像 URL。

## 5. 凭据不会出现在哪里

个人/公共 token 只存在于 secretBox 密封列和 mode `0600` 的一次性 lease 文件。Git 进程收到的是
无 userinfo endpoint、credential helper 配置和 lease **路径**；argv、普通 env、remote config、
worktree、API 响应、审计、日志与 system-mock journal 都不含 token。helper 只对 exact
protocol/authority/path 响应，请求结束在 `finally` 清理；daemon 启动只清理自己 app-home 下满足严格
名称、owner、mode 与 age 条件的遗留文件。

如果 `~/.agent-workflow/secret.key` 丢失或换成另一把钥匙，既有公共 code-host token、个人 push
token 和仓库 URL 凭据都不可解密。迁移旧 key（保持 `0600`）或在新机重新录入所有相关凭据；平台
不会尝试从末四位恢复，也不会在个人解密失败时改用公共身份。详见
[灾备说明](./disaster-recovery.md#4-异机恢复与凭据)。

## 6. 常见失败

| 错误/现象                               | 处置                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| `code-host-push-credential-unavailable` | 重新录入本人 token；若公共投影也不可用，管理员重新保存连接/token                        |
| `code-host-push-credential-stale`       | 刷新账号或 Settings 页面；连接 trust boundary 已改变，重新录入个人 token                |
| `repository-http-endpoint-unresolved`   | 管理员补自建实例的 SSH→HTTP(S) mapping，或修复 provider metadata 可达性                 |
| `repository-http-endpoint-untrusted`    | 检查 API/mapping 返回的 authority/path；平台不会向越界 endpoint 发 token                |
| push 401/403                            | 替换或删除个人 token；个人失败不自动改用公共 token，公共失败则由管理员修 scope/仓库权限 |
