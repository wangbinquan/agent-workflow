# RFC-179 工作组房间运行态可见性 —— plan

## 任务分解

### 批次 A — 后端逐成员当前 run 映射（单一事实源）

- **RFC-179-T1**：`shared/schemas/workgroupRuntime.ts` 加 `WorkgroupMemberCurrentRun` 类型（`nodeRunId`/`status`/`kind`〔+可选 `triggerMessageId`〕）+ 房间聚合 member 行 `currentRun` 字段。依赖：无。
- **RFC-179-T2**：`deriveMemberCurrentRun` 纯函数（leader-round / assignment / message-turn 归并 + running 优先 + 排除 wg-gate + human→null）+ table 测试（§8.1）+ shardKey 前缀契约锁（§8.2）。依赖：T1。
- **RFC-179-T3**：房间聚合（`routes/workgroupTasks.ts`）接线——加载 `__wg_leader__`/`__wg_member__` host runs（若缺）+ 逐成员 `currentRun` 派生 + （若选后端派生）`triggerMessageId`。依赖：T2。

### 批次 B — 前端可点 + drawer 接线

- **RFC-179-T4**：花名册成员行可点（`<button>` 内层，`currentRun===null` disabled）+ `onClick→setDrawerRunId(currentRun.nodeRunId)` + a11y（aria-label/testid）。leader 行同款（对等，无特判）。依赖：T3。
- **RFC-179-T5**：drawer 复用核验（第三列开合、Session 实时刷新）——无新组件，集成断言点击→drawer 打开正确 run。依赖：T4。

### 批次 C — P2 执行中呈现

- **RFC-179-T6**：`lib/workgroup-room.ts` 加 `memberExecuting` / `mentionTriggeredExecutions` 纯函数 + table 测试（§8.3）。依赖：T3。
- **RFC-179-T7**：渲染①提及消息内联「执行中」pill（复用 StatusChip/脉冲芯片）+ 渲染②消息流合成「@X 执行中…」活跃行；run 终态即消失。依赖：T6。
- **RFC-179-T8**：i18n（pill / 合成行 / 会话按钮 aria，zh+en 对称）+ 明暗/窄屏视觉核验 + 源级回归断言（§8.5）。依赖：T4、T7。

## 依赖图

```
T1 → T2 → T3 ┬→ T4 → T5
             ├→ T6 → T7
             └──────────→ T8（收 T4+T7）
```

## PR 拆分建议

- **PR-1（后端映射）**：T1–T3。可独立交付、独立测试（聚合返回 currentRun，前端暂不消费）。
- **PR-2（前端可点+drawer）**：T4–T5。依赖 PR-1。
- **PR-3（P2 执行中）**：T6–T8。依赖 PR-1（+ PR-2 的花名册结构）。

单 RFC 三 PR；若 Codex 门/用户偏好合并，可 T1–T8 单 PR（纯派生 + 前端接线，无 migration，风险低）。

## 验收清单

- [ ] 房间聚合返回每个 agent 成员 `currentRun`（running 优先 / 最近终态 / null）；leader 归并 `__wg_leader__`、成员归并 assignment+message-turn；human→null。
- [ ] `deriveMemberCurrentRun` table 全绿（三类 run + 空闲 + 无 run + 排除 wg-gate + 多 assignment）。
- [ ] shardKey `msg:${memberId}:` 前缀契约测试存在且绿（engine 改格式即红）。
- [ ] 花名册 agent 成员行可点（role/testid）、点击 `setDrawerRunId`、第三列 drawer 打开正确 run；`currentRun===null` 行 disabled。
- [ ] leader 行可点、打开 `__wg_leader__` 当前 run（源级断言接线）。
- [ ] P2：running+提及→提及消息 pill + 合成活跃行；run 终态→消失（集成 + 纯判据 table）。
- [ ] 源级回归：成员 `<li>` 点击接线存在；P2 判据不在巨组件外重复实现。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；单二进制 build smoke 通过。
- [ ] 明暗 + 窄屏视觉核验（第三列开合、pill/活跃行）。
- [ ] Codex 设计门 findings 全折（批准前）+ 实现门 findings 全折（实现后）。
- [ ] `design/plan.md` RFC 索引 + `STATE.md` 登记（Draft→In Progress→Done）。

## 备注（多人协作）

本 RFC 与并发 session 的 RFC-177（task-subject-stable-id-link）/ RFC-178（remove-external-source-skills）共享工作树。提交时只按精确 pathspec 提 RFC-179 自有文件 + `plan.md`/`STATE.md` 自有行；`plan.md`/`STATE.md` 若混入他人在途行，按 CLAUDE.md「同一文件混改一起提、message 只述己方」处理，不剥离他人内容。
