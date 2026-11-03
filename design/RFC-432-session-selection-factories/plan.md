# RFC-432 实施计划

**前置**：RFC-431 落库并 Done（`90e1d0974`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                         | 依据      |
| ---------- | ---------------------------------------------------------------------------- | --------- |
| RFC-432-T1 | 合同：`DeploymentSessionStorage`、十项改为必填工厂；分区清单移组             | design §1 |
| RFC-432-T2 | 模块导出本地构造函数：意图产物、准备效果提取、备份协调器工厂参数             | design §2 |
| RFC-432-T3 | 单机 profile 给本地构造函数，托管 profile 给闭包                             | design §1 |
| RFC-432-T4 | 装配层消费点：应用装配、仓库凭据组、任务执行组、意图组、会话适配             | design §2 |
| RFC-432-T5 | 守卫：RFC-431 结构锁加两条检查、guard-manifest；接线锁改写                   | design §3 |
| RFC-432-T6 | 用例：单机工厂两会话行为、托管闭包同一对象、测试入口                         | design §6 |
| RFC-432-T7 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI        | design §6 |
| RFC-432-T8 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（S2c 第 1 项第三步） | —         |

## 验收清单

- [x] AC-1 三分区 49 + 6 + 7 与结构锁（含负例）
- [x] AC-2 单机工厂两会话行为、托管闭包
- [x] AC-3 装配层对十项无缺省
- [x] AC-4 回归用例全部通过
- [ ] AC-5 exact SHA CI 全绿

## PR / 提交

单个提交：`refactor(backend): RFC-432 需要会话图的部署选择项改为两侧都给的工厂（RFC-294 S2c）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。

## 集中验证（T7）

全部实现与用例写完后一次进行（`307d1e867` 之上的工作树）。

- **静态**：后端 typecheck（含 tests，6 GiB heap）0 错误；改动的 TS 文件 eslint `--max-warnings 0`、promises 规则与 prettier 全部通过。
- **全量 SQLite 第一轮（4 分片）**：机器负载约 50（同时跑着 PostgreSQL lane），4 个分片都撞到 2700 s 上限。各分片日志里的失败归因如下：
  - 2 条是本 RFC 引起的，已修：
    - `rfc370-storage-and-worker-root-bindings` 的 HTTP 选择项包断言：资源包技能产物现在是 `input.resourcePackageSkillArtifacts(session)`，断言改为这一调用；
    - `rfc359-w5-t19f-test-engine-hardcoding` 高水位账本：本 RFC 的行为用例最初直接建 SQLite 内存库（+2）。改为 `describeEachProvider` 双库，
      两个引擎都跑，账本不变。
  - 其余 21 条全部是 5 s / 30 s 的负载超时，分布在 RFC-396 MR 桥、RFC-131、RFC-098、RFC-075 提交推送、RFC-363 工作区内容、RFC-370 V16、
    RFC-167、wrapper fan-out e2e。
- **PostgreSQL 专注 lane**：本 RFC 直接涉及的 146 个文件，4 路各用独立库，1279 条用例 1273 通过。6 条失败都是超时，集中在两个文件：
  - `lifecycle-property` 3 条（15 s 预算）；
  - `review-detail-render-rfc158` 3 条（20 / 30 s 预算）。

  两者都直接调用模块函数，不经过本 RFC 改动的接线。

- **复跑（60 s 预算）**：上面两条修复与全部超时文件，SQLite 12 个文件 130/130 通过；PostgreSQL 4 个文件 20/20 通过，
  其中包括本 RFC 的双库行为用例。
- **全量 SQLite 第二轮（4 分片，单分片上限 5400 s）**：修复之后重跑，机器负载 17～74，4 个分片都跑完：2882 个文件、23382 条用例，
  23241 通过、127 跳过、14 失败。
  - 13 条是 5 s / 30 s 的负载超时，都在第一轮那组文件里（RFC-396 MR 桥、RFC-075、RFC-363 工作区内容、RFC-370 V16、RFC-167、
    wrapper fan-out e2e），上面 60 s 复跑已全部通过。
  - 1 条是存量用例的时序竞态：`rfc266-script-pool-independence` 的反向锁固定睡 400 ms 后断言任务 `running`，负载约 70 时任务还是 `pending`。
    它直接驱动任务引擎，不经过本 RFC 改动的装配层。按仓规修测试而不是靠重跑：先有界地等任务进入 `running`，再保留原来 400 ms 的「仍在排队」窗口。
    反向锁的意图不变——闸被删掉时任务会直接跑完，要么等不到 `running` 而超时，要么看到 `done`。修复后 SQLite 两遍 3/3 通过；
    修复前低负载下 SQLite 三遍、PostgreSQL 一遍也都通过。
- **导出仓库（HEAD + 本候选）**：141 个按已提交源码出报告的用例全部通过，包括全部架构测试、`rfc370-committed-architecture-source`
  与 `rfc294-architecture-preflight`。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 实现门（本会话自审，只审功能）

- **构造等价**：十项逐一对照改前的缺省分支，单机工厂是同一构造、同一参数、同一调用位置：
  - 应用装配：内容存储、技能内容、评审产物在原 `??` 处调用工厂，参数是同一会话的 `db` / `appHome`；评审产物收到的仍是本会话已选的内容存储。
  - 资源包技能产物：原来由 PostgreSQL 资源包 provider 的缺省构造，现在由应用装配按会话构造后交给 HTTP 选择项包，构造函数与 `db` / `appHome` 相同。
  - 意图产物：`composeLocalIntentArtifacts` 的三个成员与意图组合入口三处缺省逐字同一构造（`appHome/plugins`、会话库、同一补偿原语）。
    改前两处消费点各建一份无状态的产物内容端口，现在共用一份；托管今天就是共用一份。
  - 备份：PostgreSQL 系统运维组合在原位置以同一组依赖调用工厂；SQLite 会话照旧不读这一项。
  - 仓库发布传输、开发工作区仓库准备：仓库凭据组在原 `??` 处以同一组依赖调用。
  - 准备 / 暂存效果：`composeLocalRepositoryPreparationEffects` 是原模块内联缺省的逐字提取，`composeLocalScratchWorkspaceEffects` 同理；
    任务执行组先组好同一份准备输入再调用。
- **托管**：十个闭包返回的仍是 profile 里只建一次的那几个对象：
  - 备份与意图产物从选择项字面量里提前到 `return` 之前算好；
  - `workspace.bind()` 仍只调用一次，四项取出后包成闭包，其余照旧展开。
- **会话与迁移**：工厂每个会话调用一次，与改前缺省分支的构造次数相同。SQLite → PostgreSQL 迁移后重组的会话以新库调用，得到新库上的实例
  （双库行为用例覆盖）。
- **结论**：PASS。
