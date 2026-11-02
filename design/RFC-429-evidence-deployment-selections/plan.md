# RFC-429 实施计划

**前置**：RFC-428 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                               | 依据      |
| ---------- | -------------------------------------------------------------------------------------------------- | --------- |
| RFC-429-T1 | 选择项类型与键表删四项                                                                             | design §1 |
| RFC-429-T2 | 应用装配、开发目的根、开发自动化模块组、托管 evidence 装配与 `crewstation.ts` 的接线               | design §2 |
| RFC-429-T3 | RFC-428 结构锁的已退役清单加四项、guard-manifest                                                   | design §3 |
| RFC-429-T4 | 用例：注入方式改走 `evidenceArtifacts` / `developmentPurposes`、源码锁、部署 profile 与测试 helper | design §4 |
| RFC-429-T5 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI  | —         |

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）在补齐用例后 0 错误（实施中一次静态检查列出 7 个仍经这四项注入的用例文件，即需要改走
  `evidenceArtifacts` / `developmentPurposes` 的全部用例）；改动的 TS 文件 eslint `--max-warnings 0` 与 prettier 全部通过。
- **实现门**（本会话自审，只审功能）：托管时各回落取到的是同一个 `evidenceArtifacts` 对象的同名成员（读取三成员、尝试上下文、任务输入落盘），
  需求文档命令仍经 `developmentPurposes`；单机时四项本就缺省，默认值不变。PASS。
- **针对性验证集**（6 worker）：359 个文件，355 个通过。范围是全部架构测试，加上按关键词选出的、读写 evidence / 需求目的 / 开发自动化装配 /
  部署选择的用例与 HTTP 测试入口的使用方。4 个失败：
  - 三个 PostgreSQL 负载超时（`admin-only-gate`、`rfc359-w5-composition-root-route-surface`、`rfc395-t19-migration-prep`）；
  - `rfc396-mr-bridge` 的 R24 在两个 provider 上以约 5s 超时（该文件第一轮用时 258s）。
- **第二轮**（4 worker）：全部架构测试、改动的用例与第一轮的失败，共 149 个，148 个通过。`rfc396-mr-bridge` 全部通过（200s）；
  余下 `admin-only-gate` 一例 PostgreSQL 钩子超时。
- **第三轮**（单进程，本候选与基线 HEAD `e41e5dbde` 的导出对照）：`admin-only-gate` 两侧 44/44（27 s / 28 s）。负载超时不归本 RFC
  （它在 RFC-428 的本地验证里也同样在多 worker 下超时、单进程两侧通过）。
- **按已提交源码生成报告的用例**：在「HEAD 加本候选」的独立导出仓库里通过：
  - `rfc376-report` 16/16、`rfc370-committed-architecture-source` 2/2；
  - RFC-428 结构锁、RFC-394 架构锁、RFC-317 负例 / 语料下限 / 架构账本 / 模块边界、RFC-376 结构门。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## CI（AC-4）

`338d7db0c` 的主 CI（运行 41451156966）68/70；windows-platform（41451156965）与按路径触发的 maintenance-soak-nightly（41451156974）全绿。
主 CI 红了一格，汇总门 `CI required` 随之红：

- **backend shard 43/44**：`scheduler-clarify-dispatch` 的「带反问通道的代理改发 `<workflow-output>` → clarify-required」[postgresql] 以
  5485ms 越过 bun 默认 5s。
  - 该例让 mock 在多次追问重试里反复输出，要跑多轮运行时；同文件的 clarify-no-channel 例为同样原因早有 20s 预算。
  - 前两个提交上它在 PostgreSQL 一侧用时 1.7～1.8s（`c96f2c907` / `e41e5dbde`）。
  - 本 RFC 只改 evidence 一组的部署选择项接线，与调度器、反问分派无关，不归本 RFC。
  - RFC-430 给该例 20s 显式预算。

AC-4 以包含本 RFC 的后继提交（RFC-430）的 CI 作后继证据收尾。

## 冲突面

- **生产**：
  - `S/bootstrap/{deploymentProfile,deploymentSelections,daemonApplication,developmentPurposeRoot,crewstation}.ts`；
  - `S/bootstrap/daemonModules/developmentAutomation.ts`；
  - `S/modules/development-automation/composition/crewstationEvidence.ts`。
- **测试**：design §4 所列。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-3（本地集中验证，见上）
- [ ] 推送后 exact SHA 的 CI 全绿（AC-4）
