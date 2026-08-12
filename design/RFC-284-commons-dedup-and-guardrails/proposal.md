# RFC-284 — 系统公共功能抽象去重与防护制度化（proposal）

状态：Draft（2026-08-12 落档）
来源：`design/system-commons-unification-audit-2026-08-12.md`（下称「审计报告」）。
决策依据：审计报告 §5 决策台账 D2/D9/D10/D11/D12/D18/D22（用户已拍板）；
本 RFC 内**不再重新讨论**这些方向，只做工程落地。超出台账的新歧义须反问用户。

## 1. 背景

2026-08-12 全系统归一审计确认：判定层/状态机层/spawn 层已单点化，但**微 helper 层、
资源 CRUD 形态层、工具类子进程治理、若干边界方向**仍存在成片重复与无防护缝隙
（审计报告 §3 N1-N10、N12、N20-N29、N31）。本 RFC 是 RFC-280/282 归一工程的续集：
把「已归一面」外圈的重复实现收口，并把审计发现的防护空白制度化。

## 2. 目标

**零产品行为变更为主**（例外见 §4 能力影响清单，全部是观测/告警面微调，逐项列出）。
交付四组：

- **G1 微 helper 收口**：safeJson（20 份）、路径 containment「lexical+realpath 双查」
  （3+ 份安全关键副本）、hash 包装（~11 份）、drained/timeout race（2+2 份）、
  版本探针三胞胎骨架、monotonic updatedAt（4 份）各收敛为单一 util，全部调用方迁移。
- **G2 资源侧去重**：agents JSON 列反查引用四份收敛为泛型；scheduled 引用扫描三份
  收敛单点；by-resource grant SQL 五处收敛 helper；快照式可见性判定三份收编
  `resourceAcl.isVisibleToAudienceSnapshot`；bundle plugin-create 改走
  `initialPrivateResourceAcl`；skill 名称唯一性改走 `ownerScopedName` 共享对；
  `resourcePolicy.ts` 删除基于不存在列的 'agent' 条目 + 「每条目必须真有 enabled 列」
  守卫（D2）；六类 OCC fence 选型表文档（机制不动，D6 文档半场）。
- **G3 runtime/执行器收口**：selfCheck 增「观测声明 ⇒ 观测方法已实现」蕴含守卫；
  `mcpRuntimeTest.ts:2547` 二元 cast 改走 `defaultConfigDirProfile`；session-not-found
  方言检测下沉 driver 可选方法（D10）；`drainTimedOut` 接入 runner 告警 +
  `startup_verification_json` 观测面（D9）；`MAX_STREAM_LINE_CHARS` 双拼收编；
  pluginInstaller npm 安装收编 `runManagedProcess`（树杀/drain/超时治理对齐）；
  structuralDiff probeIndexer 补 deadline、runIndexer 换 `killProcessTree`、
  scriptRun probeInterpreter 对齐探针姿势；git 双点镜像加源码文本锁；
  **全仓 spawn 站点棘轮 allowlist 测试**（backlog 自认从未存在的
  `containedSpawnRegistry` 的现代替身）；`util/opencode-models.ts` 迁入
  `runtime/opencode/`（registry 的 evict 依赖改经 driver 面）；`resolveOpencodeCmd`
  死导出删除；legacy ctx 类型（`SystemAgentSpawnContext`/`BusinessNodeSpawnContext`）
  加 DEPRECATED 标注（真删除仍随 RFC-282 登记的 B4 式合一，不在本 RFC）。
- **G4 调度/任务侧与边界制度**：`buildChildDeps` 手工漏斗改「可继承配置单一子对象
  整体透传」；`nextRetryIndex` helper 收编 4 处取号；memoryDistillScheduler 改走
  `agentRefOfNode`；S4 告警子任务行提阈值 + detail 标注（D11）；定时器 cadence
  常量化（含 start.ts 两处裸 1h）；`util/diffSplit.ts` 删模块+测试（D12，文档半场
  已随包①落 CLAUDE.md）；`wrapperProgress.phase` 删字段（兼容读旧行）；
  **边界规则三条**：dependency-cruiser 增 `no-routes-to-db`（存量 18 文件进
  KNOWN_VIOLATIONS 记账）、`no-util-to-upper`（git.ts 族既有账目共用 removeWhen）、
  `no-auth-to-services`；`authLoginPolicy` 迁入 `auth/`（D22，消除唯一反向值边）；
  webhook endpoint/trigger CRUD 抽 `services/webhookEndpoints.ts`（**排 RFC-283
  落地后执行**，见 §5）；`routes/agents.ts` 的 `buildClosureRefNameMaps` 读模型装配
  下沉 service；`routes/tasks.ts` multipart 启动编排移入既有 `launchMultipart.ts`；
  `mcp/tools.ts` 的 StartTaskSchema 手工镜像加编译期/文本锚；2 个未文档化 env 开关
  文档化 + `AW_RUNTIME_STATUS_PROBE_TIMEOUT_MS` 改 opts 注入（对齐全仓 seam 规范）；
  **clarify 家族五文件迁入 `services/clarify/`**（D18 示范迁移，留同名 facade）。

## 3. 非目标

- 不含任何 RFC-285 的行为变更（404 统一/删除档/失活拒启/token 收窄/stale 码/权限洞）。
- 不含前端（RFC-286）。
- 不含三大件（RFC-287 装配线收敛 / RFC-288 WP-5 / RFC-289 WP-6b）。
- 不做 fence **机制**统一（D6 只做文档 + 错误码归一在 285）。
- 不恢复/不触碰 sandbox-era 已删除机制。
- 不做 `opencode_session_id` 列改名、node_run 单调 id 等登记项（审计报告 §7）。

