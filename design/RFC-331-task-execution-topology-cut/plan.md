# RFC-331 实施计划：Task Execution 拓扑切割

> 状态：Done（2026-08-27；T3～T12 已发布，provenance 已真实 repin，exact-SHA hosted CI 已收口）
>
> 批准边界：只授权 RFC-331 T3～T12，不授权 W2-B/C/D、安全/权限或能力收缩改动。

## 1. 实施原则

1. 只清理 RFC-294 W2-A 指定的六条 exact task-family debt，不扩展到 W2-B/C/D。
2. 复用 RFC-328 的 module/context/ownership/runtime/outbox；任何第二实现直接阻断。
3. 先锁功能 oracle，再切接线；架构指标不得以功能损失换取。
4. 两刀各自可构建、可测试；最终以单笔 cohesive implementation commit 发布，不添加临时 `KNOWN_VIOLATIONS`。
5. 不跑本地全量 Bun gate；实现发布后以 GitHub Actions exact-SHA 为全仓权威，本地只做可归因的 targeted checks。
6. 共享 `main` 精确路径 stage/commit，保留并发输出；发布前按仓规同步 origin 并进入短 Git 临界区。

## 2. 任务分解

### 2.1 RFC 与基线（本轮）

| ID         | 任务              | 完成条件                                                                                                                |
| ---------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| RFC-331-T0 | current inventory | 固定 source SHA/report digest；四 kick、三反向 child control、status/read-model、六条 ledger、8-file SCC 全量逐项可复跑 |
| RFC-331-T1 | 三件套与总纲回填  | proposal/design/plan、RFC-294、RFC-328/329、索引、STATE 一致；只改文档                                                  |
| RFC-331-T2 | 用户决策门        | 用户显式批准 D1～D8、能力影响与 DEV-1；未批准则保持 Draft、零生产改动                                                   |

### 2.2 Cut A 准备：additive contracts 与 oracle（批准后）

| ID         | 任务                           | 依赖  | 完成条件                                                                                                              |
| ---------- | ------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------- |
| RFC-331-T3 | application ports/types        | T2    | 合同只经 `public/topology\|queries` 一跳导出；`TaskDriveRequest`、driver/publisher、两类 read model，无 consumer 切换 |
| RFC-331-T4 | composition/test topology      | T3    | 实例级 real/recording/no-op/poison factory；production 无 global registrar/optional fallback                          |
| RFC-331-T5 | 功能 oracle                    | T3,T4 | 四 kick request golden、child control、WS golden、outbox single-send、call-graph 错误顺序；先在旧接线上保持全绿       |
| RFC-331-T6 | architecture negative fixtures | T3    | 三类回边与 legacy deep-import mutation 均可确定转红；分母非空且不用前缀豁免                                           |

T3～T6 先在同一 Cut A 候选中只加合同与测试 seam，不切 production writer/driver，也不单独发布一个长期半态。
若合同需要改变任一功能语义，停止并回到 T1/T2。

### 2.3 Cut A：前五条账

| ID         | 任务               | 依赖  | 完成条件                                                                                               |
| ---------- | ------------------ | ----- | ------------------------------------------------------------------------------------------------------ |
| RFC-331-T7 | 四 kick 接线       | T3-T6 | initial/resume/retry-prep/retry-node 全经 `kick`；context/signal/config/catch/finally逐项保真          |
| RFC-331-T8 | scheduler 反向接线 | T7    | status query/publisher 与 cancel/resume/is-active 全经注入端口；scheduler→task static/dynamic import=0 |
| RFC-331-T9 | 第一刀销账         | T8    | `task→scheduler` 与其同族前五条 exact ledger 同笔删除；depcheck 无 stale/新债；其他 SCC 不变或合法下降 |

T7/T8/T9 必须在一个 production commit 中原子出现，避免 graph 已绿但 reverse application debt 仍残留。

### 2.4 Cut B：E3 第六条账

| ID          | 任务                       | 依赖  | 完成条件                                                                                              |
| ----------- | -------------------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| RFC-331-T10 | call-graph workspace query | T5,T9 | SQLite 窄投影 + public composition factory + legacy 单仓 fallback；不返回 full Task DTO               |
| RFC-331-T11 | expandService cutover      | T10   | route/composition 显式注入；行为逐字保持；`expandService→task`=0、module deep import=0                |
| RFC-331-T12 | 第二刀销账与发布收口       | T11   | 第六条 exact ledger 删除；KNOWN 37→31；8-file task SCC 消失；RFC/STATE/index 回填 Done                |

