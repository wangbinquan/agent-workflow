# RFC-182 聊天室执行体验总体重设计 —— plan

## 前置：RFC-181 先行（同 owner 统筹）

RFC-181（全自动硬化 A/A2/C/D）**先以单 PR 落地**（见其 plan.md T1-T4）；本 RFC 的 T1 消费其 `clarify-suppressed` 前缀做 note 派生（契约测试互链）。若 181 因故延后，本 RFC 仍可先行——note 派生对不存在的前缀恒 null，无硬依赖，仅「反问已压制」辅注暂无数据。

## 任务分解

### RFC-182-T1 —— 后端 runHistory 单源 + pending 广播 + wire 补列

- `shared/schemas/workgroupRuntime.ts`：`WorkgroupRunEntry` + room 响应 `runHistory`。
- `services/workgroupRoom.ts`：`deriveWorkgroupRunHistory`（含 note 派生）；`deriveMemberCurrentRuns` 改投影（选取规则逐字节不变）。
- `routes/workgroupTasks.ts`：host-runs 查询补 `startedAt/finishedAt/errorMessage` 三列 + 响应字段。
- `services/workgroupRunner.ts`：三 mint 点后补 `node.status{pending}` 广播（adopted 分支不发）。
- P1-3：`shared/schemas/task.ts` `NodeRun`+`rerunCause`、`routes/tasks.ts` select 加列。
- 测试：design §6.1/§6.2/§6.8（后端 table + 广播断言 + 投影等价对拍 + 前缀契约互链注释）。
- **依赖**：无。**验收**：后端全绿；`rfc179-member-current-run.test.ts` 不改选取语义仅扩展；零 migration（journal 计数不变）；`build:binary` smoke（workgroupRunner 新 import broadcaster 防 cycle）。

### RFC-182-T2 —— 前端 lib oracle + StatusChip 扩展

- `lib/workgroup-room.ts`：`deriveMemberPresence` 四态 / `turnCardsForMessage` / `standaloneTurnEntries` / `buildRoomTimeline` interleave / `formatRoomTimestamp`；删 `streamActiveExecutions`；`memberIsWorking` 消费者清零后删除。
- `components/StatusChip.tsx`：optional `onClick`（span→button 条件渲染，默认逐字节不变）。
- 测试：design §6.3/§6.5 + 既有 lib 测试改写（supersession 注释：RFC-179 render② → 回合卡；memberIsWorking → presence）。
- **依赖**：T1（`WorkgroupRunEntry` 类型）。**验收**：lib/组件单测绿；StatusChip 源级断言。

### RFC-182-T3 —— 回合卡 + 全指示可点 + presence 接线

- `WorkgroupRoom.tsx`：TurnCard（同族样式 `--turn`）；message-turn 卡挂 RoomMessage、leader/降级卡走 timeline entry；房间级 1s 耗时 interval；「反问已压制」辅 chip；executing pill 加 onClick；花名册 presence 四态 chip + 可点；移除活跃行渲染块。
- `styles.css`：`--turn` 修饰 + 浮标 / runlog 前置类（与 T4 共用）。
- 测试：design §6.4 前半（卡流转 / 定格持久 / 防双卡 / 可点断言）+ §6.6 源级断言 + i18n。
- **依赖**：T1+T2。**验收**：`workgroup-room.test.tsx` 全绿（改写 case 带 supersession 注释）。

### RFC-182-T4 —— 双历史入口

- 执行记录卡（aside，倒序 + 空态 + 整行可点 + 限高滚动）。
- drawer 成员作用域 runs（跨成员串台修复）+ P1-3 wg 轮标签（`lib/node-history.ts`）。
- 测试：design §6.4 后半（执行记录 / 串台回归 / 历轮切换）。
- **依赖**：T1+T2（T3 可并行）。**验收**：集成断言绿；串台回归锁落档。

### RFC-182-T5 —— 显示打磨 + 收尾

- 滚动锚定 +「回到最新」浮标；消息时间戳 `formatRoomTimestamp`；i18n zh/en 清点（`i18n-keys-symmetry`）；明暗 × 窄屏视觉核验（design §8）。
- 测试：锚定集成断言（贴底跟随 / 上翻不动 / 浮标点击）+ 时间格式 table。
- **依赖**：T3。**验收**：全套门禁 + 视觉核验记录。

## PR 拆分建议

RFC 默认单 PR，但本 RFC 改动面横跨后端 / lib / 大组件，按依赖单向拆 **3 个 PR**（在此说明，符合 RFC 流程第 5 条）：

- **PR-1 = T1**（后端 + shared，独立可跑绿）`feat(workgroup): RFC-182 T1 runHistory 单源 + pending 广播`
- **PR-2 = T2+T3**（回合卡主体）`feat(workgroup): RFC-182 T2-T3 统一回合卡 + 全指示可点 + presence 四态`
- **PR-3 = T4+T5**（历史入口 + 打磨）`feat(workgroup): RFC-182 T4-T5 双历史入口 + 滚动锚定`

每 PR 独立满足五门；PR-2/PR-3 各跑一次 Codex 实现门。

## 验收清单（全部勾完才算 Done）

- [ ] RFC-181 先行落地（或确认 note 派生空转无硬依赖后先行本 RFC）。
- [ ] runHistory：三类归属 / 升序 / gate 排除 / note 派生 / 投影等价 table 全绿；零 migration。
- [ ] pending 广播：三 mint 点帧断言；adopted 不发；`task-sync-rules.test.ts` 零改动。
- [ ] 回合卡：pending→running→终态定格**持久**（"跑完不消失"回归锁）；assignment 防双卡；「查看会话」可点。
- [ ] 全指示可点：pill / 花名册 chip / 执行记录行 / 卡按钮 → drawer（各集成断言）；StatusChip 默认 span 源级断言。
- [ ] presence 四态：working / awaiting / queued / idle 优先级 table + 同屏矛盾回归断言（leader 轮 / 被 @ 轮 running 时不再「空闲」）。
- [ ] 双历史入口：执行记录卡（倒序 / 空态 / 可点）+ drawer 成员历轮（跨成员串台回归断言）。
- [ ] 打磨：滚动锚定 + 浮标；时间戳跨天；「反问已压制」辅注（RFC-181 协同）；i18n zh/en 对称。
- [ ] prompt 隔离源级断言（runHistory / note / presence 不入 compose*Prompt）。
- [ ] 五门全绿：`bun run typecheck && bun run lint && bun run test && bun run format:check` + `build:binary` smoke；push 后按 sha 查 CI。
- [ ] Codex：设计门（批准前，与 RFC-181 修订一并）+ 每实现 PR 实现门，findings 全折。
- [ ] 明暗 + 窄屏视觉核验记录；STATE.md / plan.md 索引状态推进（Draft→In Progress→Done）。
