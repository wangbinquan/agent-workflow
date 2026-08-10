# RFC-275 · 实施计划

> 状态：Done（2026-08-10）；全部任务与完成定义已由最终本地门禁验证。

## 1. 任务分解

| 任务           | 内容                                                                           | 验收                            |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------- |
| **RFC-275-T1** | RFC 三件套、索引/STATE、用户确认 C1–C5；固定安全 guidance                      | 失败/恢复边界明确，不承诺自动修 |
| **RFC-275-T2** | expected/actual migration chain reader、exact prefix/full comparator、错误类型 | AC-1…4、AC-9                    |
| **RFC-275-T3** | canonical physical manifest/reference/diff，0125 缺列红回归                    | AC-5、AC-6；零业务 row 读取     |
| **RFC-275-T4** | `openDb` pre/postflight 顺序、connection close、skip seam                      | AC-7、AC-8、AC-10               |
| **RFC-275-T5** | `start.ts` fail-closed guidance、lock release、运维文档                        | AC-7；HTTP/scheduler 未启动     |
| **RFC-275-T6** | rolling/fuzz/cross-platform/benchmark、完整 gate、实现门                       | AC-11、AC-12；性能报告落 plan   |

## 2. 预计文件范围

- `packages/backend/src/db/client.ts`
- `packages/backend/src/db/schemaAdmission.ts`（新）
- `packages/backend/src/cli/start.ts`
- `packages/backend/src/services/backup.ts` 或现有 guidance helper（只复用，不改 backup 策略）
- `packages/backend/tests/rfc275-db-schema-admission.test.ts`（新）
- `packages/backend/tests/{db,upgrade-rolling,createindb-snapshot-parity,...}.test.ts` 必要增量
- DB 运维文档、RFC 三件套、索引、STATE

明确不改：现有 migration SQL/meta（除新增测试 fixture 的临时副本）、业务表 schema、HTTP API、
自动 repair、`AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK` 语义。

## 3. 实施顺序

1. 先复制 migration 目录构造“已应用后改文件”与“receipt 对但缺列”红测试。
2. 落 history comparator，接到 migrate 前后；确认 preflight 零写。
3. 落物理 manifest/diff，接 reference，确保每个 connection finally close。
4. 最后接 start guidance、ordering oracle、benchmark 与跨平台。

## 4. 完成定义

- proposal AC-1…12 全有自动化/基准证据；
- 用户现场的 0125 缺列形态在 boot 直接点名，不再到功能 500；
- fresh/rolling/reopen 全绿，数据差异不误报，历史 bytes/物理 DDL 漂移不漏报；
- 失败零自动 repair、零业务数据 egress、连接/daemon lock 可证明释放；
- p95 启动开销达标，`bun run gate:local` 与 Codex 实现门全绿；不擅自 commit/push。