## 3. 提交与发布拆分

实际发布链：

1. **Docs baseline（已完成）**：RFC-328/329 closeout、RFC-294 current reconciliation、RFC-331 三件套/index/STATE。
2. **Implementation A+B（`81d97d060`）**：T3～T12 在一个 cohesive snapshot 中原子发布；合同/oracle、
   A1/B1～B4 与 call-graph 窄读模型同时落地，六条账全部删除，未制造长期半态。
3. **Canonical normalization（`262f34bf7`）**：重放 report/manifests 并固定内容投影。
4. **Provenance repin（`89b19057d`）**：四份 artifact 的 `currentSnapshotSha` 指向真实 payload commit。
5. **Hosted source-lock repairs（`11634edc7`、`2cad7c2f4`、`4152b377a`）**：只对齐已改变接线的历史源码锁；
   最终 run `33034946053` terminal `success`（35/35 jobs）。

production batch 推送后按自己的 exact SHA 查询 CI；若 run 被 newer main 取消，只接受包含该提交的后继 exact-SHA
终态并逐 job 归因，不把 queued/cancelled/无关红写成绿。

## 4. 验证矩阵

| 面            | 最小验证                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------- |
| kick          | 四调用点完整 request、await/fire-and-forget、catch/finally、exact execution context           |
| child control | cancel race、resume once、active reattach、shutdown/adoption                                  |
| status        | status query null、list/task/done/node WS golden、outbox revision 唯一                        |
| call graph    | 单仓、多仓、longest prefix、unresolved repo、task missing、worktree 410、re-prefix            |
| architecture  | 三回边 + legacy deep-import 负 fixture；前五/第六 exact ledger 分批下降；task SCC family 消失 |
| compatibility | REST/MCP/WS/DB schema diff=0；权限/功能挡板 diff=0；RFC-328 ownership/effect tests保持        |

## 5. 完成清单

- [x] current source、report 与六条 exact debt 已盘清。
- [x] RFC 三件套已定义范围、合同、两刀顺序、能力影响与验收标准。
- [x] 用户显式批准 D1～D8、能力影响清单与 DEV-1（2026-08-27，“开始”）。
- [x] T3～T6 additive contract/oracle 完成。
- [x] T7～T9 Cut A 已发布，前五条账删除。
- [x] T10～T12 Cut B 已发布，第六条账删除。
- [x] `KNOWN_VIOLATIONS` 37→31，task SCC family 消失，其他受管 debt 无未登记增长。
- [x] 本地功能 oracle 与对外合同零回归。
- [x] exact-SHA hosted CI 终态绿：`4152b377a` / `33034946053` / 35 of 35 jobs。
- [x] RFC-331/STATE/index 标 Done；RFC-294 下一步刷新为 W2-B。

落地数字：`architecture/current-report.json` digest
`sha256:e9f8a0ec9d551929295bd43b5d271237448e099c6fdb1c60d2d43aa26ebd0cac`；backend/repo SCC
`5/7 → 4/6`，KNOWN `37 → 31`，backend production/module `848/333`，route→DB `15`、
transport→DB `2`、AppDeps `54`、inbound/outbound `92/23`。canonical payload 由 `262f34bf7` 固定；
四条 provenance assertion 已由 `89b19057d` 真实 repin 到该 payload commit。

## 6. 已批准的精确内容

请批 proposal 的：

- D1 范围恰好六条边；
- D2 复用 RFC-328 全部权威；
- D3 实例注入、无 global locator/fallback；
- D4 一个 driver 总合同、消费方窄取；
- D5 WS publisher 与 durable outbox 分相；
- D6 两个目的化 read model；
- D7 两刀逻辑切割，最终单笔 cohesive 发布；
- D8 功能保真优先；
- 能力影响清单七行均为零行为变化。
- design DEV-1：只在既有 `startTaskDeps.ts` composition seam 临时绑定 legacy task/scheduler，并新增两处一跳 public
  compatibility surface；不新增第二个 service facade 文件，按 exact owner/removeAfterWave 在 W2-B/D 删除。

2026-08-27 用户已批准上述内容。批准只授权 RFC-331 T3～T12，不授权 W2-B/C/D 或任何安全/权限/能力收缩改动。
