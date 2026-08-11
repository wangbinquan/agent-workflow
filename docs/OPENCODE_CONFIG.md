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
正文、描述、runtime profile 参数和作者显式配置的 `permission`。除下面的工作区边界外，
平台不增加全局 allow/deny 层；未声明操作由 OpenCode 自己的 `--auto` 行为处理。

**工作区边界（RFC-281）**：平台会在每个业务 Agent 条目的 `permission` 里追加一条
`external_directory` 规则（`{"*": "deny"}` 基线 + 本次运行合法目录的 allow），并在顶层
`permission` 发同一条以覆盖 OpenCode 的原生子代理（`general`/`explore`）。目的是让一个
任务的 Agent 只在自己的工作目录内干活，不会跑进另一个任务的工作目录——这正是该 RFC 的
起因。要点：

- **追加在作者键之后**。OpenCode 按键序 `findLast` 裁决，作者写的 `"*": "allow"` 会通配
  到 `external_directory`；边界键排在其后才生效（实测：顺序调换即失效）。
- **`--auto` 翻不动 `deny`**。deny 在询问之前短路，所以自动批准不会放行越界。
- **默认放行本次运行需要的目录**：本任务的全部仓库工作树、本次运行的 config 目录
  （含 staged skill）、OpenCode 的临时目录与 tool-output 目录，以及 OpenCode 自己会发现的
  **机器级技能根**（`~/.claude/skills`、`~/.agents/skills`、配置目录下的 `{skill,skills}`）
  ——这些本就在 OpenCode 的默认白名单里，平台只是把被 deny 基线遮蔽的部分放行回来，
  否则会出现「技能说明进了 prompt，但按它读同目录脚本被拒」的半残状态。
- **越界表现为工具报错、会话继续**，不会让节点失败。
- **作者可显式放宽**：在 Agent frontmatter 里声明
  `permission.external_directory: { "/abs/dir/*": "allow" }`。OpenCode 侧原样生效；
  Claude 侧只能兑现**字面目录**（中段带 `*` 的 glob 会打
  `claude-external-directory-glob-unsupported` 告警，不静默丢弃）。若把
  `external_directory` 写成标量 `"allow"`，视为作者接管整键、平台不再合成基线。
- **项目配置不能反向放宽**（worktree 内的 `opencode.json` 在平台内联配置之前合并）；
  但机器/组织级配置（active-org、managed 目录、MDM）在其之后合并，**可以**放宽——
  这属于「管理员拥有本机」的既有信任模型，见 §6。

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

Claude Code 侧同一份 MCP 闭包渲染为 `--mcp-config` 指向的 JSON 文件（RFC-280
§7.1 起写 `runRoot/mcp-config.json`、`0600`、路径传参而非内联 argv——remote MCP
的 header 可能带 token，内联 JSON 会进 `/proc/<pid>/cmdline`）。两条链路的
「DB 行 → wire 形状」转换是同一实现（`services/execution/agentInjection.ts`）。

### 3.4 声明注入清单与启动验证（RFC-280）

每次 spawn 产出一份 `DeclaredManifest`（注入了哪些 MCP / skill / subagent /
tool，以及被跳过的 disabled MCP、被该 runtime 丢弃的 profile 参数、无法观测的
面）。run 结束后与 runtime 的启动清单（claude 的 `system/init` 事件 / opencode
的 RFC-029 inventory）做差集，落 `node_runs.startup_verification_json`：

- **业务节点**：MCP 未连接 / skill·subagent·tool 未加载 = 节点详情持久告警
  （带 runtime 报告的原因，如 `spawn ENOENT`），**不改变节点成败**；
- **MCP 测试台**：被测 MCP 未连接 → turn 显式 fail（`mcp-test-mcp-unusable`）；
  观测源缺失/损坏 → `mcp-test-verification-unavailable`（fail-closed，绝不
  fail-open）。

这终结了此前「MCP 连不上、节点照常成功、agent 只能口头说找不到工具」的静默降级。

## 4. 会话与进程生命周期

