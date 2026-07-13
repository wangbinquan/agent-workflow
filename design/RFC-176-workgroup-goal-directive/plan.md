# RFC-176 工作组目标下发 —— plan

> 单 PR、零 migration。前置读 `proposal.md` / `design.md`。

## 任务分解

### RFC-176-T1 · 注入器分流（`services/workgroupContext.ts` + `services/workgroupRunner.ts`）
- `renderCharterBlock` 去掉 goal（头 `## Workgroup`，只留组名 + 章程）。
- 新增导出 `renderGoalBlock(config)`（`## Group goal` + goal，空 goal → `(not stated)`）。
- `composeLeaderPrompt`：charter 后插 `renderGoalBlock`。
- `composeMemberPrompt`：`mode==='free_collab'` 时插 `renderGoalBlock`，否则不插。
- import 接线。
- 依赖：无。

### RFC-176-T2 · 引擎入口 kickoff 播种（`services/workgroupRunner.ts`）
- `runWorkgroupEngine` 主循环前一次性播种（守卫 `mode∈{lw,fc}` ∧ `roundsUsed===0` ∧ `messages.length===0` ∧ `goal` 非空）。
- lw 定向 leader（`mentionMemberIds:[leaderId]`）、fc 黑板（`[]`）；`authorKind:'system', kind:'chat', bodyMd:goal`。
- 依赖：T1（同文件，一并改）。

### RFC-176-T3 · 测试（core + engine）
- `rfc164-workgroup-core.test.ts`：改 `:359-361` charter 断言（不含 goal / 含 charter）；加 `renderGoalBlock`、`composeMemberPrompt` 两 mode 分流、`composeLeaderPrompt` 含 goal。
- `rfc164-workgroup-engine.test.ts`：lw 首轮 leader prompt 含 goal + worker 指派轮不含 goal（隔离锁）；kickoff 消息形态 + `isPublicRoomMessage`=false（lw）；**P1 回归锁**（无人类消息 → 房间出现 goal chat + dispatch）；fc kickoff 公共 + 成员见 goal；幂等（二次进入不重播）。
- 依赖：T1、T2。

### RFC-176-T4 ·（可选）前端渲染轻断言
- `workgroup-room.test.tsx`：一条 system `kind:'chat'` goal 消息经 `RoomMessage` 正常渲染（无新组件 / i18n）。
- 依赖：无（纯前端既有渲染路径）。

### RFC-176-T5 · 门禁 + 索引
- `bun run typecheck && bun run test && bun run format:check` 全绿；`bun run build:binary` smoke。
- `design/plan.md` RFC 索引加 RFC-176 行（状态 Draft→…→Done）。
- `STATE.md` 顶部「进行中 RFC」指向本目录；完工后移入已完成表。
- 依赖：T1–T3（T4 可选）。

## PR 拆分

单 PR：`feat(backend): RFC-176 工作组目标下发——goal 脱离全员章程块 + 启动即开工`。

## 验收清单

- [ ] `renderCharterBlock` 不含 goal、含 charter；`renderGoalBlock` 含 goal。
- [ ] lw worker prompt 不含 goal 原文；fc 成员 prompt 含 goal；leader prompt 含 goal 块。
- [ ] 新鲜 lw 启动落定向 leader 的 system goal 消息，leader 首轮 prompt「新活动」含 goal，worker 指派轮不含。
- [ ] 新鲜 fc 启动落公共 goal 消息，全员可见。
- [ ] 引擎二次进入不重复播种 kickoff。
- [ ] P1 回归锁：无人类消息即房间出现 goal + 派单卡。
- [ ] 五门全绿 + build smoke + Codex 实现门 findings 全折。
- [ ] `dynamic_workflow` 路径无回归（生成 / 执行不受注入器改动影响）。

## 设计 / 实现门（记忆规约）

- **设计门**：三件套落档后、请用户批准前，跑 Codex 对抗评审（`--base` committed RFC 文档），findings 全折入 design.md。
- **实现门**：代码改动后、宣告完成前，再跑一次 Codex review，findings 全折。
- 推送后按 `feedback_post_commit_ci_check` 立即查 GitHub Actions。
