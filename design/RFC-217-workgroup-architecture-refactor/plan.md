# RFC-217 工作组架构重构（plan）

> 单 RFC 分期多 PR（用户拍板）。三条线：**D 线**（引擎/状态/route）、**C 线**（clarify 归一）、**F 线**（前端）。
> 依赖关系：PR-1 是一切结构 PR 的前置；PR-2 是 PR-4/5 的前置；C 线内部严格 A→B→C；F 线仅 F1 依赖 D 线的 wire 改名（PR-5）。
> 每 PR 门槛：`typecheck + lint + test + format:check + depcheck` 全绿（depcheck 自 T1 接线起）；结构 PR（标 ★）加 `build:binary`；push 后按本人 sha 查 CI。

## D 线（引擎 / 状态 / route）

- **RFC-217-T1（PR-1 ★）地基与守卫**
  常量迁 `workgroup/constants.ts`（WG_*_NODE_ID / 端口 / 预算）+ 全仓 import 改指；dependency-cruiser 加 `no-circular`（既有环若>1 白名单登记）**并接线 CI**：`bun run depcheck` 进 ci.yml 与本 plan 门槛行（设计门 P2：脚本存在但 lint/CI 均不调）；既有工作组 service 文件平移进 `services/workgroup/`（纯移动+改 import，不改逻辑）；`buildWorkgroupHooks` 迁 `workgroup/hooks.ts`（必要时先抽中立执行原语模块）；守卫文件 `rfc217-architecture-locks.test.ts` 立 G1/G6 两条。
  验收：depcheck 在 CI 真跑且绿；build:binary 绿；全量测试绿（纯搬家零断言变化）。

- **RFC-217-T2（PR-2）状态真表**
  migration 0106（建表 + backfill〔gate 五态含 `declared` 中断窗口 + `$.dw` 整槽入 `dw_state_json`〕+ json_remove 剥 gate/dw/wgPause/autonomous + nudge 行打 kind）；`state.ts` 编解码 + `casGateStatus` 转换表（含 `rejected→idle` 消费边与 `declared` 两写窗口态）；**dw 翻转与 resume CAS/snapshot swap 同事务**（经 `resumeTaskWithAtomicSideEffects`）；三种写法两入口全部改走 state.ts（`persistGate` / route 覆写 / json_set 删除）；config schema strict 化；journal 计数测试 bump。
  验收：G2/G3（全退役槽）锁生效 + 变异实证；冻结旧库 fixture（含 declared-only 中断快照、awaiting_confirm 的 dw 任务带 generatedDef/rejectRounds）→ 迁移 → resume/confirm 集成测试；gate 派生字段等值测试。

- **RFC-217-T3（PR-3 ★）turnExecution + 策略拆分**
  先落「四 driver 行为并集」快照测试；抽 `turnExecution.ts`（`retryPolicy` 为 TurnSpec 入参：message turn 单发 maxAttempts=1、dw **不套循环**只复用重提示构造器/解析助手，各配行为锁）；4 driver 重试块收编；`strategies/leaderWorker.ts` / `freeCollab.ts` 落地，wake/outcome 模式分支迁入；`?? 'free_collab'` 删除改 fail-loud；rerun cause 枚举化；`msg:` shardKey codec。engine.ts 主循环成形，`workgroupRunner.ts` 删除。
  验收：AC-1/2/5；G5/G6/G7 变异实证；message 单发与 dw 预算行为锁；真子进程 e2e 全绿；策略表测平移完成。

- **RFC-217-T4（PR-4）route 下沉 + oracle**
  `taskActions.ts` 落地，七个肥 handler 下沉（config PUT 拆四步骤函数）；5 处裸 insert 消灭；`ConfigPatchSchema` 复用 shared switches；WS 广播进 service；`oracle.ts` 落地 + 全仓 20+ 判别点改造。
  验收：AC-4/6；G2/G4 变异实证；`routes/workgroupTasks.ts` ≤400 行。

- **RFC-217-T5（PR-5）round 概念拆分**
  `rounds.ts`→`budget.ts` 更名与三概念 accessor；room 聚合 `roundsUsed`→`budgetUsed`、fc round → `null`；前端 + e2e 同步（先 grep 出清单）。
  验收：AC-7；budgetUsed 等值回归测试；rfc209 互 oracle 锁保持绿。

- **RFC-217-T6（PR-6）双数据源收口**
  room 端点派生全量移入 `room.ts`；reconcile/领养匹配谓词统一导出；`update(workgroupAssignments)` 写点收口 lifecycle.ts；写侧 grep 锁。
  验收：房间聚合字节级等值测试（改造前后同库同响应）；drift 家族既有测试绿。

## C 线（clarify 归一）

