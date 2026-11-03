# RFC-431 实施计划

**前置**：RFC-430、RFC-401 落库（`a78f95d7a`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                             | 依据          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-431-T1 | 合同：`DeploymentSelections` 三分区、`graphDevelopmentArtifacts`、键表；会话 / 应用输入去重声明                                  | design §1     |
| RFC-431-T2 | 模块 `composition` 导出本地实现；新增工作区内容工厂、本地任务运行选择、归档事件读取、本地排除配置、惰性证据端口与文档命令        | design §4     |
| RFC-431-T3 | `standaloneSelections` 与 `composeStandaloneProfile`；`composeLocalDevelopmentPurposes` 移出；托管加 `graphDevelopmentArtifacts` | design §2     |
| RFC-431-T4 | 装配层消费点：启动、会话、生命周期程序、应用、HTTP、各模块组；删除退役助手与只服务装配层的模块缺省                               | design §3     |
| RFC-431-T5 | 守卫：新锁 `rfc431-standalone-selections`、RFC-394 锁收缩、`deploymentSelectionSource` 按分区断言、guard-manifest                | design §5     |
| RFC-431-T6 | 用例：测试入口展开单机选择、单机 profile 行为用例、托管键集合、源码接线锁改写                                                    | design §5、§8 |
| RFC-431-T7 | 集中验证（静态、针对性验证集、复跑、导出仓库、P0 变异 lane）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI        | design §8     |
| RFC-431-T8 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（S2c 第 1 项第二步）                                                     | —             |

T1～T6 无先后验证依赖，按文件就近一并完成；T7 在 T1～T6 全部写完后进行。

## 验收清单

- [x] AC-1 三分区与结构锁（含负例）
- [x] AC-2 单机 profile 行为用例
- [x] AC-3 装配层无缺省、RFC-394 锁收缩、退役助手不在源码
- [x] AC-4 托管键集合 62、`graphDevelopmentArtifacts` 与 `evidenceArtifacts` 同一对象
- [x] AC-5 回归用例全部通过
- [x] AC-6 exact SHA CI 全绿

## PR / 提交

单个提交：`refactor(backend): RFC-431 单机部署选择项默认值集中到单机 profile（RFC-294 S2c）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。

## 集中验证（T7）

全部实现与用例写完后一次进行（`a78f95d7a` 之上的工作树）。

- **静态**：后端 typecheck（含 tests，6 GiB heap）0 错误；改动的 TS 文件 eslint `--max-warnings 0`、promises 规则与 prettier 全部通过。
- **全量 SQLite（4 分片）**：机器负载 41～158，第 3、4 分片撞到 2700 s 上限。共 29 条失败，归因如下：
  - 9 条是本 RFC 引起的，全部是源码接线锁与消费方账本，已改为断言新接线并登记 `bootstrap/standalone.ts`：
    - RFC-305 / 347 的 identity-access 消费方；
    - RFC-310 的 development-automation 消费方与数字员工 OS 清单；
    - RFC-364 诊断、RFC-370 程序工具 / 冲突、RFC-390 安装器、RFC-392 必填输入。
  - 其余是 git 重度用例的 5～6 s 负载超时，含其后续断言。它们在下面的针对性验证集里以 60 s 预算全部通过。
- **PostgreSQL 专注 lane**：本 RFC 直接涉及的 80 个文件，4 路各用独立库。12 条失败：
  - 9 条源码接线锁、1 条证据目录时机断言，已修；
  - 2 条超时（证据读取、RFC-384 意图组），低负载下两 provider 复跑通过。
- **针对性验证集（SQLite，4 路，60 s 预算）**：666 个文件、5591 条用例（5577 通过、2 失败、12 跳过）。范围是全部架构测试、读装配层源码的用例、两轮失败文件，
  加上 PG lane 那组。2 条失败：
  - 数字员工 OS 清单：event-center 只许外部引用 `composition` 根入口，本地观察程序工厂改由根入口导出，两条新边登记进清单；
  - 冲突根绑定的证据目录：断言改为实际时机——`evidence/blobs`、`bundles/` 仍在装配时创建，只有 `staging/` 推迟到首次写入。
    修复后这两条连同两条超时，在两个 provider 上复跑 34/34 通过。
- **RFC-431 结构锁与行为用例**：19/19 通过。负例覆盖分区三向、单机 profile 缺项 / 非 null、装配层缺省 / undefined 判断 /
  可选调用、退役助手回归。验证中补了漏检的 `x.stated?.member` 写法，并排除维护 Worker 自己的效果族。
- **导出仓库（HEAD + 本候选）**：141 个按已提交源码出报告的用例全部通过，包括全部架构测试、`rfc370-committed-architecture-source`
  与 `rfc294-architecture-preflight`。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。在 Claude Code 里要去掉
  `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` 再跑，否则 bun 不打印通过的用例名，脚本误报「passing test names differ」。

## 实现门（本会话自审，只审功能）

- **装配层等价**：逐项核对单机值与改前缺省分支是同一构造、同一根目录。四处值得写下的等价论证：
  - 排除配置：drive 请求的 `appHome` 恒为应用的 `appHome`；
  - 任务运行绑定：本地 `contentsFor` 返回的就是选择里的同一对接收方；
  - 任务归档：不钉 `locations`，调用方照旧给 `Paths` 根；
  - 归档事件：守护进程路径从不设 `logsDir`。
- **实例共享**：单机选择项每个进程构造一次（改前每个会话一次）。逐个检查本地实现：
  - 均无按会话设计的闭包状态；
  - 开发适配程序的两个 WeakMap 以每次请求对象为键；
  - 任务运行桥的请求表、插件产物计划表同理。
    SQLite → PostgreSQL 迁移后的新会话复用它们没有影响。
- **能力关闭的 null**：维护 Worker 监督者、人工门续跑 worker、事件存储把 `null` 当作没有该能力，与改前的 `undefined` 分支同一路径。
- **目录时机**：两个空目录推迟到首次读写，已有数据与读写位置不变——图开发存储的 `appHome/blobs`、`bundles/`，需求文档暂存
  `appHome/evidence/staging/`。
- **观察**：内容盘点的固定清单只覆盖 `skills` / `runs` / `logs` / `evidence` / `config.json`（`platform/content/inventory/manifest.ts:108`），
  图开发证据所在的 `appHome/blobs`、`bundles/` 不在这份固定清单里（是否经索引位置覆盖未核实）。这是改前就有的情况，留给统一证据根目录的后续 RFC 核实。
- **结论**：PASS。

## CI（AC-6）

`90e1d0974`：主 CI run 41614334877 70/70，windows-platform run 41614334853 与 maintenance-soak-nightly run 41614334952 全绿，
一次通过，无重跑。
