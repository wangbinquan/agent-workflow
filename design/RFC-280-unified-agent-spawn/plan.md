# RFC-280 · 任务分解

状态：Draft（v2 —— 已按设计门 P1-3 修订依赖、按 P2-2 增补 golden/source-lock 归属表）。
PR 拆分原则：每个 PR 独立 `gate:local` 全绿、独立可回滚；过渡用 **adapter 而非双轨**
（旧接口签名保留、内部改走统一层、最后一个消费方切换后同 PR 删除）。
主干开发直推 main，推完按 exact SHA 查 CI。

## 任务表

| 编号 | 任务 | 依赖 | 交付物 |
|------|------|------|--------|
| T1 | **A 层落地（MCP + agent 定义）**：`services/execution/agentInjection.ts` 纯函数集 + `DeclaredManifest`；收敛 4 套 MCP 转换、6 套 agent 定义转换；driver 增 `renderInjection` 钩子；**`buildBusinessSpawn` 签名保留、内部改为 renderInjection adapter（行为字节不变，P1-3）**；同名 fail-fast 断言（P1-1）；双实现对拍测试 → 删被收敛的转换函数（对外接口不删） | — | PR-1 |
| T2 | **A 层补全（skill / plugin / subagent / permission / memory）**：3 套 skill、2 套 plugin、`toClaudeAgents` 并入 A 层；`claudeBusinessGate` 保持单点被 A 层引用；declared 扩 skills/subagents/plugins/tools/droppedParams/unsupported/unobservable | T1 | PR-2 |
| T3 | **C 层落地 + 业务节点告警**：`startupVerification.ts` 纯函数（观测三态，P1-4/P1-5 结构）；claude 接上 `parseStartupInventory`（落差①）；opencode declared 驱动 + inventory `mcp.status()` status/hint 判定（落差②）；`node_runs.startup_verification_json` 迁移列（持久化 `{declared, observation, verification}`）；节点详情 UI banner + 任务列表标记；disabled/droppedParams 告警（落差③④） | T1, T2 | PR-3 |
| T4 | **B 层抽取**：`agentProcess.ts` 实现为 **managedProcess 的 agent adapter**（P2-1，必要能力向后兼容扩展 managedProcess 本体：stdin 投递 / beforeSpawn seam / capture 策略）；完整 `AgentProcessRequest/Result` 契约（P1-2：stdin/beforeSpawn/onSpawned/abortSignal/files containment/reap 后 cleanup/typed outcome）；systemAgentRun 重构为薄封装；intent / narrative 随之切换（行为不变）；**§7.2 有意变更（系统 agent inline 条目统一产出）在此落地并改 `runtime-buildspawn.test.ts` 断言** | T1 | PR-4 |
| T5 | **smoke + distiller 收编**：迁 B 层 + appHome scratch（落差⑤）；删两处自建骨架；**§7.3 有意变更（distiller 源码 grep 锁迁移）在此落地** | T4 | PR-5 |
| T6 | **MCP 测试台收编 + fail 语义**：`mcpTest` capability 并回 RuntimeDriver（落差⑥，`createNativeSessionId`/`sessionReference` 保留为可选方法）；测试台走 A+B+C（spec 强制 `inventoryPlugin:true`，beforeSpawn/onSpawned 经 B 层 seam 原样保留）；`mcp-test-mcp-unusable` + `mcp-test-verification-unavailable` fail 语义（durable 失败码优先，P1-4）+ UI + e2e；**§7.4 有意变更（userinfo URL 放行、删除 `mcp-test-invalid-remote-url` userinfo 分支）在此落地** | T2, T3, T4 | PR-6 |
| T7 | **runner 收编**：runner 的 pump/kill/stdin/PID 段删除改调 B 层；startup 验证经统一回调（T3 已落库面）；**删除 `buildBusinessSpawn` 接口**（最后一个消费方切换，P1-3）；golden/runner-* 全绿；**§7.1 有意变更（claude `--mcp-config` 文件化）与 §7.3 的 runner 源码 grep 锁迁移在此落地** | T2, T3, T4 | PR-7 |
| T8 | **收尾**：死代码清理（`RuntimeMcpTestCapabilityV1`、旧转换残留、`systemAgentRun` 文件头过期承诺注释、`claudeCode/driver.ts:315-323` 虚假 proof 注释）；`docs/OPENCODE_CONFIG.md` / `docs/dev-gotchas.md` 增补；STATE.md / design/plan.md 索引置 Done | T5, T6, T7 | PR-8 |