- **RFC-217-T7（PR-7）读侧统一 + 写侧补齐 + 双盲调修复**（依赖：无；可与 D 线穿插）
  读侧全切 `clarify_rounds`；**lifecycleRepair options-C1/S2 等「只写遗留表」修复路径改同事务双写统一表**（设计门 P1，双表分歧制造源）；答题广播按 kind 单发；baseline 测试改造。
  验收：读侧对遗留表引用归零（除双写点）；修复路径双写集成测试；广播单发集成测试。

- **RFC-217-T8（PR-8）T17 删表 + directive 收敛**
  migration 0107（**字段级 reconcile**：同 ID 生命周期字段以遗留表为准、统一表独有列保留；仅遗留有则 INSERT + directive 收编垫片逻辑 + DROP 双表 + clarify_rounds 重建**只剥 question_scopes_json、directive 列保留为 round 级处置记录**）；双写代码删除；`clarifyMigration.ts` 整删；dual-write 测试家族退役。
  验收：AC-8 前半；G8 变异实证；冻结旧库迁移测试（含仅存在于遗留表的尾数据 + 同 ID 双表分歧样本 + 已 stop 旧轮不被后续 continue 复活）。

- **RFC-217-T9（PR-9）self/cross 服务合并**
  `services/clarify/service.ts` kind 泛化（DTO/broadcast 单份）；`terminatedAs` DTO 归一 + 前端消费点；`sessionModeFallback.ts` 改名迁出；dispatch/autoDispatch 文件内拆函数 + conflict code 枚举化（锁契约不动）。
  验收：AC-8 后半；self/cross 对称测试合并为参数化单套。

## F 线（前端）

- **RFC-217-T10（PR-10）房间拆分**（依赖 PR-5 的 wire 改名先行或同 PR 适配）
  `room/` 目录拆件（Composer/Timeline/SideCards/RunStatusRow/子组件出文件）；room query 单 owner；`useListboxNavigation` 抽 hook；重渲隔离测试；G9 源码锁。
  验收：AC-10 前半；vitest 全绿。

- **RFC-217-T11（PR-11）编辑器原语与收尾**
  `useOwnedEditScope` 提炼公共 + 单测；ErrorBanner/StatusChip/Card title 违规修复；`.dw-panel__*` 命名空间；i18n 缺口；死代码清扫（maxRounds default 漂移、`iteration` 注释地层等随触碰清理）。
  验收：AC-10 后半；原语审计点名项（属「既有原语映射」档）清零。

## 收尾

