# RFC-575 `util/errors`、`util/hash` 与 `util/log` 归 platform（RFC-294 W9-D 后继）

- **状态**：In Progress（2026-11-25）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2（“`util/` 中的通用原语归 `platform/`”）、design 的
  目标表（“HTTP 耦合错误、散点 log → platform/errors、platform 观测”，W9-C）与 plan §4.6 W9-D（“逐族搬迁先行推进，不受 W9-C 约束”）；前几批见
  [RFC-571](../RFC-571-util-primitives-into-platform-1/proposal.md)～[RFC-574](../RFC-574-util-paths-and-http-into-platform/proposal.md)。

## 1. 背景

`util/` 还剩 13 个文件。其中 10 个是 git、凭据、文件信任、Windows ACL、OIDC、脱敏与安全路径一族（不在本批）；另 3 个是读者最多的基础原语：

| 文件             | 内容                                                                     | 内部依赖   | 读者（生产 / 用例与助手） |
| ---------------- | ------------------------------------------------------------------------ | ---------- | ------------------------- |
| `util/errors.ts` | `DomainError` 一族、Hono 的错误中间件 `errorHandler`、`diagnosticTextOf` | `util/log` | 约 390 / 约 200           |
| `util/hash.ts`   | `sha1Hex` / `sha256Hex` 与多段 SHA-256（RFC-284 的单步写法唯一出处）     | 无         | 约 190 / 约 80            |
| `util/log.ts`    | 守护进程的结构化日志（`createLogger` / `configureLogger`）               | 无         | 约 190 / 约 115           |

RFC-294 design 的目标表给前两类的去向是 `platform/errors` 与“platform 观测”（W9-C）；plan 写明逐族搬迁可以先于 W9-C 的语义改造推进。

## 2. 目标

- **G1**：`util/errors.ts` 迁入 `platform/errors/domainErrors.ts`（与 `publicError.ts` 同目录），`util/hash.ts` 迁入 `platform/contracts/hash.ts`，
  `util/log.ts` 迁入新目录 `platform/logging/logger.ts`；读者改指，旧位置不留转出。
- **G2**：`legacy-horizontal-files` 101 → 98；其余计数不升（public 类型偏差的条数不变，只有账本里四条的说明符随改）；行为不变。

## 3. 非目标

- W9-C 的语义改造：domain / application 错误去掉 HTTP status、统一经 `platform/errors/publicError.ts` 映射。本 RFC 只搬位置，`DomainError` 一族照旧
  带 status，`errorHandler` 照旧。
- `util/` 余下的 10 个（git、凭据、文件信任、Windows ACL、OIDC、脱敏与安全路径一族）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：三个旧路径不存在，全部源码、用例与脚本不再取它们；`hash.ts`、`logger.ts` 与原文件逐字节相同，`domainErrors.ts` 只差取日志的那一行说明符。
- **AC-2**：行为不变（错误码、HTTP 映射、日志格式与 hash 结果）。
- **AC-3**：`legacy-horizontal-files` 上限 101 → 98；架构报告的归属表删去三行；钉着旧路径的判据、账本与指针随改；新增 RFC-575 用例并登记
  guard-manifest。
- **AC-4**：受影响用例全部通过（本地跑后端全量的 SQLite 一支）；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
