# RFC-217 工作组架构重构（plan）

> 单 RFC 分期多 PR（用户拍板）。三条线：**D 线**（引擎/状态/route）、**C 线**（clarify 归一）、**F 线**（前端）。
> 依赖关系：PR-1 是一切结构 PR 的前置；PR-2 是 PR-4/5 的前置；C 线内部严格 A→B→C；F 线仅 F1 依赖 D 线的 wire 改名（PR-5）。
> 每 PR 门槛：`typecheck + lint + test + format:check` 全绿；结构 PR（标 ★）加 `build:binary`；push 后按本人 sha 查 CI。

## D 线（引擎 / 状态 / route）

- **RFC-217-T1（PR-1 ★）地基与守卫**
  常量迁 `workgroup/constants.ts`（WG_*_NODE_ID / 端口 / 预算）+ 全仓 import 改指；dependency-cruiser 加 `no-circular`（既有环若>1 白名单登记）；既有工作组 service 文件平移进 `services/workgroup/`（纯移动+改 import，不改逻辑）；`buildWorkgroupHooks` 迁 `workgroup/hooks.ts`（必要时先抽中立执行原语模块）；守卫文件 `rfc217-architecture-locks.test.ts` 立 G1/G6 两条。
  验收：no-circular 绿；build:binary 绿；全量测试绿（纯搬家零断言变化）。

- **RFC-217-T2（PR-2）状态真表**
  migration 0106（建表 + backfill + json_remove 剥 gate/dw/wgPause/autonomous + nudge 行打 kind）；`state.ts` 编解码 + `casGateStatus` 转换表；三种写法两入口全部改走 state.ts（`persistGate` / route 覆写 / json_set 删除）；config schema strict 化；journal 计数测试 bump。
  验收：G2/G3 锁生效 + 变异实证；冻结旧库 fixture → 迁移 → resume/confirm 集成测试；gate 派生字段等值测试。

- **RFC-217-T3（PR-3 ★）turnExecution + 策略拆分**
  先落「四 driver 行为并集」快照测试；抽 `turnExecution.ts`；4 driver + dw-runner 重试块收编；`strategies/leaderWorker.ts` / `freeCollab.ts` 落地，wake/outcome 模式分支迁入；`?? 'free_collab'` 删除改 fail-loud；rerun cause 枚举化；`msg:` shardKey codec。engine.ts 主循环成形，`workgroupRunner.ts` 删除。
  验收：AC-1/2/5；G5/G6/G7 变异实证；真子进程 e2e 全绿；策略表测平移完成。

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

- **RFC-217-T7（PR-7）读侧统一 + 双盲调修复**（依赖：无；可与 D 线穿插）
  读侧全切 `clarify_rounds`；答题广播按 kind 单发；baseline 测试改造。
  验收：读侧对遗留表引用归零（除双写点）；广播单发集成测试。

- **RFC-217-T8（PR-8）T17 删表 + directive 收敛**
  migration 0107（幂等 backfill + directive 收编垫片逻辑 + DROP 双表 + clarify_rounds 重建剥 directive/question_scopes_json）；双写代码删除；`clarifyMigration.ts` 整删；dual-write 测试家族退役。
  验收：AC-8 前半；G8 变异实证；冻结旧库迁移测试（含仅存在于遗留表的尾数据）。

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