- **RFC-217-T12（PR-12）文档回写与索引**
  design/*.md 相关断言更新（RFC-164/182/209/215 中被本 RFC 改变落点的描述加勘误指针）；STATE.md / RFC 索引置 Done；守卫矩阵终检（九锁逐条变异复证记录）。

## 验收清单（对照 proposal §5）

| AC | 落点 PR | 验证方式 |
|---|---|---|
| AC-1 布局 | T1/T3 | 目录结构 + 行数统计 |
| AC-2 骨架去重 | T3 | G6 + 并集快照测试 |
| AC-3 状态真表 | T2 | G2/G3 + 迁移集成测试 |
| AC-4 route 下沉 | T4 | G2 + 行数 |
| AC-5 mode 收敛 | T3 | G5 + fail-loud 测试 |
| AC-6 oracle | T4 | G4 |
| AC-7 round 拆分 | T5 | 等值回归 |
| AC-8 clarify 归一 | T7-9 | G8 + 迁移测试 |
| AC-9 no-circular | T1 起 | CI + build:binary |
| AC-10 前端 | T10/11 | 行数 + 重渲测试 + G9 |
| AC-11 e2e 铁律 | 全程 | rfc186/187 家族每结构 PR 跑 |
| AC-12 存量兼容 | T2/T8 | 冻结库 fixture 迁移测试 |

## 风险登记

- T1/T3 是大搬家 PR：当日完成当日推，精确 pathspec 提交，撞并发 session 冲突即停下问用户。
- C 线次序不可倒置（读切换先于删表）；T8 前置脚本证明读侧引用归零。
- migration ×2：journal `when` 接合成轴（0106=1786550400000、0107=+86400000），multi-statement breakpoints，推前跑全量 backend suite（[feedback_full_suite_after_migration]）。

## 交付记录（2026-07-22，T12 收尾）

12 PR 全部交付并推送（每 PR 前置门：typecheck+lint+format:check+定向套件；结构性 PR 加 build:binary；migration PR 加全量 backend suite）：

| 任务 | 提交 | 摘要 |
|---|---|---|
| T1 地基与守卫 | `2756c97d` | workgroup/ 目录化 + constants.ts 斩环 + dependency-cruiser no-circular 真接线 + G1 四锁 |
| T2 状态真表 | `399b0f7f` | migration 0106 `workgroup_task_state`（gate 五态 CAS + dw 检查点整槽 + pause 列）+ nudge kind 化 + G2/G3 |
| T3a 骨架收编 | `5823c301` | 四 driver 收编 executeTurn（重试/软拒/followup/投影/广播单点化） |
| T3b 引擎解体 | `335fa501` | runner 2748 行 → engine 786 + strategies/{lw,fc} + memberTurns + prompts；roundMode fail-loud |
| T3c codec/常量 | `08fa177a` | msg shardKey codec（shared/workgroup.ts 防 TDZ 环）+ WG_RERUN_CAUSE + G5 棘轮/G7 |
| T4a 写端点下沉 | `3bc2b63f` | 五写端点 → services/workgroup/taskActions.ts；routes 1453→600 |
| T4b/c oracle+读下沉 | `a53e0af9` 等 | isWorkgroupTask 全仓 oracle + G4；读端点下沉 room.ts；routes → 118 行纯 transport |
| T5 round 拆分 | `a7541f8f` | budgetUsed wire 改名 + fc round 显式 null（DB 列不动） |
| T6 写侧收口 | `3efa5ca9` | update(workgroupAssignments) 唯一属主 lifecycle.ts + s14 台账 |
| T7 clarify 读侧统一 | （T7 批） | 读侧全切 clarify_rounds + 修复路径双写补齐 + 答题双盲调消灭 |
| T8 真 T17 | `f1964395` | migration 0107：同 ID 分歧 reconcile + 尾行补 INSERT + RFC-132 双垫片折入 + DROP 双遗留表 + 重建剥 question_scopes_json；夹具统一 clarify-fixtures + era-lock 冻结器 migration-freeze.ts；G8 |
| T9 服务合并 | `fbe29023`+`0ac1c6b7` | clarify.ts+crossClarify.ts → services/clarify/service.ts kind 泛化（createClarifyRound 判别联合 + rowToRound 单 DTO + 单播 wire 冻结适配）；terminatedAs 判别列贯穿三层；sessionModeFallback 改名迁出；15 冲突码枚举化；dispatch 双巨函数拆段（锁契约零改动）；baseline 对称双套并参数化单套 |
| T10 房间拆分 | `1d435563` | room/ 目录九件套；composer 状态下放（打字不重渲全房，探针测试+变异实证）；房间 query 单 owner + G9；useListboxNavigation 抽 hook |
| T11 原语收尾 | `8ce6ce97` | useOwnedEditScope 提炼+单测；六处裸 error span → ErrorBanner；Card title/actions 最小扩展 + side-title 13px 淘汰；.dw-panel__* 命名空间；RunStatusRow i18n 缺口 |

**守卫矩阵终检**（T12，全部一次通过）：`rfc217-architecture-locks.test.ts` 13 pass（G1 目录/环、G2 route 禁裸写+写端点属主、G3 gate 编解码唯一、G4 kind oracle、G5 mode 收敛棘轮、G6 骨架去重、G7 shardKey codec、G8 clarify 单地层、G9 房间 query 单 owner、T6 写属主等）；每条守卫落地当时均做过变异实证（红→修→绿记录见各 PR）。

**AC 对照**：AC-1〜AC-12 全达成；AC-11（rfc186/187 真子进程 e2e 家族不打桩跑绿）在 T3/T8/T9 每个结构性 PR 后重跑通过。

## 偏差记录（与 design.md 原案的差异，均为落地时的更优选择）

1. **rounds.ts 文件名保留**（design 原拟 roundModel.ts）——既有 import 面大，语义等价。
2. **G5 实现为棘轮**（mode 直比场次快照 ≤ 现值）而非绝对禁令——策略对象内 mode 分叉合法。
3. **hooks.ts 只承载类型**，`buildWorkgroupHooks` 本体留在 scheduler.ts——避免 scheduler→engine 反向依赖成环。
4. **T9：dispatchCrossClarifyNode 反向转正**——原判死面删除，落地时发现 5 个测试家族锁其行为语义，改为 scheduler 内联短路把 pending→done 迁移下沉该函数（原因串单源），比删除更符合 RFC 消重旨意。
5. **T9：cross 不复跑 self 信封 schema**——统一 create 首稿两 kind 同跑 ClarifyEnvelopeBodySchema，被 scheduler-cross-clarify-dispatch 的「§4.1 提问上限豁免」锁抓回；终态 self-only 复验。
6. **T10：RunStatusRow 收敛范围窄于原案**——时长/名字留在布局侧（右栏两行网格契约），只收敛 live-status 优先规则 + kind chip（这才是会分叉的语义）。
7. **T8：0029/0031 迁移史锁改 era-lock**（migration-freeze.ts 冻结在 0106）而非删除——历史断言保留，HEAD 不留死表面。