## 关键顺序说明

- T1 先行且**可独立落地**（P1-3 修订）：`buildBusinessSpawn` 以 adapter 形态保留，
  T1 不需要 B 层存在；接口删除推迟到 T7（最后一个消费方切换时）。
- T3 依赖 **T1+T2**（P1-3 修订：declared 的 skills/subagents/plugins/droppedParams
  字段 T2 才有，避免编译缺口或永久空告警）。
- T3 早于 T7：告警列与 UI 先在现 runner 上生效（用户可感知收益最早到达），
  T7 只换进程骨架，不再动告警面。
- T6 依赖三层齐备，是「测试台严格 fail」行为变更的落点。

## golden/source-lock 归属表（P2-2：必然打红的既有测试逐项归属）

| 既有测试断言 | 打红原因 | owning 任务 | 新断言 |
|---|---|---|---|
| `runtime-buildspawn.test.ts:52-72`（系统 agent inline 条目精确 `{prompt,model}`） | §7.2 统一产出多出 description/permission/options | T4 | 按 `buildInlineAgentEntry` 产出重锁，逐字段说明 |
| `opencode-spawn-pwd-env.test.ts:68-99`（`memoryDistiller.ts` 源码 grep 锁） | T5 删自建骨架 | T5 | 改锁统一执行器的 `cwd/PWD/env` 契约（PWD 钉 worktree 的意图不变） |
| `opencode-spawn-pwd-env.test.ts:36-44`（`runner.ts` 源码 grep 锁） | T7 删 runner spawn 段 | T7 | 同上，锁位置迁到 agentProcess |
| `rfc143-business-spawn.test.ts:265-280` / `runtime-claude-e2e.test.ts:291-300`（`JSON.parse(argv)` 内联 MCP JSON） | §7.1 文件化 | T7 | 断言 argv 为 attemptRoot 内文件路径 + 文件内容与 0600 |
| `mcpTestExecutionMaterial` userinfo 拒绝用例 | §7.4 放行 | T6 | 反转为「userinfo URL 正常注入」+ 删除分支的回归锁 |
| `rfc223-pr6-injection-identity.test.ts:276-305`（同名 fail-fast） | **不打红** | — | 原样保留（P1-1：语义不变），装配层断言另加用例 |

## 验收清单（对应 proposal §8）

- [ ] 全仓唯一 spawn agent 执行器（= managedProcess adapter）；4 处手抄骨架删除（runner 进程段/systemAgentRun 进程段/smoke/distiller）
- [ ] 每类资源转换唯一实现；旧符号（`buildOpencodeMcpTestSpawn`/`buildClaudeMcpTestSpawn`/`prepareMcpTestExecutionMaterial`/`RuntimeMcpTestCapabilityV1`/`buildBusinessSpawn`）零残留
- [ ] 闭包同名 fail-fast 语义与 rfc223 测试原样保留（P1-1）
- [ ] `parseStartupInventory` 有生产调用点（grep 兜底测试锁定）
- [ ] 业务节点 MCP 未连接 → `startup_verification_json`（含 status/hint 原因）落库 + UI banner（前后端测试）
- [ ] 测试台三分支：`mcp-test-mcp-unusable` / `mcp-test-verification-unavailable` / durable 失败码优先（后端 + e2e）
- [ ] disabled-MCP 引用 / claude droppedParams / plugin 缺失均可见（测试锁定）
- [ ] files containment：`..`/绝对路径拒绝、secret 0600+O_EXCL、reap 后 cleanup（P1-7 测试）
- [ ] smoke/distiller 运行目录在 appHome scratch（位置断言）
- [ ] golden spawn 字节锁除 design §7 四处有意变更外零改动，每处按归属表改断言
- [ ] `bun run gate:local` 全绿 × 每个 PR；推完按 exact SHA 查 CI
