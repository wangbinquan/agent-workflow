# RFC-458 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`L/` = `S/services/`，`TE/` = `S/modules/task-execution/`，
`SH/` = `packages/shared/src/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：`services/` 实现文件按 owner 归位。本 RFC 拆 `L/envelope.ts`：协议解析进 shared（与已在 shared 的渲染半边同处），
  task-execution 专属的端口内容解析与校验失败形状回 task-execution；顺带 `L/scriptPorts.ts`。
- shared 是前后端共用的合同包，任何层都可取；不新增模块 public 导出、不新增目标 DAG 之外的边。

## 1. 去向

| 原位置                                                                                                                                                                                                                 | 新位置                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `L/envelope.ts` 的解析器：`readPortActiveAttr`、`EnvelopeParseResult`、`extractLastEnvelope`、`DetectedEnvelopeKind`、5 个错误前缀、`detectEnvelopeKind`、`extractClarifyEnvelopeBody`、`parseEnvelope` 与私有正则助手 | `SH/workflowOutputEnvelope.ts`（shared 入口 `export *`） |
| `L/envelope.ts` 的 `serializePortValidationFailures`、`parsePortValidationFailuresJson`                                                                                                                                | `TE/application/portOutputValidation.ts`                 |
| `L/envelope.ts` 的 `resolvePortContentDetailed`、`resolvePortContent`                                                                                                                                                  | `TE/composition/portOutputValidation.ts`                 |
| `L/envelope.ts` 的再导出（`PortValidationError`、`NODE_VALIDATE_IO`、两个类型）                                                                                                                                        | 删除；消费方直取声明处                                   |
| `L/scriptPorts.ts`                                                                                                                                                                                                     | `TE/domain/scriptPorts.ts`                               |

## 2. 消费方改指

- intent `application/turnEngine.ts`、memory `application/distill/distillerOutput.ts`：`extractLastEnvelope` / `parseEnvelope` 改取
  `@agent-workflow/shared`（`R2` −2）。
- task-execution `application/taskAgentRun.ts`：解析器改取 shared，端口内容 / 校验失败改取本模块（`R2` −2，类型与值各一条）；`composition/agentNodeExecution.ts`、
  `infrastructure/taskRouteOperations.ts`：`CLARIFY_FORBIDDEN_PREFIX` 取 shared、`parsePortValidationFailuresJson` 取本模块 application；
  `composition/scriptNodeExecution.ts` 取 `domain/scriptPorts`。
- `L/commitPush.ts`：解析器与 `DetectedEnvelopeKind` 改取 shared。
- 用例：20 个经旧路径取的用例按导出名分流（解析器 → shared；端口内容 / 校验失败 / `PortValidationError` / `NODE_VALIDATE_IO` → task-execution
  声明处）；`rfc253-script-execution` 取 `domain/scriptPorts`。

## 3. 用例与锁

- **新用例** `T/rfc458-envelope-parser-to-shared.test.ts`：两个旧文件不在、`S/` 与用例零引用旧路径（census AST，带负对照）；解析器的每个
  导出在全仓只有 shared 一处定义；`resolvePortContentDetailed` 与 `resolveNativePortContentDetailed` 对同一输入结果相同、`resolvePortContent`
  取其 `body`；校验失败序列化往返不变、坏 JSON 回落 `null`；intent / memory / task-execution 的 application 层不再取 `@/services/`
  里的信封。
- **按路径读源码的锁**改指新位置：`envelope-prefix-swap-source`（读 envelope 源码）、`rfc080-runtime-migration-source-guard`、
  `opencode-integration-path-coverage`（路径清单；同时核对 `.github/workflows/integration-opencode.yml` 的路径过滤）、架构报告 legacy
  归属表删去 2 条；测试与 shared 注释里描述现状的路径改指（`outputKinds/list.ts`、`outputKinds/path.ts` 的行号锚点改为函数名锚点）。
  迁移前按 `docs/dev-gotchas.md`「移动/重命名源文件后至少扫这三种形态」全仓搜。
- **账本**：`commons-debt.json` 的 `R1`（`L/envelope.ts` → task-execution 内部 7 条）与 `R2`（4 条）按实测销账。

## 4. 留下的债

- `L/commitPush.ts`、`L/commitPushRunner.ts`（source-control 一族）；`nodeRunMint`、`systemAgentRun`、`sessionEventSink`、`ref/runtimeRef`、
  运行时驱动一族贡献的其余 `R2`。

## 5. 失败模式

- 漏改的消费方：tsc 兜底；按导出名分流时漏分的名字 tsc 报「没有导出成员」。
- shared 里出现同名导出冲突：迁入前核对 shared 入口无同名导出（已核：12 个导出名在 shared 中均未出现）。
- 前端包体：shared 新模块不被前端 import，按 tree-shaking 不进包。

## 6. 测试策略

迁移所涉用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；shared 包的用例；新用例见 §3；P0 变异 lane 两引擎各 17 阶段。