平台仍负责普通的运行可靠性，且五条 spawn 链路（业务节点 / 系统 agent / MCP
测试台 / 冒烟探针 / 记忆蒸馏器）的进程可靠性统一由**一个执行器**承担
（`services/execution/managedProcess.ts`，经 `agentProcess.ts` 适配）：记录 PID、
解析有界 stdout/stderr、处理 timeout/abort、以 `SIGTERM → SIGKILL` 回收整棵
子进程树、有界 drain，并在 daemon 重启后修复中断状态。这些是生命周期管理，
不构成安全隔离或执行身份认证。

## 5. 模型发现

模型列表通过选定的 OpenCode 可执行文件在操作者的自然 cwd 和环境中运行，因此能看到
与普通 OpenCode 命令相同的 provider、认证和机器配置。刷新会绕过平台的短期缓存。

## 6. 安全边界

OpenCode 与 daemon 使用同一操作系统账户运行，默认能够访问该账户可访问的文件和网络。
请把 Agent、Skill、Plugin、MCP、仓库内容和模型输出视为可执行或可影响执行的输入。

平台仍保留独立于运行时加固的边界：用户认证与 ACL、秘密值加密和日志脱敏、输入及路径
校验、Git 凭据处理、显式 Agent 权限映射、进程生命周期治理，以及 Script 节点
`readonly` 的一次性 worktree/不回合并语义。它们不应被描述为 OS sandbox。

### 6.1 任务工作区边界（RFC-281）：防误入，不是隔离

RFC-281 让每个业务节点默认只在自己的任务工作目录内工作（配置见 §3.1）。它的定位是
**防止走神/路径混淆导致的跨任务串扰**，不是对抗蓄意越权的安全隔离，也不恢复 RFC-276
删除的任何运行期加固链——用的完全是两个 runtime 自己的普通配置面：

- **OpenCode**：`permission.external_directory`（相对判定，边界=进程 cwd 与其 git 工作树），
  读写都拦，自动区分自己与兄弟任务。
- **Claude Code**：其自带 sandbox 设置经 per-run `--settings` 下发，只做**写**边界
  （写=cwd+临时目录+平台放行的本任务目录，连子进程一起管）。**平台不下发任何
  denyWrite/denyRead**：实测把 appHome 祖先目录列进 denyWrite 会连 Agent 自己的 cwd 一起
  盖死，「更严」的写法恰恰会打挂所有任务。**也不下发 `allowUnsandboxedCommands`**：
  该键为 `false` 时会让 `dangerouslyDisableSandbox` 完全失效，而那是模型撞到 cwd 外写
  （`bun install` / `npm ci` 等写 `~` 下缓存）时唯一的自救路径，无人值守下焊死它等于让
  节点卡死；写边界本身由 sandbox 默认的 cwd+tmp+放行目录承担。声明了权限的节点另外
  收到 `Edit(//<mount>/**)` 规则，否则多仓任务写不了另一个仓。

**已知不覆盖的面（有意保留，不要当成被防住了）**：

- OpenCode 的 bash 只扫少数命令的参数，`sed`/`python`/`git -C`/重定向等间接写不受该键约束；
- OpenCode 的路径判定是词法比较，不解析符号链接；
- Claude 侧**读**面保持默认（读全盘），只有写被约束；
- 机器/组织级 runtime 配置在平台注入之后合并，管理员可放宽（同 §6 的信任模型）；
- Claude 的部分设置键（如数组型）跨配置层合并，仓库内 `.claude/settings.json` 可能影响最终形态；
- 机制不可用时（如 Linux 缺少 Claude sandbox 依赖）**打告警放行、不阻断业务**。

Script 节点不在该边界范围内（它不经 runtime 权限面）。

## 7. 维护检查

修改 OpenCode 接口时至少覆盖：

- runtime probe、status、models 与 Runtime Test；
- argv/env、inline Agent/MCP/plugin 配置和 permission 映射；
- skill staging、session capture、timeout/abort 和进程树回收；
- backend/shared/frontend tests、typecheck、lint、format、depcheck 和 binary smoke。

历史的 verified execution、containment 与 sandbox 合同保存在 RFC-205、RFC-216、
RFC-224、RFC-227、RFC-233 和 RFC-272；它们已由 RFC-276 废弃，不是当前运行时合同。
