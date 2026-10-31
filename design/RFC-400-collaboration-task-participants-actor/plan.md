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

## 实施记录（2026-10-31）

**派发**：Part A（T1～T3）与 Part B（T4～T8）在同一个可写 Codex 线程内完成（`01a191d4-4c7a-7b70-b8ad-7485af335a4f`；先前一次续用
只读调研线程的派发因沙箱只读而零改动，作废）。两部分之间本会话审读改动并实测 W0-R 账本差异，据此在 Part B 开头修正了合同写法；
不做功能验证。改动 169 个路径（含删除 `services/humanGateComposition.ts`、`collaboration/composition/commandContext.ts`）。

**结构门（`815d9ce6c` → 候选，实测）**：

| 门 | 前 | 后 |
| --- | ---: | ---: |
| 跨 context 内部文件对 | 73 | 56 |
| 其中 COL → TE | 17 | 0 |
| `PUBLIC_SURFACE_DEBT` | 137 | 120 |
| `CAPABILITY_COMPATIBILITY_DEBT` | 22 | 18 |
| RFC-317 R1 / R2 | 229 / 41 | 220 / 41 |
| legacy 横向文件 / services 业务实现（上限） | 390 / 219 | 389 / 218 |
| 越出 DAG 的 offered、值级 SCC、越界值级对、`platform` → `modules`、`export *` 桶、不可达 | 54 / 0 / 0 / 0 / 21 / 27 | 不变 |

depcheck 通过（0 条存量违规，九环未重现）。RFC-310 两个锁零差异。不新增 DAG 边。

**偏差**：见 proposal §6 第 10 条。

**实现门**（Codex 只读、只审功能，线程 `01a19204-2136-7e41-9bda-f18ed1b79015`）：FAIL，2 条 P2，都在变异验证链路，已修：
`scripts/rfc359-p0-mutations.ts` 的源文件指纹清单仍列已删除的 `collaboration/composition/commandContext.ts`（runner 读 ENOENT，
`rfc359-w14-p0-mutation-verdict` 的「指纹路径都存在」失败）→ 改列拆分后的两个文件；P0-8 的三条栈位置判据与 verdict 测试的规范化记录
仍要求旧虚拟模块 → 改为真实的 `collaboration/application/commandContext.ts`，错误文本、resolver 名、public 入口与测试文件仍严格匹配。
生产事务、参与者委托与装配路径检视为等价。

**集中验证**（T9，2026-10-31，本机；同一工作树里有并发 RFC-398 的未提交改动）：

- **后端全量**：6 个分片，`--isolate --randomize`，SQLite 与 PostgreSQL 同进程，机器高负载。2,701 个文件跑到，没跑到的 6 个是
  RFC-398 运行期间新加的 `rfc398-*` 用例。共 96 个失败用例，分布在 48 个文件，归因如下：
  - **本 RFC 引入，已修 4 处**（第 4 处见下文「串行重跑」）：
    - RFC-317 转移表预言按被调函数名识别 CAS 站点。S 参与者用了通用成员名 `set`，collaboration 的 4 个站点（含 3 条表外边）
      掉出语料。成员改名为 `setNodeRunStatus` / `transitionNodeRunStatus`，与内核同名后，站点和偏离账本原样回到语料。
    - RFC-371 观测边界：外部 import 白名单加入 identity-access public participants（type-only）。
    - RFC-395 串行化插入源码锁：`clarify/seal.ts` 的指纹因本 RFC 的改动失效。复核确认锁序和调用方事务不变后更新指纹，
      并在 why 字段写明复核依据。
  - **另做一处收窄**：新结构锁里有一条断言重复了 RFC-317 对 R1 / R2 全账本的相等检查，已删去。这份账本由
    `rfc317-module-boundary` 负责；重复断言会因为树里其他地方新增的边而变红，误导归因。
  - **并发 RFC-398 的在制品造成，不属本 RFC**：
    - 全量时：`@/platform/persistence/sqlite/openForRead` 模块缺失（3 个文件，当时还没落盘）；unreachable-production-files 多出 3 个文件。
    - 重跑时：R1、provider 文件落位、适配器生产消费者、T19d / T19f、RFC-393、非运行时源码角色、test-suite-policy 出现差异。
    - 以上全部指向未提交的 `epochMigrationLegacy.ts`、`epochSwitch/*`、`postgresqlProvisioning.ts`、`auditSourceEvidence.ts`、`rfc398-*`。
  - **其余都是 PostgreSQL 侧的超时**，所有 SQLite 变体都通过。
- **低并发重跑 281 个文件**（5 个 worker）：覆盖全部失败文件和只报 error 的文件、整个 `tests/architecture/`、根目录结构守卫、所有
  引用参与者或绑定的用例，以及被改名波及的源码锁。除上述 RFC-398 在制品造成的差异和 PostgreSQL 超时外，全部通过。
- **PostgreSQL 超时文件串行重跑**（17 个文件，单 worker）：12 个通过，剩余 5 个归因如下。
  - **本 RFC 引入（第 4 处，已修）**：`rfc370-maintenance-worker-real-effects` 的编译版用例三次都超时，RFC-399 那轮是绿的。复现结果：
    编译后的维护 worker 在 `collaboration/infrastructure/clarify/autoDispatch.ts` 的初始化处报 `ReferenceError: __promiseAll is not defined`。
    根因和修法见 proposal §6 第 10 条末项：launcher 的两个入口块去掉 top-level await，并新增守卫 `rfc400-top-level-await-guard`。
    修复后编译版 worker 能正常加载，产物里异步初始化数为 0，该文件通过。
  - **本机负载，不属本 RFC**：
    - `scheduler-clarify-dispatch`：PG 有 1 条用例 7.4 秒超时，同文件其余 PG 用例耗时 3～6 秒。
    - `lifecycle-property`：PG 超时后 harness 已拆除，属性迭代读库报错，不是不变量被违反。
    - `rfc359-w28`：PG 超时。
    - `rfc359-w6-t26`：Heap Fetches > 0。
    - 以上都只在 PostgreSQL 侧出现，SQLite 变体全过。前三个在 RFC-399 的集中验证里（RFC-400 改动之前）也在负载下失败、重跑后通过；
      w6-t26 在 RFC-399 全量里同样失败、串行重跑通过。留给 CI 在干净 runner 上判定。
- **launcher 修复后的复验**：
  - typecheck 零错误；eslint、`lint:promises`、prettier 通过。
  - launcher、托管进程、维护 worker 相关的 21 个文件重跑：只有 `rfc284-spawn-site-ratchet` 失败，原因是 RFC-398 新加的
    `bootstrap/autoUpgradeChild.ts` 多出一个 spawn 点，其余全过。
  - P0 变异 lane 再跑一次：passed，两个 provider 共 34 个阶段全部有效。
  - 前述 281 个文件中的 171 个行为文件重跑（5 个 worker，负载 18～21）：14 个文件失败，全部是 PostgreSQL 超时
    （含 w6-t26 的 600 秒整体超时），SQLite 变体零失败，没有新增任何非超时失败。
- **真实 P0 变异 lane**（`scripts/rfc359-p0-mutations.ts --providers sqlite,postgresql`）：passed。每个 provider 执行 89 个用例；
  16 个变异阶段都按预期失败，诊断吻合；变异前后两次基线都是绿的；源文件指纹前后一致。
- **typecheck**：本 RFC 改动面零错误，剩余 5 处错误都在 RFC-398 的在制文件里。改动文件的 eslint 与 prettier 通过。

