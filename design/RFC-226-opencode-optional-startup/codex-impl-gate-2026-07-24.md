# RFC-226 Codex 实现门（2026-07-24）

结论：**APPROVED / 0 open findings**。

审查由当前 Codex 会话在本地只读完成。外部 `codex exec` 子进程因环境安全策略禁止潜在源码
外传而未使用；没有绕过该限制。审查范围限定为 RFC-226 自身的生产、测试与文档 hunks；
工作树中并发存在的 embedded frontend cache 改动与 RFC-218 未追踪实现门文件不计入本结论。

## 审查结论

| 关注面               | 结论                                                                                                                                                                                                          | 源码 / 回归证据                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| daemon 启动边界      | `startCommand` 不再解析或执行 OpenCode，也没有 OpenCode 版本失败后的 `process.exit(1)`；git 仍是有界、fail-closed 的平台门，Claude 默认运行时仍只做 soft probe。                                              | `packages/backend/src/cli/start.ts`；`daemon-start.test.ts` missing/poison executable 行为测试；`rfc208-boot-and-external-timeouts.test.ts` 负向源码锁。 |
| health / CLI 兼容    | `/health` 保留 `opencodeVersion` 字段，production 固定传 `null`；contract 接受 nullable，CLI 明示 `(not checked at startup)`，不把未检查误报为 daemon 故障。                                                  | `cli/start.ts`、`cli/status.ts`、`server.ts`、`tests/contracts/registry.ts`、`cli.test.ts`。                                                             |
| 版本门后移           | 显式 OpenCode status 用 `ran && compatible` 生成 `ok`；1.17.9 与不可解析版本均失败。Claude status 保留原 `ran` 语义，没有把 OpenCode 的版本策略扩散到其它协议。                                               | `routes/runtimes.ts`、`rfc135-runtimes-status.test.ts`。                                                                                                 |
| use-time fail closed | RFC-224 official snapshot、verified plan、exact-hash、model、sandbox、source/session identity 生产路径没有被修改；status 仍先经过 official snapshot admission，真实执行仍只消费 driver 生成的 verified plan。 | RFC-224 source reachability / source guard / official builds / verified plan / runtime smoke 定向与全量测试。                                            |
| 过时合同迁移         | README 中英文、troubleshooting、权威设计/计划、RFC-111/112/135/208 与历史测试审计均有当前合同或 supersession 说明；当前源码不再声称 OpenCode 是 boot hard requirement。                                       | `README*.md`、`docs/*.md`、`design/design.md`、`design/plan.md` 与 RFC 文档。                                                                            |

## 门禁证据

- 回归先红：missing OpenCode 会被旧启动硬门拒绝；poison executable 会在旧启动阶段被执行；
  status 对低版本/不可解析版本的旧 `ran` 语义会误报 ready。
- 定向回归：11 个相关测试文件 **349 pass / 0 fail**；其中真实 daemon/CLI 22、runtime
  status 12、RFC-208 7，均 0 fail。
- 全量：backend **7296 pass / 24 skip / 0 fail**，shared **1438 pass / 0 fail**，
  frontend **5257 pass / 0 fail**。
- 静态门禁：typecheck、lint、format check、dependency check 与 `git diff --check` 全绿。
- 发布形态：`bun run build:binary` 成功；生成
  `dist/agent-workflow-macos-arm64`（92.5 MiB），内置 smoke 输出
  `agent-workflow v0.17.0`。

## 最终裁决

实现满足“OpenCode 可选、daemon 启动不校验/不执行；不合格 OpenCode 在显式检验或实际使用时
失败”的用户合同。未发现未关闭的 P0 / P1 / P2 finding。
