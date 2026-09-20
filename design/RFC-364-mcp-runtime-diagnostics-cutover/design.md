# RFC-364 技术设计

状态：Done（2026-09-20）。实现与原设计的对应、兼容边界和最终测试见 [acceptance.md](./acceptance.md)。

## 1. 已有实现与目标分层

`services/mcpRuntimeTest.ts` 已具备 bootRecover、queue、reconcile、durable intent、session/turn CAS 和 process cleanup。现 RC `mcpRuntimeTestPersistence/Transitions/Lease` 使用共用 provider 机制；迁移应保留这些算法，不重写状态机。

| 所有者 / 层                      | 内容                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| RC `mcp/domain`                  | session/turn 状态、连续执行判据、预算和结果纯逻辑                                                             |
| RC `mcp/application/diagnostics` | start/submit/cancel/end、session/transcript 查询、失效与恢复编排                                              |
| RC application-owned ports       | 当前 persistence/lease、catalog/runtime snapshot、process/stream、workspace cleanup、clock/scheduling effects |
| RC infrastructure                | 复用现 repository/lease；封装 SystemAgentRun、driver session capture、文件路径和进程终止                      |
| RC inbound / public              | transport-neutral application surface 与七个 HTTP bindings                                                    |
| bootstrap                        | 显式 composition、一次 start、共享实例、pause/resume/stop/dispose                                             |

`mcp/` 为现 Resource Catalog 的内部子域，canonical owner 仍是 RC，不新增 bounded context。已有 `application/mcps/runtimeTestPersistence.ts` 可作为内部 port 复用，迁文件只有在 import/owner 账完整时进行。

## 2. 生产 surface

public commands 划为四个具名操作 Start、SubmitTurn、Cancel、End；queries 为 Latest、Session、Transcript。每组不超过五方法，复用现 shared schema 的业务字段和返回 DTO，加入现 IA command/query context，不传完整 service/DB/Actor 给跨域 consumer。模块内由 IA 适配当前 authority，不改变权限和 owner 判据。

| HTTP method/path                                     | 操作       | 保持返回                        |
| ---------------------------------------------------- | ---------- | ------------------------------- |
| GET `/api/mcps/:id/runtime-test-session`             | Latest     | 无记录 204，否则原 session JSON |
| POST `/api/mcps/:id/runtime-test-sessions`           | Start      | 202、原 create receipt          |
| GET `/api/mcps/:id/runtime-test-sessions/:sessionId` | Session    | 200、原 session DTO             |
| POST `.../:sessionId/messages`                       | SubmitTurn | 202、原 turn receipt            |
| POST `.../:sessionId/cancel-turn`                    | Cancel     | 200、原 DTO                     |
| POST `.../:sessionId/end`                            | End        | 200、原 DTO                     |
| GET `.../:sessionId/session`                         | Transcript | 200、原 transcript DTO          |

保持 `mcpOperationCoordinator.runExclusive(mcpId)` 的读取/写入串行范围；当前 create 在锁内重新加载 MCP，迁移后不得只使用锁外旧行。协调和二次读取下沉 application，route 只解析、调用、映射。MCP CRUD 与 diagnostics 仍共享同一 coordinator 实例，不能各建独立锁。

内部 participant 分为：①现 profile/MCP/owner invalidation；② `reconcileDurableIntents` 单方法。前者沿用 RFC-360 RC-owned 同事务 participant，后者由 root 注入 RM/config 所需窄合同，不公开整个 service。Lifecycle 仅 composition 返回，分 start/stop/dispose 与 pause/resume 两组，不伪装成产品 public API。

## 3. Snapshot 与 effects

现 `loadMcp` 是 root 经现 IA/RC admitted 查询注入；`loadRuntime` 消费 RM inspection query。保留 queued turn 开始前重新加载 MCP，以及已冻结 session runtime 配置、binary、native session reference 的语义。禁止将“切模块”变为所有 turn 重新选择 runtime。

`isRuntimeMcpTestEligible` 目前被 RM effects 引用：将纯判据置于 RM/driver inspection 既有责任内，RC 消费其结果；移除 RM 对 MCP service 的 import，不能反向从 RM composition 构造 RC。driver session capture 的实际运行/读取仍由 RC infrastructure adapter 调现机制，driver registry 全迁位留后继。