## 4. 能力影响清单（逐项确认；本 RFC 无能力收缩——C1-C8 为观测/告警面变化，C9 为死配修活）

| #   | 变化                                                                                                                                                            | 影响                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| C1  | S4 pending 告警对 `parent_task_id` 非空的行阈值 5min→30min（D11）                                                                                               | 子任务排队场景告警变少（原为噪音）；顶层任务不变                                                                        |
| C2  | `drainTimedOut` 新增 runner warn + 观测记录（D9）                                                                                                               | 新增告警面，无行为变化                                                                                                  |
| C3  | claude 的 session-not-found fallback 告警从「静默缺失」变为正常产生（D10 的副产物）                                                                             | 补齐既有 opencode 已有的告警对称性                                                                                      |
| C4  | 启动自检报告不再输出「agent 有 enabled 开关」的错误陈述（D2）                                                                                                   | 纠错，无能力变化                                                                                                        |
| C5  | `wrapperProgress.phase` 字段停止写入（读旧行兼容；**不承诺回滚兼容**——旧版 daemon 读新行会走 init path 重跑 wrapper，不崩但重复工作）                           | debug-only 字段（自述无消费者），升级方向无用户可见变化                                                                 |
| C6  | pluginInstaller npm 超时改为进程树击杀                                                                                                                          | 超时场景不再泄漏孙进程；正常安装不变                                                                                    |
| C7  | pluginInstaller 失败错误文案的截断方向从「头 64KB 前缀」变「滚动尾部」；超时从即时 SIGKILL 变 TERM→KILL 宽限；信号死 exitCode 从 node 的 `code=null → -1` 变 Bun 的 `128+signal`（实测 137）（设计门路 2 抓出，收编 managedProcess 的必然差异；信号死数值轴为实现期实测补记） | 安装失败的诊断文案内容换头为尾（可诊断信息通常在头部——实现实测：错误详情取头 2KB 切片〔STDERR_CAPTURE_BYTES〕，<8MB 输出下与旧管线逐字节同轴，对拍锁 `rfc284-plugin-installer-managed.test.ts`）；信号死仍走安装失败路径（错误类型不变，仅诊断数值变）；outcome/产物路径不变 |
| C8  | §3.5 进程治理三项（T29 路 1 补账——正文明示但初版漏列 C 行）：probeIndexer 补 10s deadline（原无界，HTTP 路径可挂死）；deep/runner 超时杀升级 killProcessTree（原单 pid 留活孙进程）；probeInterpreter 对齐探针骨架（组杀替代单 pid kill(9)） | 探针挂死/超时场景的可观察行为变化：原「永久挂/留孤儿」变「有界失败/树杀净」——诊断与资源面纯改善，成功路径逐字节不变（对拍锁 rfc284-spawn-version-probe / deep 套件） |
| C9  | RFC-253 `scriptInterpreters` / `scriptDepsInstallTimeoutMs` 从「静默失效」变生效（T30 修配，用户拍板）：StartTaskDeps + runtimeConfigOpts 补线修通根任务，INHERITABLE_RUN_CONFIG_KEYS +2 下传子任务                                                     | 此前两键被漏斗静默丢弃（launch 臂运行时携带但类型缺席，spread 绕过 TS 检查）——管理员解释器覆盖与依赖构建预算生产从未到达 script 节点；修配后按配置生效，未配置部署零变化（undefined 不落键）                              |

## 5. 依赖与排序

- **RFC-283 冲突面（设计门补全，共三处）全部挂 T28（RFC-283 完工后）**：
  ① webhook CRUD 抽 service（routes/webhookTriggers.ts / webhookEndpoints.ts）；
  ② T5 safeJson 对这两个路由文件的迁移子项；③ T26 的 mcp/tools.ts StartTaskSchema
  锚（RFC-283 A4/A5 也改该文件）。其余子项无并发冲突；批 D（runner/claudeCode
  driver/runtime types 高频面）开工前照 T27 姿势 `git status` 确认无他人在途改动。
- 本 RFC 先于 RFC-285/286 实现（G1 的 containment util、G2 的 ACL helper 是 285 的地基）。

## 6. 验收标准

- AC-1 各收口 helper 唯一定义点 + 全部旧副本删除（grep 计数断言进测试；
  safeJson 按语义族收口为 **2** 个 util——`safeJsonOrEmpty`/`safeJsonOrThrowInvalid`，
  见 design §1.1 设计门修订）。
- AC-2 spawn 棘轮：src 下 `Bun.spawn`/`child_process.spawn` 站点显式 allowlist
  测试，新增站点不进名单即红。
- AC-3 selfCheck 蕴含守卫：构造「声明 inventory-file 但缺 readInventory」的假 driver
  必须拒启（红→绿测试对）。
- AC-4 dep-cruiser 三条新规则接线且违规账本收录存量（棘轮：只减不增）。
- AC-5 `resourcePolicy` 守卫：DisableableResourceKind 每条目对应表存在 enabled 列，
  变异（加回 'agent'）即红。
- AC-6 clarify 迁移后 import 路径全部经 facade 或新路径，`gate:local` 全绿。
- AC-7 对拍：G1-G4 各批次改前后关键面行为零漂移（复用 RFC-282 对拍姿势，纯函数
  输出字节等价；C1-C9 之外不得出现任何行为差异——C8 为 T29 路 1 补账、
  C9 为 T30 修配用户拍板）。
- AC-8 每批 pin worktree `gate:local` 全绿 + exact-SHA CI 绿。
