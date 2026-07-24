# RFC-226 设计门（2026-07-24）

结论：**APPROVED（1 个 P1 已纳入设计并在实现中关闭）**。

审查由当前 Codex 会话在本地只读完成。外部 `codex exec` 子进程因环境安全策略禁止潜在源码外传
而未使用；没有绕过该限制。审查逐项重读 RFC-226 三件套、`cli/start.ts`、
`routes/runtimes.ts`、RuntimeDriver/probe、RFC-224 verified plan 与相关测试。

## Finding

| 级别 | 问题                                                                                                                                                                                                                      | 裁决 / 修正                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | `GET /api/runtimes/status` 当前用 `probe.ran === true` 生成 `ok`，并有测试明确锁定 version-gate-free。若只删除 boot probe，低版本或不可解析版本会在显式运行时检验中误显示 `ok:true`，违反用户补充的“版本门后移而非删除”。 | RFC-226 明确 OpenCode status 的 `ok = ran && compatible`；wire 仍不暴露 `compatible/minVersion`。新增 1.17.9 与不可解析版本负测；Claude Code 保留既有 status 可用性语义。 |

## 复核不变量

- daemon boot 不解析、不执行 OpenCode；
- `/health.opencodeVersion` 保留兼容字段并在生产返回 `null`；
- OpenCode status/Test/models/use-time 仍 fail closed；
- RFC-224 official v1.18.3 exact-hash、model、sandbox、session identity 不变；
- git 仍是平台级启动硬门；
- 不做运行时静默 fallback。
