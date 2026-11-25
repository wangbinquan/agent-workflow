# RFC-574 `util/paths` 与 `util/http` 归 platform（RFC-294 W9-D 后继）

- **状态**：Done（2026-11-25，落地 `fd3126d20`，修正 `9083e8331`、`62a3f20a4`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2（“`util/` 中的通用原语归 `platform/`”）与 plan §4.6 W9-D；
  前几批见 [RFC-571](../RFC-571-util-primitives-into-platform-1/proposal.md)、[RFC-572](../RFC-572-util-process-family-into-platform/proposal.md) 与
  [RFC-573](../RFC-573-util-small-files-placement/proposal.md)。

## 1. 背景

`util/` 还剩 15 个文件。读者数百处的五个里，`paths` 与 `http` 读者最少：

| 文件            | 内容                                                                                | 内部依赖      | 读者                                                                                 |
| --------------- | ----------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `util/paths.ts` | 安装目录（`AGENT_WORKFLOW_HOME`）与其下各文件、目录的位置；源码树里两条迁移链的目录 | 无            | 48 个生产文件，42 个用例 / 助手 / 脚本                                               |
| `util/http.ts`  | HTTP 请求的解析：布尔 query 参数、两种 JSON 正文解析                                | `util/errors` | 31 个生产文件（22 个 `routes/`、8 个模块 `inbound/`、1 个 infrastructure），3 个用例 |

另外，前两批留下一处漏改：有三个用例用**正则**写“这些文件不许取哪些路径”（`util\/(?:lock|paths|migrationsFolder)` 这样的写法），按路径的文本
检索找不到它们。`util/lock`（RFC-572）与 `util/migrationsFolder`（RFC-573）迁走后，其中两条正则就再也匹配不到这两个文件的新位置——判据还在，
却不再拦它要拦的东西。

## 2. 目标

- **G1**：`util/paths.ts` 迁入 `platform/configuration/installationPaths.ts`，`util/http.ts` 迁入 `platform/http/requestParsing.ts`；读者改指，旧位置
  不留转出。
- **G2**：`legacy-horizontal-files` 103 → 101；其余计数不升；行为不变（含两条迁移目录的解析结果）。
- **G3**：三个用正则写的“禁止取”判据改认新位置，并补上自证：伪造的越界 import 必须被认出。

## 3. 非目标

- `util/` 余下的 13 个：`errors` / `hash` / `log` 另立；git、凭据、文件信任、Windows ACL、OIDC、脱敏与安全路径一族不动。
- 不拆 `Paths`（两条源码树迁移目录与安装目录同在一个对象里，读者不变）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：两个旧路径不存在，全部源码、用例与脚本不再取它们；`requestParsing.ts` 与原文件逐字节相同；`installationPaths.ts` 与原文件只差两处
  “回到 backend 包根”的层数（文件深了一层）。
- **AC-2**：行为不变：`Paths.migrationsDir` 与 `Paths.postgresqlMigrationsDir` 仍解析到 `packages/backend/db/` 下的两条迁移链（有用例直接断言）。
- **AC-3**：`legacy-horizontal-files` 上限 103 → 101；架构报告的归属表删去两行；三个正则判据改认新位置并各带自证；新增 RFC-574 用例并登记
  guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
