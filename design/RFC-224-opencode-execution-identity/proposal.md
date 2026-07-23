# RFC-224 opencode 执行身份完整性（从 RFC-223 拆出）

- 状态：Draft / Deferred（2026-07-23 从 RFC-223 设计门 round-8 拆出；`design.md` / `plan.md` 待接手时补齐）
- 关联：RFC-223（多租户资源标识——本 RFC 承接其 §6 拆出的执行完整性关切）

## 1. 背景（本机 opencode v1.18.4 源码实证）

平台一直有一条**错误假设**（CLAUDE.md「Resolved open questions」）：『`OPENCODE_CONFIG_CONTENT` 内联 JSON 合并优先级最高，平台注入的 agent 恒胜』。RFC-223 设计门核实本机 opencode 源码后确认此假设**不成立**——inline 合并于 `config/config.ts:468-475`，其**之后**仍有多层合并进 `result.agent`：

| 覆盖向量 | 锚点 | 效果 |
|---|---|---|
| active-org 配置 | `config.ts:481-507` | 远端配置覆盖同名 agent（且吞拉取失败） |
| managed 目录 | `config.ts:516-523` | 企业 managed config 覆盖 |
| macOS MDM `.mobileconfig` | `config.ts:524-531`（注释 "override everything"） | MDM 覆盖一切 |
| legacy `mode.<name>` | `config.ts:536-542`（来自 global/project JSON `:398-410`，即 worktree `.opencode/`） | 覆盖 + `mode:subagent`/`disable:true` 令 `--agent` 回退默认（`agent.ts:268,287,333-338`） |
| `OPENCODE_PERMISSION` env | `config.ts:545-550`；平台 `spawn.ts:170-171` **原样继承 daemon 全部 env** | permission 覆盖 |
| 同名 MCP | `inlineConfig.ts:158-164` + 上述层 | command/url/env/headers/oauth 被替换，MCP 进程级暴露给全部 agent |

注册表按 **name** 应用这些字段（`agent/agent.ts:267-294`）。

**多租户放大**：RFC-223 让平台按稳定 id 精确选定 tenant agent 并按 name 注入；但上述任一外部层用同名配置即可替换其 prompt/model/permission/mode，或让 MCP 变成另一命令端点——**跨 owner agent 跑在某 repo 时，该 repo 的 `.opencode/` 可覆盖注入的 agent**，构成跨租户执行完整性风险。这是**先于多租户就存在**的缺陷，与「name 唯一性放开」正交，故独立立 RFC。

## 2. 目标 / 非目标

**目标**
- G1 保证平台按 id 选定并注入的 agent / 受控 MCP，其**最终 effective 执行身份**与注入定义一致，否则 fail-closed 拒启动。

**非目标**
- N1 不改 opencode 的合并顺序（外部行为）。
- N2 不接管 repo-local project skill 的 opencode 自发现（RFC-223 §6 已诚实划界）。

## 3. 拟采方案（待 design.md 细化）

「**枚举来源」是 whack-a-mole**（RFC-223 逐轮证明：3 源→+mode+permission→+MCP+atomicity）。正解是**面向最终 resolved config 的规范化指纹校验**：

1. **同进程原子**：校验必须发生在真实 `opencode run` 的**同一进程**、最终 registry 已解析但 session 尚未执行的边界（独立 probe 有 TOCTOU：首拉失败→二拉成功；fork 可伪报）。或**完全隔离 + 固定快照**外部 config。
2. **全字段指纹**：对每个受控 agent 的最终 `Agent.Info`（存在性、注册键/name、mode/disable、prompt/model、全部执行字段、顶层+agent 合并后的 permission）+ 每个受控 MCP 的完整规范化定义比对注入值；不一致或缺失 → 拒启动。root/dependents/system-agent 全覆盖。
3. **版本 / fork 门**：未知 opencode 版本、自定义 fork、探测异常一律 fail-closed；定义可验证的官方二进制身份。
4. **CLAUDE.md 勘误**：更正「Resolved open questions」的 inline-恒胜断言（`config.ts:641` 旧锚失效）。

RFC-223 已先行做的**廉价兜底**（不属本 RFC 但相关）：子进程 env 剔除 `OPENCODE_PERMISSION`（一处向量）。

## 4. 验收标准（草案）

- AC1 注入 agent 被任一外部层（active-org/managed/MDM/mode/permission/env）覆盖或回退 → 拒启动（同进程、非 TOCTOU）。
- AC2 受控 MCP 的**任一规范化字段**（command/url/environment/headers/oauth/timeout/enabled …完整字段族）被替换 → 拒启动。
- AC3 `disable:true`/`mode:subagent` 令 `--agent` 回退（`agent.ts:268,287` + `cli/cmd/run.ts:595-667`）→ 拒启动。
- AC4 未知版本 / fork / 首拉失败二拉成功 / probe-run 间配置变更 → fail-closed。
- AC5 CLAUDE.md「Resolved open questions」勘误。

> design.md（接口/同进程 hook 点/指纹规范化算法/失败模式）与 plan.md（任务/PR 拆分）在接手实现时补齐。
