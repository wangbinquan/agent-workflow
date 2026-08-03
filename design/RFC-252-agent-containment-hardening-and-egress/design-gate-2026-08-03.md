# RFC-252 设计门 · 2026-08-03

- **结论**：`NEEDS ATTENTION` — 7 P0 / 12 P1 / 1 P2
- **方法**：Codex CLI 0.146.0，`codex exec --sandbox read-only`，从 pin 到 `4bae2aca` 的
  **分离 worktree** 跑（共享树上并发 diff 会吞掉 review）。未走 companion/broker 路径：
  本机当时有并发 session 的 `codex app-server` 常驻，按 `docs/dev-gotchas.md` 的
  `pkill broker` 手法会打断对方，故直驱 `codex exec` 绕开 broker。
- **非空洞证明**：报告自带「已核查且未发现问题的方向」小节，逐条带 `file:line`
  （含 `hermetic.ts:573-585,695-702`、`sealedSubprocess.ts:987-1019,1030-1051,1110-1149`、
  `containmentCoordinator.ts:30-45,192-204` 等），且多条 finding 指向我文档里的**具体错误**
  而非泛泛之谈。
- **边界**：这是设计批准前门，不是用户批准、实现门、提交或发布授权。

## 1. 接受并已折入

| # | Finding | 我的复核 | 处置 |
| --- | --- | --- | --- |
| P0-2a | 我写的 `core.externalDiff` **不是 git 键** | **实测坐实**：`-c core.externalDiff=<脚本>` 不执行；`-c diff.external=<脚本>` 执行（`EXTDIFF_RAN`） | 删除该键；改用子命令级 `--no-ext-diff`。另实测：`-c diff.external=` 会让 git 去执行空命令并报 `cannot run :`，把 diff 直接搞坏 ⇒ 不可用；`--no-ext-diff` 放在子命令**之前**是 `unknown option` ⇒ 必须插在子命令紧后 |
| P0-2b | 漏 `submodule.<name>.update = !cmd` | 坐实：`gitSubmodule.ts:102` 的 `submodule update --init --recursive` **未传** `--checkout`（`:560` 那个调用点传了，故只有前者中招） | `syncSubmodules` argv 固定 `--checkout` |
| P0-3 | 漏 `config.worktree` 与 `.git/modules/**/config` | 成立 | 检测层移出后**自动消解**：`-c` 优先级高于所有 config 作用域，无需枚举 |
| P0-4 | 「无活跃任务就自动重封」会洗白上一任务植入的配置 + 竞态 | 成立，是我引入的真窟窿 | **整个检测/拒绝层移出**（另有用户「不能把功能搞坏」的定调：误报即任务失败） |
| P0-5 | `agent.network` 按-agent 契约在 `dependsOn` closure 下不可实现 | 坐实：`businessContainmentProfile` 入参是 `Pick<…,'agent'\|'mcps'\|'runtimeCmd'>`（`runtime/types.ts:643-645`），看不见 dependents；且全 closure 共用一个 shell wrapper | 授权粒度提升为 **closure 级**，见 design §4.2；顺带修掉它指出的既有缺口 |
| P0-6 | AC-6「100% 无网」与 warn 降级 / off 裸跑矛盾 | 成立 | AC-6 收窄为「containment 实际生效（decision=contained）时」 |
| P0-7 | `hermeticOuter` 走 plan 字段绕过 RFC-233 单一事实源 | 接受（正是我 §7-1 自标的未决项） | G3 整项移出本 RFC；重做时必须走 coordinator-owned profile/capability |
| P1 | 「业务 agent 只有 bash+MCP」说过头 | 成立：有 dependents 时 `task` 会重新 allow，verified 路径也会加载插件 | proposal 背景 A 限定为「这些 built-in FS/Web 工具被 deny」 |
| P1 | manifest codec 升 2 会拒掉存量 v1 | 成立（wrapper 会再次 exec 产品入口，原位升级/恢复旧任务时读得到 v1） | plan T14 改为「v2 writer + v1/v2 reader」 |
| P1 | 三档 fail closed 不是 `#evaluate` 一处改动 | 成立（两条 `off` 提前返回 + warn degraded 分支 + absent capability 集 + 错误类） | plan T12 明确抽纯函数 `evaluateContainment` 并逐处覆盖 |
| P2 | `git config --local --list --null` argv 顺序写反；`alias.*` 无收益 | 成立 | 随检测层一并移出，不再有该 argv；`alias.*` 不再纳入 |

## 2. 驳回 / 降级

| # | Finding | 理由 |
| --- | --- | --- |
| P0-1 | 「Git 不是唯一可直接利用的完整逃逸链」 | **降为措辞级**。它举的 runtime probe（`util/opencode.ts`）、MCP probe（`services/mcpProbe.ts`）、插件安装（`services/pluginInstaller.ts`）**都需要人经 API 触发，agent 无法直接驱动**，不属于「恶意 agent → 主机」链路。已把措辞收紧为「**agent 可直接驱动的**唯一完整逃逸链」，并把这些作为独立的、非 agent 触发的 daemon 侧执行面登记进 `docs/audit-backlog.md` |

## 3. 复核期间另查出的两个 live 问题（不属本 RFC，已登记 backlog）

1. **RFC-251 的 containment 空洞**：profile 只看 root 的 `agent.permission.bash`，
   root `deny` + 闭包成员 `allow` ⇒ `childBoundary:'none'` ⇒ 模型可控 shell 拿不到 netless
   边界。RFC-252 G4 的 closure 级判定会顺带修掉；若 RFC-251 先上库则变存量问题。
2. **插件安装无 `--ignore-scripts`**：`pluginInstaller.ts:222` 实际 argv 无该 flag，
   全仓 grep 零命中，且 `runCommand` 用 `env: process.env` 且不经 containment。
   `docs/audit-backlog.md` 原有条目声称「RFC-247 已加」——**与源码不符**，已在 backlog 更正。

## 4. 门后范围变更（用户 2026-08-03 定调「做安全不能把功能限制住」）

- 原 **G3**（外层遮读 `$HOME` + 全局禁写）→ **移出**：最大破坏面 × 最小即时收益。
- 原 **G1 检测/拒绝层** → **移出**：误报即任务失败。
- 保留 **G1 覆盖层**（已交付）、**G2**、**G4**，三者都对正常 agent 行为零影响或净增功能。

## 5. 原始报告

完整 16k 行会话日志见本机 `scratchpad/rfc252-gate.log`（未入库：含大量工具轨迹，
结论已逐条摘录于上）。
