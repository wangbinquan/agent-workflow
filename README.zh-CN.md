# Agent Workflow

[English](./README.md) | [**简体中文**](./README.zh-CN.md)

[![Release](https://img.shields.io/github/v/release/wangbinquan/agent-workflow)](https://github.com/wangbinquan/agent-workflow/releases/latest)
[![CI](https://github.com/wangbinquan/agent-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/wangbinquan/agent-workflow/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

## 面向 AI 工程协作的 local-first 控制平面

让 CLI coding agents 在独立进程中工作，以确定性工作流或自适应工作组组织协作，并让
人工决策、Git 变更、恢复过程与受治理的知识在同一个控制面中保持连接。

**AI 负责推理，框架负责协调，人负责治理。**

[快速开始](#快速开始) · [产品导览](#产品导览从意图到证据) ·
[文档](#文档) · [设计文章](#设计文章)

![一条清晰的父工作流先调用可复用子工作流，再调用工作组，最后返回一个发布建议](./docs/images/readme-workflow.png)

<sub>不以拥挤画布换取信息量：父工作流接收 release request，调用
<strong>Focused Verification</strong>，把综合判断交给 <strong>Release Council</strong>，
再返回一个 recommendation；每张卡片与每条连线都完整可见。</sub>

> **项目状态：** Agent Workflow 正在持续开发。本文描述
> <code>main</code>；[最新发布版](https://github.com/wangbinquan/agent-workflow/releases/latest)
> 可能会暂时落后于主干。

## 为什么需要 Agent Workflow

Coding agent 擅长在一个任务中推理，但跨 agent 的路由、重试、恢复和审批策略不应隐藏在
某个模型会话里。Agent Workflow 把两类职责分开：

- **Agent 是工作流节点，不是工具栏按钮。** 每次 run 都拥有独立进程和聚焦上下文，
  无需让一个父会话无限膨胀。
- **模型负责推理，框架负责协调。** 带类型端口、持久状态、重试、wrapper 和恢复机制让
  数据流显式、可检查。
- **Fan-out 用于控制任务粒度。** 列表可以驱动聚焦的并行 run，再由 aggregator 收敛发现；
  这是上下文和任务范围管理，不承诺并行本身必然提高准确率。
- **人是第一等参与者。** Review 与 clarify 是显式 Workflow 节点；冲突处理与动态工作流
  确认则是各自执行路径上的持久 gate，而不是失败后的人工救火。
- **记忆受治理，不被当作真理。** Clarify 回答、review 决策和反馈先成为候选；只有批准后的
  记忆才会按 scope 和预算作为 advisory context 注入。

## 选择合适的执行模型

每次启动都会成为一个 Task，并共享历史、产物、恢复控制和访问检查。

| 模型          | 适合场景                       | 行为                                                                                                     |
| ------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **单 Agent**  | 聚焦的一次性工作               | 让一个已配置 Agent 面向一个或多个仓库执行。                                                              |
| **Workflow**  | 可重复交付和质量门禁           | 运行带类型端口、wrapper、call 和人工节点的版本化可视 DAG。                                               |
| **Workgroup** | 计划需要在运行时调整的复杂目标 | 从 Task-owned 启动快照开始，支持受控的运行中调整，并运行 leader-worker、自由协作或经人工确认的生成 DAG。 |

Scheduled launch 和 webhook 都可以启动这三种模型。

## 执行如何保持可控

> **一条典型的 Git-backed、受治理路径：**目标 + 仓库 → 执行模型 → 确定性 daemon
> → 独立 Agent run → merge-back → 可选人工 gate → 持久结果

对 Git-backed Task，Agent run 通常在隔离的节点 worktree 中工作。成功变更会在短锁窗口内
三方合并回 Task 的 canonical worktree；失败尝试不会自动合入。因此，彼此独立的 DAG 分支
可以并行写入而不共享工作目录。

这属于保护任务状态与合并语义的 **Git 隔离**，并不是操作系统安全边界。Runtime 子进程
以普通进程运行，拥有 daemon 账户可访问的文件与网络。详见[平台与安全](#平台与安全)。

Daemon 把 Task 和节点状态持久化到 SQLite，记录事件与 runtime 对话，在重启后对账中断进程，
并让 review 与 clarify 决策始终绑定到产生它们的那次执行。

## 产品导览：从意图到证据

下面选择的是当前产品中具有代表性的状态，每张图只解释一个核心任务；它们不暗示每次
launch 都必须依次经过全部五个阶段。

### 1. 从意图提出方案

Intent Builder 把自然语言目标转成经过校验、可以逐项 review 的 changeset，覆盖 Agent、
Skill、MCP、Plugin、Workflow 和 Workgroup。它先创建 draft；只有用户检查并 commit 精确
版本后才会应用。Human、命名、secret 与 modify-versus-copy 决策保持显式，真实 secret 值
在确认阶段绑定，不经过模型。

![Intent Builder 已填写发布就绪目标、选择 Workflow 作为 artifact hint，并明确显示只创建 draft](./docs/images/readme-intent.png)

### 2. 用嵌套调用完成组合

README 顶部的 Workflow 同时展示两种 call。Workflow call 镜像被调用 Workflow 的端口
契约；Workgroup call 把输入转成 goal，并返回一个 result。每个 call 都会启动独立 child
Task，而不是把子图内联进父图。引用闭包在 launch 时冻结，并受到 cycle、depth、input 与
concurrency gate 约束。

### 3. 由仓库事件触发

经过 GitHub HMAC 签名验证或 GitLab secret token 验证的 webhook delivery，可以按仓库
scope、event、branch、command prefix 与 author rule 匹配，再启动 Agent、Workflow 或
Workgroup。执行既可使用事件仓库，也可使用全新的 scratch Git 空间；delivery 与 fire
都可审计。

![一条已启用的 webhook rule，把 acme checkout 仓库范围和三类事件映射到带 child call 的发布就绪 Workflow](./docs/images/readme-webhook.png)

### 4. 在计划需要调整时协作

Workgroup 支持 Leader 派工、无 Leader 自由协作，以及先生成 DAG、经人工 review 后再交给
普通 Workflow 引擎的动态模式。下图有意只展示一个合法的 Leader-Worker 资源：四名成员、
明确的 coordinator 与显式 human participation。其他模式分别执行自己的 roster 和交互约束；
动态模式要求兼容的纯 Agent roster。

![Release Council Workgroup 资源卡展示 Leader-Worker 模式、四名成员、coordinator Leader 与 human participation](./docs/images/readme-workgroup.png)

### 5. 用真实证据完成核验

另一条受控发布 Task 展示控制面的 reviewer 一侧。Task 级 structural changes 把代码和
文档分组，选中文件则展示真实 unified diff，让审批决策可以绑定到可检查的具体证据。

![Structural changes 按代码和文档分组，并展示 checkout rounding 的 unified diff](./docs/images/readme-changes.png)

## 核心能力

### 显式编排

- 可视化 Workflow 支持 <code>string</code>、<code>markdown</code>、
  <code>signal</code>、<code>path&lt;ext&gt;</code> 和
  <code>list&lt;T&gt;</code> 端口。
- Git、loop 和 fan-out wrapper；fan-out 可以针对列表中的每一项运行受支持的 inner agent
  worker，并由一个 aggregator 收敛。当前不支持 per-shard 链式子图。
- Workflow / Workgroup call 节点会启动独立 child Task；另有可复用 launcher form 与
  scheduled launch。
- 经过 GitHub HMAC 签名验证或 GitLab secret token 验证的 webhook rule，可从受支持的
  仓库事件启动 Agent、Workflow 或 Workgroup，并保留审计记录。
- Intent Builder 在用户 commit 精确 draft 前，只提出并校验多资源变更。

### 执行、观察与恢复

- 支持 OpenCode、Claude Code，以及实现其中一种协议的自定义 runtime profile。
- 每节点 worktree、按 provenance 重试、Task resume/relaunch、带持久恢复状态的取消，
  以及可选的框架托管 commit 和 push。
- 查看实时节点状态、CLI 对话、工具调用、token 用量、输出、runtime inventory、
  worktree 文件、unified diff 与 Task feedback。
- 对 C++、Java、Python、Rust、Go、JavaScript、TypeScript 和 Scala 做结构化变更分析；
  内置 tree-sitter 基线，可选 SCIP 提供更深的跨文件结果。C++ 与 Scala 分析为
  best-effort。

### 把人和策略放进执行链

- Markdown 或多文档评审，支持选区锚定评论、选择性采纳、版本历史与
  Approve / Revise / Reject 决策。
- 结构化 clarify 问题、handler 路由与重新指派、延后与重新回答，以及
  self / cross-agent clarify。
- 统一 Inbox、本地用户、OIDC、Personal Access Token、角色、所有权、可见性和资源授权。
- 从 clarify、review 与 feedback 蒸馏记忆候选，再按批准状态、scope 和预算注入。

### 搬运可移植的资源配置

配置包可以导出 Agent、Skill、MCP、Plugin、Workflow 或 Workgroup，以及它能解析的递归资源
依赖闭包；外部 requirements 与 dangling call reference 会显式保留。导入先预检，再显式选择
create / reuse / overwrite。详见[配置包](./docs/resource-packages.md)。

已知的结构化凭据字段会被脱敏，并在导入时重新填写；managed Skill 文件树会按原样复制，
不扫描其中硬编码的密钥。

## 快速开始

启动 daemon 前：

- 安装 **Git 2.38 或更高版本**。Git 缺失或版本过低时 daemon 会拒绝启动；Windows 必须
  安装 Git for Windows。
- Coding runtime 可以在 daemon 启动后配置，但启动 Agent 工作前至少需要一种受支持的
  runtime。

### 1. 安装发布二进制

从[最新发布版](https://github.com/wangbinquan/agent-workflow/releases/latest)选择对应资产：

| 平台                | Release asset                                  |
| ------------------- | ---------------------------------------------- |
| Apple Silicon macOS | <code>agent-workflow-macos-arm64</code>        |
| Linux x86_64        | <code>agent-workflow-linux-x86_64</code>       |
| Linux arm64         | <code>agent-workflow-linux-arm64</code>        |
| Windows x86_64      | <code>agent-workflow-windows-x86_64.exe</code> |

macOS 示例：

```bash
curl -L https://github.com/wangbinquan/agent-workflow/releases/latest/download/agent-workflow-macos-arm64 -o agent-workflow
chmod +x agent-workflow
./agent-workflow start
```

Windows PowerShell 示例：

```powershell
Invoke-WebRequest https://github.com/wangbinquan/agent-workflow/releases/latest/download/agent-workflow-windows-x86_64.exe -OutFile agent-workflow.exe
.\agent-workflow.exe start
```

Daemon 会输出 loopback URL。用浏览器打开即可；可执行文件已内置 SPA、daemon、数据库
migration 和 Bun runtime。

### 2. 安装 Coding Runtime

启动 Agent 工作前，至少安装一种受支持的 runtime：

- **OpenCode：** 不按版本字符串设 gate；兼容性由 direct API 行为判定。
- **Claude Code：** 官方 2.0.0+ 版本，或行为兼容的 fork。fork 的版本字符串可以是
  非标准格式；请使用运行时“测试”操作直接验证协议行为。

即使两者都未安装，daemon 也可以启动，以便先完成配置和诊断。Runtime profile 支持自定义
执行档、模型与 config 目录映射；额外 argv 取决于 driver，当前可用于 Claude Code profile。

### 3. 运行第一个 Task

在 UI 中：

1. 新建或导入 Agent。
2. 直接启动，放入 Workflow，或加入 Workgroup。
3. 选择本地仓库、缓存的 Git URL 或 scratch workspace。
4. 在 Tasks 跟踪执行，在 Inbox 处理待办。

## 平台与安全

| 平台                 | 发布二进制 | Runtime 执行方式            |
| -------------------- | ---------- | --------------------------- |
| Apple Silicon macOS  | 有         | daemon 账户下的普通子进程。 |
| x86_64 / arm64 Linux | 有         | daemon 账户下的普通子进程。 |
| x86_64 Windows       | 有         | daemon 账户下的普通子进程。 |

- **Git 2.38 或更高版本**是 daemon 启动要求，并通过
  <code>git merge-tree --write-tree</code> 提供隔离 merge-back。
- Runtime 子进程不使用 OS sandbox；它们能访问 daemon 账户可访问的文件和网络，因此只应
  运行可信的 Agent、Skill、Plugin 与 MCP 定义。
- Claude runtime profile 可按需开启 <code>IS_SANDBOX=1</code> CLI 兼容标记；默认关闭，
  且不会启用 OS sandbox 或增加平台防护。
- 显式 Agent permission、ACL、秘密脱敏、路径校验、Git 凭据处理和有界进程树回收继续保留。
- Script 节点的 read-only 语义是使用一次性 worktree 且不回合并，并非文件系统 sandbox；
  Script network policy 不再是运行时控制。
- Windows 必须安装 Git for Windows 才能启动 daemon。

当前执行合同见 [OpenCode 运行时配置](./docs/OPENCODE_CONFIG.md)；部署长期实例前请阅读
[灾难恢复](./docs/disaster-recovery.md)。

## 从源码构建

源码构建需要 Bun 1.3.0 或更高版本。

```bash
git clone https://github.com/wangbinquan/agent-workflow.git
cd agent-workflow
bun install --frozen-lockfile
bun run dev
```

贡献前运行：

```bash
bun run gate:local
```

<code>bun run test</code> 会运行 backend、shared 和 frontend 测试。当前协作规范见
[CLAUDE.md](./CLAUDE.md) 与[开发踩坑记录](./docs/dev-gotchas.md)。

## 文档

| 主题                | 指南                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Workflow definition | [当前 Workflow schema](./docs/workflow-yaml.md)                                             |
| 可移植资源          | [配置包](./docs/resource-packages.md) · [Resource Bundle](./docs/resource-bundles.md)       |
| Runtime 行为        | [OpenCode 配置](./docs/OPENCODE_CONFIG.md) · [灾难恢复](./docs/disaster-recovery.md)        |
| 集成                | [Webhook trigger](./docs/webhook-triggers.md) · [Code-host call](./docs/code-host-calls.md) |
| 设计演进            | [RFC 索引与实施计划](./design/plan.md)                                                      |

## 设计文章

- [为什么 AI 时代需要原生的工作流平台](./docs/blog/01-ai-native-workflow-why.md)
- [Agent Workflow 是如何构建出来的](./docs/blog/02-agent-workflow-how.md)

这两篇文章解释产品理念和构建历史，其中的功能快照可能随版本变化；当前行为以本 README、
最新文档和源码为准。

## License

[Apache License 2.0](./LICENSE)
