# RFC-571 `util/` 的八个通用原语归 platform（RFC-294 W9-D 后继）

- **状态**：Done（2026-11-24，落地 `2335b2bcc`；同日补迁 `inFlight` 与 `sqlChunk`（`1db8cc54f`），见 design §7 与 plan「补迁」一节）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2（“`util/` 中的通用原语归 `platform/`”）与 plan §4.6 W9-D；
  做法沿用 [RFC-457](../RFC-457-services-platform-mechanisms/proposal.md)（平台机制原样迁入、消费方改指、不留转出）。

## 1. 背景

legacy 横向目录还剩 123 个文件，其中 `util/` 35 个。架构报告的归属表早就把它们标成了去向：git / 凭据一族归 source-control，其余归 platform。这里先搬
八个**没有任何内部依赖的纯原语**（不取 `util/` 的其他文件、不取模块、不碰文件系统与进程）：

| 文件                       | 内容                                 | 现在的读者                                          |
| -------------------------- | ------------------------------------ | --------------------------------------------------- |
| `util/semver.ts`           | 版本号的提取与比较                   | runtime-management 的三个驱动文件                   |
| `util/time.ts`             | 严格递增的更新时间 `monotonicNow`    | resource-catalog 的七个文件                         |
| `util/keyedSerialQueue.ts` | 按键串行的队列                       | 五个模块的五个文件                                  |
| `util/jsonDocument.ts`     | 把序列化的投影解析成闭合的 JSON 类型 | 两个模块的 HTTP 入站与两个路由                      |
| `util/zodJsonSchema.ts`    | 入参合同的 JSON Schema 输出          | `mcp/` 两个文件与 development-automation 的两个文件 |
| `util/frontmatter.ts`      | Markdown frontmatter 的解析与回写    | resource-catalog 的三个文件                         |
| `util/zip.ts`              | 字节可复现的 zip 编码                | resource-catalog 的配置包导出                       |
| `util/version.ts`          | 二进制版本标识                       | `main.ts`、bootstrap 与 platform 的备份清单         |

## 2. 目标

- **G1**：八个文件原样迁入 `platform/` 的对应目录，读者改指新位置，旧位置不留转出。
- **G2**：`legacy-horizontal-files` 123 → 115（上限同步收紧到实测）；其余计数不升；行为不变。

## 3. 非目标

- `util/` 余下的 27 个：`errors` / `hash` / `log` 三个读者上千处的另立；git、凭据、文件信任、Windows ACL 与 OIDC 一族不在本 RFC；依赖其他 `util/`
  文件或文件系统的（`archive`、`fsReclaim`、`migrationsFolder`、`spawnDiagnostics`、`daemonInfo` 等）随它们的依赖一起迁。
- `timeoutSignal`、`inFlight` 与 `sqlChunk`：读者里有 `auth/oidc/`、身份认证与任务授权的文件，本 RFC 不碰那几处，随它们各自的后继。
  **2026-11-24 补迁**：RFC-572 对这类读者的做法是只改 import 说明符那一行；`inFlight` 与 `sqlChunk` 按同样的做法迁入 platform（design §7、
  plan「补迁」一节）。`timeoutSignal` 这次没有动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：八个旧路径不存在，全部源码、用例与脚本不再取它们；新位置的文件内容与原文件相同（只有文件头里提到自身路径的注释随改）。
- **AC-2**：行为不变；新位置的文件不取模块、不取 `util/`。
- **AC-3**：`legacy-horizontal-files` 上限 125 → 115（实测 123 → 115）；架构报告的归属表删去其中登记过的七行；新增 RFC-571 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
