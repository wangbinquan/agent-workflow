# RFC-111 — Claude Code 作为第二运行时（产品视角）

状态：**Draft**（待用户批准 + Codex 设计 gate 后进入实现）

触发：2026-06-26 用户「需要支持调用 claude code 来作为运行时」。

> **后续修订（RFC-226，2026-07-24）**：OpenCode 与 Claude Code 均为可选运行时；daemon
> 启动不再以 OpenCode binary/version 为硬门。本文以下内容保留当时的抽象层背景，不代表当前
> 启动合同。

---

## 1. 背景

平台当前**只能驱动 opencode CLI** 作为 agent 运行时。`runner.ts` 把 opencode 的进程启动方式（argv、`OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG_DIR` 环境变量、`--format json` 事件流解析、`--session` 续跑、SQLite 会话捕获）**完全硬编码**，没有任何运行时抽象层（调研结论：`runNode(opts): Promise<RunResult>` 是唯一自然接缝，内部全是 opencode 专属逻辑）。

[Anthropic 官方 Claude Code CLI](https://code.claude.com/docs/) 是另一个成熟的 agent 运行时，具备完整的 headless / print 模式（`claude -p`）、`--output-format stream-json` 事件流、`--model` / `--system-prompt` / `--mcp-config` / `--agents` / `--resume` 等可注入面，并把会话 transcript 落成 `~/.claude/projects/<slug>/<id>.jsonl`。参考框架 **multica** 已用「`Backend` 接口 + 工厂」模式同时驱动 11 个运行时（含 claude-code），证明该抽象成熟可借鉴（`server/pkg/agent/agent.go` / `claude.go`）。

用户希望平台能把 **Claude Code 当作一种可选运行时**，让用户为自己的 worker / auditor / fixer agent 选择「用 opencode 跑」还是「用 claude code 跑」，从而在同一个 Code → Audit → Fix 工作流里混用两种引擎。

## 2. 目标 / 非目标

### 目标

1. 引入**运行时抽象层**（`RuntimeDriver` 接口 + 归一化事件 + 工厂注册表），把 opencode 现有逻辑**行为不变地**抽取为一个 driver，再新增 claude-code driver。
2. **运行时选择 = 全局默认 + 每 Agent 覆盖**（D1）：`config.defaultRuntime`（默认 `opencode`）+ `agents.runtime` 列（可空，空=继承全局）。模型命名空间随运行时切换。
3. claude-code driver 达到与 opencode **全注入平价**（D2）：
   - persona（agent 正文 markdown → 系统提示词）
   - 模型选择
   - clarify inline 会话续跑（`--resume`）
   - readonly 工具门禁
   - 输出信封 `<workflow-output>`（已 runtime-agnostic，零改）
   - **skills**（managed / external 注入；repo 内 `.opencode`/`.claude` 自发现）
   - **MCP**（`--mcp-config` 内联 JSON）
   - **dependsOn 闭包** → claude 子代理（`--agents` 内联 JSON）
4. **鉴权自动探测 + 真实来源呈现**（D3）：透传 daemon env（key/token/helper 任一可胜出），否则回退本机 `claude login` 订阅；鉴权来源以 probe 上报为准；每 attempt 持久配置目录（D16）下按白名单桥接订阅凭据。
5. **会话 transcript 捕获**（D4）：新增 JSONL 捕获适配器，读 `<configDir>/projects/<slug>/<id>.jsonl` 转码进 `node_run_events`，喂同一个 `parseSessionTree`，使 claude 节点的任务详情 SessionTab 与 opencode 平价。
6. 设置页 Runtime 标签双运行时状态卡（opencode + claude-code 各自 probe + 版本 + 模型列表）；Agent 表单运行时选择器。**用户可见的 claude 选择器在注入平价 + 捕获齐活前不暴露（D17）**——驱动核心 / DB / mock e2e 先落，UI 末位接线。
7. 全程随改动带测试（CLAUDE.md test-with-every-change）：每个 driver 单测、归一化解析、e2e Code→Audit→Fix 在 **mock-claude** harness 上跑通、前端选择器测试、i18n 中英对称。

### 非目标（v1 明确不做）

- **不让 opencode 变可选**（D14）：daemon 启动仍**硬要求** opencode（版本门不变）；claude-code 是**附加**运行时。内部框架 agent（commit&push RFC-075 / 记忆蒸馏 RFC-043 / 融合 RFC-101 / skill-merger）继续跑在 opencode 上，不在本 RFC 改造范围。
- **不做节点级运行时覆盖**（仅 Agent 级）。模型/variant/temperature 节点覆盖维持现状不变。
- **不映射 opencode `permission` JSON schema 到 Claude Code**：Claude Code 权限模型不同，v1 只映射 `readonly` + 默认放行（headless skip-permissions），opencode 专属 `permission` 字段对 claude 节点忽略（能力差异，文档化）。
- **不支持 opencode 专属能力在 claude 上的等价物**：`variant` / `temperature`（Claude Code CLI 不暴露）/ RFC-029 inventory 插件 / RFC-031 opencode 插件系统 —— 对 claude 节点跳过并文档化。
- **不做 plugin 注入平价**（opencode plugin ≠ Claude Code plugin，留后续 RFC）。

## 3. 用户故事

- **US-1（混用引擎）**：作为工作流作者，我把「设计者」agent 设成 claude-code 运行时、把「审计者」agent 留在 opencode，启动同一个工作流后两个节点分别用各自引擎跑，产出经同一套信封/端口在节点间流转。
- **US-2（全局切换）**：作为管理员，我在设置里把 `defaultRuntime` 设成 claude-code，此后**未显式指定运行时**的 agent 默认都用 claude code 跑；个别 agent 仍可显式覆盖回 opencode。
- **US-3（鉴权零配置）**：我本机已 `claude login`（订阅），daemon 直接复用该登录态跑 claude 节点，无需配 API key；CI 环境我改用 `ANTHROPIC_API_KEY` 环境变量，平台自动探测使用。
- **US-4（可观测平价）**：claude 节点跑完后，我在任务详情 SessionTab 能看到它完整的思考 / 工具调用 / 子代理对话树，与 opencode 节点体验一致。
- **US-5（能力健康度）**：我在设置 → Runtime 看到 opencode 与 claude-code 两张状态卡，各自显示是否可用、版本、最低版本、模型列表；claude 不可用时该卡显示原因，但不影响纯 opencode 工作流。
- **US-6（反问续跑）**：claude 节点挂了反问通道，我答完后该节点用 `--resume` 在原会话续跑（带完整上下文），与 opencode `--session` 行为一致。

## 4. 验收标准

1. **抽象不回归**：opencode driver 抽取后，全量后端测试（3900+）全绿，且新增「opencode argv/env 黄金断言」证明启动命令与环境**逐字不变**。
2. **运行时解析**：`resolveRuntime(agent, config) = agent.runtime ?? config.defaultRuntime ?? 'opencode'`，纯函数 + 单测覆盖三层回退。
3. **claude 核心跑通**：mock-claude harness 下，单 agent 节点 → 输出 `<workflow-output>` 被正确解析为端口；Code→Audit→Fix 三节点工作流端到端跑通（claude / 混用两种拓扑）。
4. **全注入平价**：skills（managed 拷贝 / external 软链）、mcp（`--mcp-config`）、dependsOn 闭包（`--agents`）、readonly（`--disallowed-tools`，**best-effort 工具门禁、非沙箱保证**，D7）四项各有针对性测试；repo 内 skill 自发现不被破坏；**worktree 不被注入物污染**（git diff 干净）。
5. **会话续跑**：clarify inline 重跑对 claude 节点透传 `--resume <session_id>`，session id 从 stream-json `system`/`result` 事件捕获；**配置目录跨 clarify 轮持久（D16）使会话文件可被 `--resume` 命中**；resume 用**冻结的 node_run runtime**（D15）选 CLI flag；spawn-arg 契约 + 真实续跑 e2e 锁定。
6. **transcript 捕获**：JSONL fixture（主 `<id>.jsonl` + 子代理 `<id>/subagents/`，**真实布局**）→ `parseSessionTree` → SessionTab 子代理树正确；捕获失败走既有 `*_capture_failed` 降级标记、不阻断编排。
7. **鉴权来源真实呈现**：透传 daemon env（key/token/helper 任一可胜出）、无显式凭据回退订阅；状态卡显示 **probe 上报的真实来源**（非平台推断）；每 attempt 持久 config 目录下订阅凭据桥接成功（含 macOS keychain 不受 `CLAUDE_CONFIG_DIR` 影响、Linux 文件凭据按 D16 白名单桥接，两路径各测）。
11. **runtime 冻结**：`node_runs.runtime` 在铸行时冻结；resume/retry 读冻结值（agent 改 runtime / 翻 `defaultRuntime` 后旧 run 仍按原 runtime 续跑）；未知 runtime fail-closed 而非静默 opencode；测试覆盖「跑后改 agent runtime 再 resume」不错配。
8. **健康度门**：缺 claude 二进制 / 版本过低时，纯 opencode 工作流零影响；引用 claude agent 的节点在 spawn 前**清晰失败**（非静默挂死）。
9. **前端平价**：Agent 表单运行时选择器切换后模型下拉切换命名空间；设置双状态卡；i18n 中英对称；视觉走既有公共组件（Select / RuntimeStatusCard / ModelSelect 扩展，不新写 chrome）。
10. **门禁**：typecheck×3 + 后端 bun test + 前端 vitest + format + binary smoke 全绿；Codex 设计 gate + 实现 gate 各 fold。

## 5. 决策登记

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| **D1** | 运行时选择粒度 | **全局默认 + 每 Agent 覆盖**（用户答） | 与现有 model 字段对称；模型命名空间天然随 agent；不引入节点级覆盖以收敛改动面。解析：`agent.runtime ?? config.defaultRuntime ?? 'opencode'`。 |
| **D2** | v1 注入面 | **核心 + 全注入平价**（用户答） | 用户要求功能对齐 opencode：skills / mcp / dependsOn 子代理 / readonly 全做。 |
| **D3** | 鉴权 | **自动探测 + 呈现真实来源**（用户答 + Codex P1-4 修订） | 不建二元模型：透传 daemon 进程 env（可能含 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN`/`apiKeyHelper`/云厂商 env 任一），无显式 key 则回退本机 `claude login` 订阅。**鉴权来源以 probe/init 事件 `apiKeySource` 上报为准**（不靠平台推断，避免误诊）。设计文档列全 Claude Code 鉴权优先级，运维注入的 env 可静默胜出（文档化）。 |
| **D4** | transcript 捕获 | **v1 纳入 JSONL 捕获**（用户答） | SessionTab 与 opencode 平价；读 `<configDir>/projects/<slug>/<id>.jsonl`。 |
| **D5** | 抽象形态 | `RuntimeDriver` 接口 + 归一化事件 + 工厂注册表 | 借鉴 multica `Backend` 工厂；先**行为不变抽取** opencode（绿网兜底），再加 claude driver。 |
| **D6** | persona 注入方式 | `--append-system-prompt-file`（**追加**于 Claude Code 默认系统提示） | 忠实于 opencode 语义（agent prompt 也是**叠加**在引擎基座之上，非整体替换）；保留 Claude Code 工具/harness 脚手架，降低破坏 tool-use 与信封纪律的风险。`--system-prompt`（替换）列为已知备选，待实现期对比验证。 |
| **D7** | readonly 映射 | scheduler 写信号量（不变，runtime-agnostic）+ claude `--disallowed-tools`（含 `Write Edit MultiEdit NotebookEdit` 等，名集待 V4 实测）= **尽力而为**，**非沙箱保证**（Codex P2-4 修订） | 真正的并发护栏是写信号量（仅并发语义，非禁写沙箱）；Bash/PowerShell/MCP 工具仍可写，两运行时都无法完全沙箱（同既有限制）。验收只把 readonly 当**best-effort 工具门禁**，不做强保证。 |
| **D8** | 权限/非交互 | claude 默认 `--dangerously-skip-permissions`（headless 不挂起），叠加 D7 的 readonly 工具门禁 | 与 opencode `--dangerously-skip-permissions` 默认对齐；opencode `permission` JSON 不映射（能力差异）。 |
| **D9** | claude 模型列表 | 静态精选列表模块（别名 opus/sonnet/haiku/fable + 当前全 ID）+ ModelSelect 既有自定义值兜底 | Claude Code 无 `models` 子命令；列表随发布更新，自定义值兜底覆盖长尾。 |
| **D10** | 版本门 | opencode 启动门**不变（硬失败）**；claude 启动**软探测**（warn + 设置卡），引用 claude agent 的节点 **spawn 前硬失败** | 纯 opencode 安装零新增硬要求；claude 缺失只影响 claude 节点。`MIN_CLAUDE_CODE_VERSION` 待实现期实测钉定。 |
| **D11** | session id 列 | 复用 `node_runs.opencode_session_id` 作**通用运行时 session id**（注释说明），resume 时按**冻结的 node_run runtime**（D15）选 `--session`/`--resume` | 避免大面积改名；session id 必须与**冻结 runtime 配对**消费（见 D15），否则会把 claude session id 喂给 opencode。可选后续清理改名 `runtime_session_id`。 |
| **D15** | runtime 冻结 | **新增 `node_runs.runtime` 列**，dispatch 铸行时由 `resolveRuntime(agent,config)` 解析并冻结；resume / clarify-rerun **读冻结值**（不重解析），全新 attempt 才重解析；未知值 **fail-closed**（node failed，非静默回退 opencode）（Codex P1-2） | agent.runtime / `defaultRuntime` 均可变；不冻结则 resume 跨 runtime 错配（session id + 捕获路径 + CLI flag 全错）。与 RFC-109 工作流快照冻结同理。 |
| **D16** | claude 配置目录生命周期 + 信任边界 | **每 attempt 持久** `CLAUDE_CONFIG_DIR`（键 task/node/retry_index，跨同 attempt 的 clarify 轮**复用不删**，随 worktree GC 清理），使 `--resume` 能找到上一轮会话文件；**仅白名单桥接订阅凭据**，**不**镜像用户 settings/agents/plugins/hooks（防 daemon 无人值守跑里被注入行为）；MCP 走 `--strict-mcp-config`、设置走平台自带最小 `--settings`（Codex P1-1 + P2-1） | 原「每运行私有目录跑完即删」会让 `--resume` 失效；原「桥接用户全局」越过信任边界。 |
| **D17** | claude 用户可见暴露时机 | 运行时**驱动核心 + DB + mock e2e 先落（PR-A/B），但 Agent 表单 / 设置里的 claude 选择器在注入平价（PR-C）+ 捕获（PR-D）齐活前不对用户暴露**（feature-flag / 末位接线）（Codex P2-3） | 避免用户在半成品期选到「无 skills/mcp/子代理/readonly/resume」的残缺 claude 运行时。 |
| **D12** | prompt 投递 | claude 经 **stdin** 投递 prompt（`claude -p --output-format stream-json --verbose` + stdin），opencode 维持 positional 不变 | 规避 argv `E2BIG` 上限（opencode 仍有该已知风险）；driver 各自声明 stdin 处理。 |
| **D13** | 技能注入机制 | 每 attempt 持久 `CLAUDE_CONFIG_DIR`（见 D16 生命周期+信任边界）下放 managed(拷贝)/external(软链) 技能到 `skills/`；repo 内 `.claude/skills` 自发现、不污染 worktree | `CLAUDE_CONFIG_DIR` 是**整体重定位**（非 opencode 叠加扫描），故凭据按 D16 白名单桥接；**待实现期对照实装 claude 验证**（design §6 V2/V3）。 |
| **D14** | opencode 是否变可选 | **否**，opencode 仍硬要求；claude 纯附加；内部框架 agent 留 opencode | 收敛 v1 风险面；「opencode 可选 / 内部 agent 多运行时」留独立 RFC。 |

## 6. 影响面概览

- **Schema/DB**：`agents` 加 `runtime` 列（migration，可空，默认 NULL=继承）；config 加 `defaultRuntime` / `claudeCodePath` / `defaultClaudeModel`。`node_runs.opencode_session_id` 复用（D11）。
- **后端**：新 `services/runtime/`（types + opencode driver 抽取 + claude driver + 注册表）；`runner.ts` 改为委派；`runtime.ts` 路由泛化；启动门加 claude 软探测；新 JSONL 捕获模块。
- **前端**：Agent 表单运行时选择器；设置双状态卡 + 每运行时模型默认；ModelSelect 运行时感知；i18n。
- **测试**：mock-claude harness、driver 单测、注入平价测试、JSONL 捕获 fixture、前端选择器、e2e。

详见 `design.md` 与 `plan.md`。
