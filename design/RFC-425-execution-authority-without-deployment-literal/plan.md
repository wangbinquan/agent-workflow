# RFC-425 实施计划

**前置**：RFC-424 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                             | 依据          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-425-T1 | 端口删 `mode`、三个实现删字面量、`executionStatusOf` 取外部给出的部署种类                                                        | design §1     |
| RFC-425-T2 | profile 新增 `frontendMarker`；`deploymentKind` / `frontendMarker` 从 `daemonStart` 下传到 `server.ts`；生命周期程序改取部署种类 | design §2     |
| RFC-425-T3 | `embed.ts` 按标记注入，删部署比较                                                                                                | design §3     |
| RFC-425-T4 | 结构锁 `rfc425-execution-authority-deployment`（含负例）、RFC-376 基线与计数、RFC-392 锁、用例与夹具、guard-manifest             | design §4、§5 |
| RFC-425-T5 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI                                | —             |

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）在实现完成与补齐用例、锁之后三次均 0 错误（实施中的一次静态自查列出 17 处待改调用点，
  即本 RFC 要改的全部消费方）。改动的 TS 文件 eslint `--max-warnings 0` 与 prettier 全部通过。
- **实现门**（本会话自审，只审功能）：三个执行权实现与托管包装只删 `mode`；`executionStatusOf` 的状态与原因仍取自 authority；`daemonStart`
  从 profile 取出的部署种类与标记作为必填值一路下传，执行状态读取器、HTTP 应用的 SPA 标记与生命周期程序只读它们；生命周期 profile 与改动前
  等价（单机原本因未选执行权回落为 `'standalone'`，托管原本取自托管 authority 的 `'crewstation'`）；`embed.ts` 在标记为 `null` 时原样返回，
  托管页注入的内容不变。自审发现两处覆盖缺口并已补：会话一侧没有按两种 profile 断言收到的部署种类与标记（`rfc394-start-sequence` 补两例，
  夹具不选执行权）；生命周期取部署种类没有锁（结构锁补该条件与两组负例）。PASS。
- **针对性验证集**（6 worker）：403 个文件——以改动的生产文件与三个测试 helper 为种子的反向导入闭包，加全部 134 个架构测试与读源码文本 /
  账本的守卫——399 个通过。两个失败是本 RFC 的缺陷，已修：RFC-317 负例守卫要求新锁带只含伪造单元的负例（补第三组用例）；RFC-394 profile
  用例仍按五个字段断言（改为六个，并断言两个 profile 的标记）。另两个是 PostgreSQL 一侧的负载超时（`api-code-routes`、`api-tasks-repair`）。
- **复跑**：修复后锁 3/3、RFC-317 负例 17/17、语料下限 24/24、RFC-394 profile 9/9、RFC-376 结构门 221/221、RFC-392 统一入口 3/3；补用例与锁
  条件后锁 3/3、`rfc394-start-sequence` 9/9、RFC-394 profile 9/9、RFC-317 负例 17/17 / 语料下限 24/24 / 架构账本 15/15。
- **第三轮**（单进程，负载约 9，本候选与基线 HEAD `556a45573` 的导出对照）：`api-code-routes` 34/34（52 s / 52 s）、`api-tasks-repair`
  26/26（27 s / 28 s），两侧全部通过。负载超时不归本 RFC。
- **按已提交源码生成报告的用例**：在「HEAD 加本候选」的独立导出仓库里，`rfc376-report` 16/16、`rfc370-committed-architecture-source` 2/2
  通过；同一仓库里本 RFC 的锁、RFC-376 结构门、RFC-392 统一入口、RFC-317 负例 / 语料下限 / 架构账本 / 模块边界也通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 冲突面

- **生产**：`SO/application/{ports/executionAuthority,executionStatus}.ts`、三个执行权实现、`S/bootstrap/{deploymentProfile,standalone,crewstation,daemonStart,daemonSession,…}.ts`、
  `S/server.ts`、`S/embed.ts`。
- **守卫与账本**：见 design §4。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [ ] 推送后 exact SHA 的 CI 全绿（AC-5）
