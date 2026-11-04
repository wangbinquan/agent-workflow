# RFC-438 实施计划

**前置**：RFC-437 收尾（`bf38c3bd2`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                          | 依据              |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ----------------- |
| RFC-438-T1 | task-execution：定时启动合同移入本域端口并经 public 导出；后台启动入参收窄为 `runDue` 端口                    | design §2         |
| RFC-438-T2 | resource-catalog `public/types` 转出访问档位投影；触发器校验端口扩三个成员；integration 变更通知端口          | design §3         |
| RFC-438-T3 | 服务与节拍迁入 integration application，依赖改走端口与 owner；运行期 heal 迁入用例辅助                        | design §1、§3     |
| RFC-438-T4 | 路由迁入 `inbound/http`；composition 转出挂载与 `composeScheduledTaskRunner`；`server.ts` 与 bootstrap 改连接 | design §2、§4、§5 |
| RFC-438-T5 | 用例：新增 RFC-438 用例，改指旧路径的用例与辅助；账本与计数按实测更新                                         | design §6、§8     |
| RFC-438-T6 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                         | design §8         |
| RFC-438-T7 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（B / D 第四步）                                       | —                 |

## 验收清单

- [x] AC-1 三个文件迁入 integration、原文件删除，迁入文件不 import legacy `services/`（两个传输助手除外），task-execution 不 import 定时任务
- [x] AC-2 定时任务节拍经 `runDue` 端口运行，节奏、限额、自动停用与开关不变；启动闭包由 bootstrap 连接
- [x] AC-3 账本与计数按实测更新（R1 178 → 176，深引路由 3 → 2，import `services/` 的路由 24 → 23）
- [x] AC-4 受影响用例全部通过
- [ ] AC-5 exact SHA CI 全绿

## 集中验证（2026-11-03，候选基于 `bf38c3bd2`）

全部实现与用例写完后一次进行。

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警；改动的 TS 文件已按 prettier 格式化。
- **全量 SQLite**（`bun run test:backend`，四分片）：23293 pass / 24 fail（含文件级错误）。逐条归因：
  - **本 RFC 的问题，已修**：
    - 定时启动合同最初经 task-execution `public/commands` 导出。它带 legacy `Actor`、函数类型与 `unknown`，public 面规则与
      RFC-400「public 签名不带 legacy Actor」因此报出。改为 integration 的 consumer-owned 端口，task-execution 保留同形的本域合同、
      不进 public，bootstrap 连接（design §0、§2）；
    - RFC-418 的绑定形状规则按文本匹配，task-execution 后台绑定里的一条新注释提到了开关名，改写注释；
    - RFC-437 用例对 `server.ts` 挂载 import 块的正则没容纳新加的挂载，RFC-438 用例的方向正则过宽，误报了 task-execution 既有的
      integration 参与者依赖；
    - 节拍的源码锁仍读旧路径，测试套件策略「模块级读取的源码路径必须存在」随之报出。
  - **负载超时，与本 RFC 无关**：
    - 涉及 RFC-396 MR 候选桥 8 条、RFC-167 dw-confirm 3 条，以及 RFC-363 工作区分页、RFC-075 自动提交、RFC-193 端口产物、
      RFC-370 V16、RFC-131 评审重做各 1 条；
    - 同一时限下逐个文件单独复跑全部通过（RFC-396 有一轮在负载 14～22 时再次超时一条，另跑 3 次 37/37 通过）。
- **复验**（SQLite，`--isolate`）：修正后的文件连同全部架构测试与受影响的用例，166 个文件 1675 pass / 4 skip / 0 fail。
- **导出仓库**（`bf38c3bd2` 的 `git archive` 加候选路径，提交后运行，同时接 PostgreSQL 真库）：
  - 共 219 个文件：按已提交源码出报告的用例、路由错误码棘轮与 API 合同覆盖、提及定时任务的双引擎用例 61 个、本 RFC 改动的用例，去重后合并；
  - 结果 3122 pass / 4 fail / 4 skip。4 条失败都是 PostgreSQL 应用在四路并行下启动超时，涉及组合根路由面、ACL 端点矩阵与
    `/api/overview` 三个文件，单独复跑全部通过（2 / 158 / 14 pass）；
  - 路由错误码棘轮在已提交的候选上通过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段（当前绿、15 个历史回归变异各自变红、当前再绿）全部符合预期，源文件哈希前后一致。
- **计数复核**：import `services/` 的路由 23 个；深引模块内部的路由 2 个（`code.ts`、`capabilityTemplates.ts`，E8）。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 定时任务的「跑一轮」与原 task-execution composition 里的闭包逐字等价：同一个启动闭包实例（`trigger.buildScheduleLaunch`）、
  限额 32、本拍的失败上限与默认 runtime；节拍 30 s、开关判定与暂停恢复仍在 task-execution 的后台 application，未改；
- 变更通知的四种事件字段与频道不变；三条 legacy 校验的调用参数与顺序不变，agent 启动形状校验仍是惰性加载；
- 访问档位投影是同一组 resource-catalog domain 函数；运行期 heal 在生产里本就零调用；
- 路由、方法、权限点、令牌访问与挂载先后不变。

## PR / 提交

单个提交：`refactor(backend): RFC-438 定时任务归入 integration，task-execution 不再依赖定时任务（RFC-294 W4 B/D）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
