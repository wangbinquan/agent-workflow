# RFC-windows — 全功能 Windows 适配（Windows adaptation）

状态：Draft（待用户批准 → 进入实现）
触发：用户 2026-07-07「将这个工程的所有功能都适配 windows」。现 README Requirements 明写「OS: macOS or Linux / Windows is not supported in v1」。

**策略演变**：初版（2026-07-07）选策略 C（daemon 原生 + opencode 经 WSL），因当时假设 opencode 原生 Windows 不可行。**2026-07-08 用户改走策略 D（原生 opencode，不用 WSL）**，并授权实测。实测结果（2026-07-08，opencode-ai 1.15.5 全局装于 Windows）：`opencode run "..." --format json --thinking --dangerously-skip-permissions` 在原生 Windows 上**完整跑通**——spawn 成功（Bun 解析 `opencode.cmd` shim）→ 调用 LLM（阿里云 glm-5.2）→ 返回 `pong` → stdout 吐完整 JSON 事件流（`step_start`→`text`→`step_finish`，正是平台 `parseEvent` 的格式）→ 干净退出。**结论：opencode 原生 Windows 可用，无需 WSL，无需新 driver，无 RFC-143 依赖。** PR-3 从「建 wsl-opencode driver」收窄为「验证现有 `runtime/opencode/` driver 在 Windows 跑通 + 修小坑 + 文档」。

PR-1/2/4/5 已按策略 C 的非-WSL 部分（平台原语 / 文件系统+ACL / MCP+备份 / 构建+CI）落地，这些与 WSL 无关、对策略 D **完全复用**。仅 PR-3 与 RFC 文档需从 WSL 枢转为原生。

---

## 1. 背景

平台的核心能力是 spawn `opencode run` 子进程。整个 daemon、git worktree 任务、review/clarify、记忆、ACL、结构化 diff 都是围绕这个能力搭的。但：

1. **opencode 是 Node CLI（npm `opencode-ai`），原生 Windows 可运行**——2026-07-08 实测确认（见上「策略演变」）。初版假设的「opencode 不支持 Windows、须走 WSL」已被推翻。
2. daemon 自身有一批 POSIX-only 假设散落在 `util/` 与 `services/`：进程组 group-kill、`SIGTERM`/`SIGKILL` 升级、`ps -p <pid> -o command=` 指纹、external skill symlink、`file://` 字符串拼接、`tar` 备份、`chmod 600` 敏感文件隔离。这些在 Windows 上要么静默失效（chmod=安全回归），要么直接报错（`ps` 找不到、负 pid kill 无效）。

取证（2026-07-07 快照，file:line 见 design §2）确认：单实例 PID-file 锁（`util/lock.ts`）已跨平台；全后端 spawn 均用 argv 数组、无 `sh -c`——这两点是干净地基。其余 13 类 blocker 需要逐层适配（PR-1/2/4/5 已收口）。

## 2. 目标 / 非目标

### 目标

- **在 Windows 10/11 + Windows Server 2022 上原生运行 daemon**，覆盖现有全部功能面：agent/skill/MCP/plugin、工作流编辑、git worktree 任务、review/clarify、长期记忆、多用户 ACL、结构化 diff。
- **单二进制 `agent-workflow-windows-x64.exe`** 走 GitHub Releases 分发，CI 矩阵加 `windows-latest`。
- **与 POSIX 共用一套源码**：平台分支收敛到 `util/platform.ts`，业务层（runner/scheduler/routes）零 `if (process.platform === 'win32')` 散落。
- **opencode 原生 Windows 直跑**：现有 `runtime/opencode/` driver（`buildOpencodeSpawn` → `['opencode','run',...]` + env）在 Windows 上直接可用，**不建新 driver、不走 WSL、不依赖 RFC-143**（2026-07-08 实测确认）。
- **安全模型等价闭合**：symlink/ACL 攻击面、敏感文件隔离在 Windows 上不得降级。

### 非目标

