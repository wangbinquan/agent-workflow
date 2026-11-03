# RFC-433 实施计划

**前置**：RFC-432 落库（`b4b24cff1`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                 | 依据      |
| ---------- | ------------------------------------------------------------------------------------ | --------- |
| RFC-433-T1 | 合同：删去可选组，7 项移入必填与必填可空；会话 / 应用输入 `Omit` 掉 `secretBox`      | design §1 |
| RFC-433-T2 | 单机 profile 给出 7 项；托管 `secretBox` 改为闭包                                    | design §1 |
| RFC-433-T3 | 装配层消费点：启动、会话、应用装配、HTTP 组合、集成 / 开发自动化 / 数字员工组        | design §2 |
| RFC-433-T4 | 守卫：RFC-431 结构锁（无可选成员、`secretBox` 归入工厂组）、分区清单、guard-manifest | design §3 |
| RFC-433-T5 | 用例：行为用例、RFC-394 用例、接线锁改写、测试入口                                   | design §6 |
| RFC-433-T6 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                | design §6 |
| RFC-433-T7 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（S2c 第 1 项完成）           | —         |

## 验收清单

- [x] AC-1 三分区 51 + 11 + 0 与结构锁（含负例）
- [x] AC-2 单机 / 托管值与 `secret.key` 构造时机
- [x] AC-3 装配层对 7 项显式判定
- [x] AC-4 回归用例全部通过
- [ ] AC-5 exact SHA CI 全绿

## PR / 提交

单个提交：`refactor(backend): RFC-433 按有无区分部署的选择项改为显式（RFC-294 S2c）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。

## 集中验证（T6）

全部实现与用例写完后一次进行（`2eeaf4585` 之上的工作树）。

- **静态**：后端 typecheck（含 tests，6 GiB heap）0 错误；改动的 TS 文件 eslint `--max-warnings 0` 与 prettier 全部通过。
- **验证中发现的本人缺陷**（均已修，复验通过）：
  - RFC-394 结构锁仍要求两个输入继承 `DeploymentSelections`。改为要求 `DeploymentSessionSelections`，并锁住该别名的形状（含负例）。
  - 启动日志最初写成 `profile.kind === 'standalone' ? … : …`，违反 RFC-394「入口不按部署种类分叉」规则，改为记录 `deployment: profile.kind`。
  - 修复后两把结构锁 59/59 通过。
- **全量 SQLite（4 分片，单分片上限 5400 s）**：结束时机器负载 34 / 47 / 51（1 / 5 / 15 分钟），4 个分片都跑完：2883 个文件、23392 条用例，23243 通过、127 跳过、22 失败。
  22 条全部是 5 s / 30 s 的负载超时（RFC-396 MR 桥 11 条、RFC-167 3 条、RFC-075 2 条、RFC-243 e2e 2 条、RFC-193、RFC-363 工作区内容、
  RFC-370 V16、wrapper fan-out e2e 各 1 条）。
- **复跑（60 s 预算）**：上述 8 个超时文件，加上本 RFC 的结构锁、行为用例与接线锁，SQLite 21 个文件 239/239 通过。
- **PostgreSQL 专注 lane**：本 RFC 直接涉及的 97 个文件（会话 / 启动 / 部署 profile 用例，加上走候选、冲突合并、镜像、Webhook、
  执行状态路径的 HTTP 应用用例），4 路各用独立库，60 s 预算：1019 条全部通过。
- **导出仓库（HEAD + 本候选）**：141 个按已提交源码出报告的用例全部通过，包括全部架构测试、`rfc370-committed-architecture-source`
  与 `rfc294-architecture-preflight`。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 实现门（本会话自审，只审功能）

- **数据库安装**：两段单机流程（自动升级、待定恢复）原来分别以 `=== undefined` 与 `!x` 判定，中间只有注释，合并为一个 `=== null` 分支后
  执行顺序不变；托管给了安装端口，两段都跳过。准备数据库时 `null` 换成 `undefined`，走同一重载。
- **密钥盒**：单机工厂的路径 `join(appHome, 'secret.key')`，`appHome` 即 `Paths.root`（`util/paths.ts:13`），与原 `Paths.secretKeyFile` 同一文件；
  调用位置仍在启动锁之后、令牌之前。托管闭包返回同一个平台盒子。
- **执行权威**：
  - 会话把权威交给生命周期程序；`startOnExecutionActive` 在包装时看到本地权威已 active，原样返回工厂（`bootstrap/executionActivation.ts:18`），
    后台集的启动与改前不传权威时逐个相同；
  - `resource-reverify` 等待的是已兑现的 promise（改前 `await undefined`）；`onLost` 是空订阅，激活失败回调不会被调用；
  - HTTP 状态与门控改用 profile 里的同一个本地权威（改前每个会话现建一份冻结常量）。
- **托管独有的五项**：单机 `null` 在每个消费点走的都是改前 `undefined` 的那条路：
  - 镜像组合不传 `remote`，子模块刷新照常运行；
  - 事件中心不排空 CrewStation 事件，Webhook 入口收到 `undefined`；
  - 候选与冲突合并的参与方收到 `undefined`，用各自的逐请求本地效果。
- **托管**：7 项与改前同一对象，`secretBox` 只多一层闭包。
- **结论**：PASS。
