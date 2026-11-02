# RFC-430 实施计划

**前置**：RFC-429 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                              | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------- | --------- |
| RFC-430-T1 | 选择项类型与键表删三项                                                                            | design §1 |
| RFC-430-T2 | 应用装配与 `crewstation.ts` 的接线                                                                | design §2 |
| RFC-430-T3 | RFC-428 结构锁的已退役清单加三项、guard-manifest                                                  | design §3 |
| RFC-430-T4 | 用例：部署 profile、测试 helper、源码锁与注入方式                                                 | design §4 |
| RFC-430-T5 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI | —         |

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）0 错误（实施中的一次静态检查只列出资源包导出用例一处经该项注入）；改动的 TS 文件 eslint
  `--max-warnings 0` 与 prettier 全部通过。
- **实现门**（本会话自审，只审功能）：托管值与派生值是同一对象（技能内容的包读取方、动作工作区的内容），或是等价的无状态实例（历史限制
  提供者）；单机三项本就缺省。托管的开发工作区装配从对象字面量内部提前到返回之前，它是纯闭包装配，顺序无关。PASS。
- **针对性验证集**（6 worker）：463 个文件，460 个通过。范围是全部架构测试，加上按关键词选出的、读写历史限制 / 技能内容 / 开发工作区 /
  部署选择的用例与 HTTP 测试入口的使用方。3 个失败都是 PostgreSQL 一侧的负载超时（`admin-only-gate`、`rfc359-w5-composition-root-route-surface`、
  `rfc395-v3-validation`）。
- **第二轮**（4 worker）：全部架构测试、改动的用例与第一轮的失败，共 143 个，全部通过。
- **按已提交源码生成报告的用例**：在「HEAD 加本候选」的独立导出仓库里通过：
  - `rfc376-report` 16/16、`rfc370-committed-architecture-source` 2/2；
  - RFC-428 结构锁、RFC-394 架构锁、RFC-317 负例 / 语料下限 / 架构账本、RFC-376 结构门。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。
- **附带**：`scheduler-clarify-dispatch` 多轮追问的一例给 20s 显式预算（RFC-429 CI 红格的归因，见 RFC-429 plan「CI（AC-4）」），
  本地单进程两个 provider 16/16。

## 冲突面

- **生产**：`S/bootstrap/{deploymentProfile,deploymentSelections,daemonApplication,crewstation}.ts`。
- **测试**：design §4 所列。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-3（本地集中验证，见上）
- [ ] 推送后 exact SHA 的 CI 全绿（AC-4）