- **不改 opencode 上游**：它是外部 CLI，行为以源码为准（CLAUDE.md 强制）。
- **不用 WSL**：用户 2026-07-08 明确不走 WSL 方案。opencode 原生 Windows 已验证可用。
- **不支持 Windows Server Core 精简版 / 容器化**：v1 不覆盖。
- **不降级安全**：`chmod 600` 在 Windows 是 no-op，必须用 ACL 等价替代，不留「测试在 Windows 跑绿了但文件实际全可读」的隐患。

## 3. 用户故事

- **作为 Windows 用户**：我想 `agent-workflow doctor` 在我的 Windows 机器上跑出全绿（含 opencode/git/long-path/ACL 检查），然后端到端跑通一次 Code→Audit→Fix 任务，而不是被一句「Windows not supported in v1」挡在门外。
- **作为运维**：我想 daemon 原生跑在 Windows 上（开机自启、单实例锁、HTTP/WS 服务），spawn opencode 子进程时直接调本机 `opencode.cmd`——业务工作流定义、git worktree、review/clarify 全部照常，无需装 WSL。
- **作为维护者**：我想让所有平台差异收口到 `util/platform.ts`，而不是在 runner/scheduler/routes 里 grep 出几十处 `if (windows)`——新增 POSIX 行为变化时一处改、两边对齐。
- **作为安全 review 者**：我想确认 `secret.key` / `token` 在 Windows 上用 ACL 真的只对当前用户可读，而不是 chmod 的 no-op 静默放过。

## 4. 验收标准

1. **Windows doctor 全绿**：`agent-workflow doctor` 在装了 opencode+git 的 Windows 机器上全绿，含 opencode 版本 / git / long-path / ACL 检查。
2. **端到端任务跑通**：Windows 上启动一个 Code→Audit→Fix 工作流任务（git wrapper + fan-out + review gate），全链路成功，任务详情/diff/review/clarify 各 tab 正常。
3. **杀树等价性**：opencode 子进程卡死时，Windows 的 `taskkill /T /F` 机制能收回子树（等价 POSIX group-kill 的 v1 形态）；回归测试。Job Object 硬化列未来。
4. **ACL 安全闭合**：`secret.key` / `token` 在 Windows 上用 `icacls` 实证仅当前用户可读（测试断言 ACL，不能只看文件能写）。
5. **POSIX 零行为变化**：`runtime-opencode-golden.test.ts` 及既有 kill/stop/lock/symlink/file:// 测试在 POSIX 上 byte-for-byte 绿；平台分支只在 `util/platform.ts` 内。
6. **业务层零平台散落**：`rg -n "process\.platform\s*===\s*'win32'" packages/backend/src`（排除 `util/platform.ts` + tests）零命中。
7. **单二进制构建**：`bun run build:binary` 在 `windows-latest` CI 上产出可运行的 `agent-workflow-windows-x86_64.exe`，smoke 通过。
8. **门禁全绿**：typecheck×3 / lint / format / 后端 bun test 全量 / 前端 vitest / binary smoke / Playwright e2e（Windows）/ CI Windows matrix。
9. **Codex 设计门 + 实现门**：设计门（本文档批准前）+ 实现门（每 PR 代码后）各跑一轮。

## 5. 相关 RFC / 挂钩

- **RFC-111**（runtime 抽象引入）：opencode driver seam 的起源。策略 D 复用现有 `runtime/opencode/` driver，**不新增 driver**，故**不依赖 RFC-143**（RFC-143 的「注册即扩展」仍是未来第三方 runtime 的接合点，但 Windows 原生 opencode 用既有 driver 即可）。
- **RFC-067**（per-task git identity）、**RFC-099**（资源 ACL）、**RFC-029**（inventory 插件）：这些能力在 Windows 上经既有 opencode driver 透传，本 RFC 保证其行为等价。
- **flag-audit §4.1**：与本 RFC 无直接耦合（策略 D 不扩 driver 注册表）。
