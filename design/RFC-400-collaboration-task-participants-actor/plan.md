# RFC-400 实施计划

**前置**：RFC-399 Done。由 Codex 实施、本会话审核。全部实现与用例完成后集中验证一次；两部分分两次派发只是为了让单次实施的
范围可控，派发之间不做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-400-T1 | TE 参与者合同与唯一工厂：E / S / D（改异步、补 brand 与工厂）/ M / H 五个 InTx 合同、L operations 合同、请求 DTO（`HumanGateNodeRunMintRequest`）；`nextRetryIndex` 经 `public/queries` 具名导出；工厂经 TE `composition.ts` 交出 | design §2.1 |
| RFC-400-T2 | COL 内部装配输入 `TaskExecutionParticipantBindings`；17 个调用点改用注入的工厂与 TE public 类型；bootstrap（`crossContextClosure.ts`、`daemonModules/taskExecution.ts`、`daemonHttpComposition.ts`、`daemonSession.ts`）与测试 helper 显式接线 | design §2.1 |
| RFC-400-T3 | 删除 `services/humanGateComposition.ts`：五个消费者直接引用定义处；`commandContext` 拆为 `COL/a/commandContext.ts` 与 `COL/i/collaborationCommandContext.ts`；缺省 inspector 包装迁入 `COL/i/` | design §2.2 |
| RFC-400-T4 | 13 个声明源的 `Actor` / `ActorSource` 换为 AAS；实现、路由、装配同步改标注 | design §2.3 |
| RFC-400-T5 | RM `RealtimeCompositionPolicy` 移至 `application/ports`，经 RM `composition.ts` 交出 | design §2.3 |
| RFC-400-T6 | 账本：`rfc294-architecture-preflight`（17 对、`PUBLIC_SURFACE_DEBT`、`CAPABILITY_COMPATIBILITY_DEBT`）、`rfc376-structural-guards` 基线、`architecture/counts.json`、`architecture/commons-debt.json`、`architectureReport.ts` bridge 映射、`guard-manifest.json`（新守卫）；RFC-310 两个锁按实测核对 | design §2.4 |
| RFC-400-T7 | 新增结构锁 `T/architecture/rfc400-collaboration-task-participants.test.ts`（含负例）；搬迁涉及的既有用例只改 import、构造与源码锚点；`fixtures/rfc359-p0-mutations.ts` 的变异靶点迁到真实新位置 | design §2.4、§3 |
| RFC-400-T8 | 文档：RFC-294 design §3.1「现状偏差」、plan §3 S5 状态；`docs/dev-gotchas.md` 视需要补一条 | — |
| RFC-400-T9 | 集中验证（design §3），修复本 RFC 引入的问题后复验相关范围；后端全量要跑（含根目录守卫） | design §3 |

**派发**：第一次 T1～T3（Part A），第二次 T4～T8（Part B，含账本收口）；T9 由本会话执行。

**依赖**：T1 → T2；T3 与 T1/T2 同属 Part A（同一批文件）；T4 → T5；T6、T7 在全部实现之后；T9 最后。TE `public/participants.ts`、
`public/queries.ts`、`composition.ts` 两部分都会改，两次派发顺序进行，不并行。

## 冲突面

- `bootstrap/crossContextClosure.ts`、`bootstrap/daemonModules/taskExecution.ts`、`bootstrap/daemonHttpComposition.ts`、
  `bootstrap/daemonSession.ts`、`bootstrap/daemonApplication.ts`；
- TE `public/participants.ts`、`public/queries.ts`、`public/commands.ts`、`public/taskRoutes.ts`、`composition.ts`；COL `composition.ts`；
- `T/rfc294-architecture-preflight.test.ts`、`T/architecture/rfc376-structural-guards.test.ts`、`architecture/*.json`。

并发会话 RFC-398 的改动面（`main.ts`、`bootstrap/daemonStart.ts`、`bootstrap/epochMigration*`、`platform/persistence/*`、
`modules/system-operations/**/epochSwitch*`、`scripts/release-upgrade/**`）与本 RFC 没有必需的同文件交集；`daemonSession.ts` 与启动装配
相邻，实施前与提交前按路径核对工作树，共同文件保留双方内容。

## 验收清单

- [ ] proposal AC-1～AC-4
- [ ] 推送后 exact SHA 的 CI 全绿（AC-5）