Process effects 精确封装 run、abort/drain、stale process reap、session capture 与 cleanup；内部 callbacks 仅用于有生命周期的流回执，不穿 public seam。configPath/appHome/绝对路径只在 infrastructure，application 接具名 workspace/session refs。旧 scratchRoot 等持久化列本批不改 wire 或清空，adapter 负责绑定。

事件和业务 invalidation 只携 ref/status；现 transcript 的原始运行事件仍保留在既有 capture store，不能借 event 精简删掉用户历史。持续推送顺序、最后 flush、capture incomplete 原因保持，新增 DB 状态变更与 event publication 原子性检查。

## 4. Transaction 与生命周期

沿用 RC persistence/Transitions 的单一 session/turn writer 与 lease tx，不新增 diagnostics journal 或 schema；若实施发现确需列变更，先修订本设计，不在搬迁中隐式加表。

Start 重复 `clientCreateId` + digest 返回同 receipt；SubmitTurn 重复 `clientMessageId` 返回原 turn；并发消息、cancel、end、profile invalidation 按现 session version/lease CAS 决定。重启使用持久化状态和 process identity 回收，不凭内存 queue 判断执行结束。

| 阶段            | 不变量                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------- |
| construct       | 不安装 timer、不发 I/O、不自动 start                                                     |
| start           | 一次 start promise，bootRecover → reconcile → 安装现 reconcile timer；失败可按原语义重试 |
| pause / resume  | provider fence 期间暂停，失败切换可恢复同一实例；不转换成永久 dispose                    |
| stop / shutdown | 按现 deadline drain/flush/reap 后再关闭 persistence                                      |
| dispose         | 永久、幂等、cold-safe；从未 start 时不为了清理反向启动                                   |

删除 `SERVICE_INSTANCES` WeakMap。一次 application composition 创建唯一 diagnostics 实例并显式传到 MCP HTTP、RM/config、daemon background/provider bindings。独立 server 保留现 unstarted scope factory，生命周期注册顺序沿用 RFC-359 W29；不放松其 AST/实例身份守卫。外部 tests 可注入 effects，不能依赖遗留全局工厂偶然取同实例。

现 reconcile timer 暂保留一个，由实例 start/stop 管理并在 canonical 标 W9 owner/removeWave；本项不增加 polling cadence，不宣称已有 ManagedBackgroundRegistry。

## 5. 限额、兼容与回滚

当前默认 idle/turn timeout 各 10 分钟、create receipt 24 小时、最多 32 turns、消息 64 KiB、event 20,000 rows/16 MiB、单 event 1 MiB、capacity 2，迁移不改常量及其当前计数单位。测试 capacity/clock/runFn 注入仍有效。协议支持取 driver 既有 eligibility，不新增关闭分支。

无新 schema，回滚为同表上的上一实现；部署过程中不同时启动新旧实例。代码切换前先 drain/pause 原实例，root 接管后只启动新实例。回滚仍走同一 provider fence，不以清空 session/lease/事件替代恢复。跨版本 pending intents 由同一算法重放。

## 6. 测试与架构退出

保留 `rfc238-mcp-runtime-test-{real-e2e,transitions,service,http}`、`rfc349-mcp-runtime-test-daemon-identity`、`rfc359-w8-t28-mcp-runtime-lost-update`、`rfc359-w29-unstarted-application-composition`、`rfc349-provider-handover-fence`、`rfc360-runtime-profile-participants` 和 migration 0125 原判据。RFC-297 inventory declaration/read 的 eligibility 显示不得变动。

新增三 root 实例相等、cold dispose 不 start、start 失败/pause-resume、真实双库 cancel/profile-change 交错、flush失败/超时/reap outcome 用例。保留原错误文案/status 与 WS/session observable assertions，不能只改路径快照取得绿色。

T1 建精确 symbol/field、consumer/root、service facade、E6 exception 清单，T6 逐项消除 owned debt；`routes/config.ts` 和 RM infrastructure legacy 类型引用也算本域 consumer，不能漏算。旧 service/lease 文件在生产 consumer=0 后删除；测试导入随真实 owner 迁移。其他 RC/RM/E9/W9 债不扩大认领。
