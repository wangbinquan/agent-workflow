# OpenCode 运行时配置

> RFC-276 起，Agent Workflow 以普通子进程方式运行 OpenCode。平台不再冻结或校验
> OpenCode 二进制、建立私有 HOME/XDG/store、阻断网络，或施加 OS sandbox。
> OpenCode 的版本字符串仅用于展示和 CLI 参数兼容，不是安全准入条件。

## 1. 运行时选择与启动

- `config.json.opencodePath` 可以指定一个 OpenCode 可执行文件；未配置时使用 `PATH`
  中的 `opencode`。
- Runtime profile 可以为 Agent 指定模型、variant、temperature、steps 与 maxSteps。
- 业务运行使用 `opencode run --agent <name> --format json --thinking`。OpenCode 1.18+
  使用 `--auto`；已探测到更早版本时使用旧参数
  `--dangerously-skip-permissions`。
- 提示词通过 `--` 后的尾随参数传入；超过 120 KiB 时会在启动前给出可读错误。
- 子进程 cwd 与 `PWD` 都指向任务 worktree。

Runtime Test 和 `GET /api/runtimes/status` 只报告可执行文件能否启动及其版本。状态为
`not-found`、`unlaunchable`、`protocol-incompatible` 或 `ready`。

## 2. 环境与机器配置

OpenCode 继承 daemon 的普通环境，包括用户现有的 HOME、XDG、认证和 provider 配置。
平台只叠加本次运行所需的值：

- runtime profile 的 config-dir 环境变量（默认 `OPENCODE_CONFIG_DIR`）；
- `OPENCODE_CONFIG_CONTENT` 内联 Agent/MCP/plugin 配置；
- 可选 inventory 输出路径；
- 任务配置的 Git author/committer 身份。

为避免 daemon 级权限覆盖本次 Agent 定义，继承的 `OPENCODE_PERMISSION` 会被删除。
自定义 config-dir 环境变量不能命名为 `OPENCODE_PERMISSION`。

机器、用户和仓库自身的 OpenCode 配置仍按 OpenCode 的正常规则参与加载。平台不会把
这些来源描述成经过校验或冻结的输入。

## 3. 内联配置

### 3.1 Agent 与权限

主 Agent 和依赖闭包中的 Agent 都写入 `OPENCODE_CONFIG_CONTENT.agent`。每个条目包括
正文、描述、runtime profile 参数和作者显式配置的 `permission`。平台不再增加全局
allow/deny 层；未声明操作由 OpenCode 自己的 `--auto` 行为处理。

### 3.2 Skill 与 plugin

选中的 managed skill 会整目录复制到本次 runtime config 的 `skills/<name>/`。
project skill 由 OpenCode 从 worktree 自行发现。Skill 中的 `.claude-plugin` 目录不会
作为 skill 投影，以免跨越 skill/plugin 资源边界。

启用的 managed plugin 以平台已解析的本地 `file://` spec 写入内联配置；禁用项不写入。

### 3.3 MCP

启用的 MCP 写入 `OPENCODE_CONFIG_CONTENT.mcp`：

- local MCP 保留 command/args，`env` 映射为 `environment`，子进程 cwd 继承
  OpenCode 的 worktree；
- remote MCP 保留 URL、headers、OAuth 与 timeout；
- 禁用项不写入，因此不会遮盖同名的继承配置。

OpenCode 将 MCP 工具权限名表示为 `<mcp-name>_<tool-name>`。Agent 的 permission
字段若要点名单个 MCP 工具，应使用这个名字。

## 4. 会话与进程生命周期

平台仍负责普通的运行可靠性：记录 PID、解析有界 stdout/stderr、处理 timeout/abort、
以 `SIGTERM → SIGKILL` 回收整棵子进程树，并在 daemon 重启后修复中断状态。
这些是生命周期管理，不构成安全隔离或执行身份认证。

## 5. 模型发现

模型列表通过选定的 OpenCode 可执行文件在操作者的自然 cwd 和环境中运行，因此能看到
与普通 OpenCode 命令相同的 provider、认证和机器配置。刷新会绕过平台的短期缓存。

## 6. 安全边界

OpenCode 与 daemon 使用同一操作系统账户运行，默认能够访问该账户可访问的文件和网络。
请把 Agent、Skill、Plugin、MCP、仓库内容和模型输出视为可执行或可影响执行的输入。

平台仍保留独立于运行时加固的边界：用户认证与 ACL、秘密值加密和日志脱敏、输入及路径
校验、Git 凭据处理、显式 Agent 权限映射、进程生命周期治理，以及 Script 节点
`readonly` 的一次性 worktree/不回合并语义。它们不应被描述为 OS sandbox。

## 7. 维护检查

修改 OpenCode 接口时至少覆盖：

- runtime probe、status、models 与 Runtime Test；
- argv/env、inline Agent/MCP/plugin 配置和 permission 映射；
- skill staging、session capture、timeout/abort 和进程树回收；
- backend/shared/frontend tests、typecheck、lint、format、depcheck 和 binary smoke。

历史的 verified execution、containment 与 sandbox 合同保存在 RFC-205、RFC-216、
RFC-224、RFC-227、RFC-233 和 RFC-272；它们已由 RFC-276 废弃，不是当前运行时合同。
