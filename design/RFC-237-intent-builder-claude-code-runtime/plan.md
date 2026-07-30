# RFC-237 意图构建器支持 Claude Code 运行时（plan）

状态：Draft（待用户批准后实施；批准前不改生产代码）。
单 RFC 对应单 PR；commit 前缀 `feat(intent): RFC-237 意图构建器支持 Claude Code 运行时`。

## 任务分解

| ID | 任务 | 产出 / 关键文件 | 依赖 |
|---|---|---|---|
| RFC-237-T1 | 二进制封印模块通用化 | 新 `services/runtime/binarySnapshot.ts`（实现整体搬入、通用命名）；`runtime/opencode/runtimeBinary.ts` 变 thin re-export（旧名 alias，`OPENCODE_BINARY_IDENTITY_CODEC` 留守）；T-B 同一性断言 + opencode 既有测试零改动绿 | — |
| RFC-237-T2 | claude driver 物化 `intent-read-v1` | `claudeCode/spawn.ts`：`systemPermissionProfile` ctx 字段 + 受控分支（argv §2.2 / env §2.3 含 `IS_SANDBOX` 剥离 / 封印 §2.4 + `SpawnPlan.preSpawnVerify` 钩子）；`claudeCode/driver.ts`：fail-closed 改查自身声明、透传 profile 与 RFC-154 configDir 键（`SystemAgentSpawnContext` 增 `configDirEnv?/Name?`）、桥接决策内化（seam 缺省 = 真实运行）、`testOnlyUnverifiedRuntime` seam；`systemAgentRun` spawn 前 `await plan.preSpawnVerify?.()`；T-A 单测全量 | T1 |
| RFC-237-T3 | `RuntimeDriver` 能力字段 | `runtime/types.ts`：`narrowedSystemPermissionProfiles` + `SYSTEM_PERMISSION_PROFILES` 文档改写（§1.3 all-deny 诚实记录）；opencode / claude driver 各声明 `['intent-read-v1']` | — |
| RFC-237-T4 | admission 双门重构 | `routes/config.ts:79-91` 与 `intent/turnEngine.ts:649-676` 改为能力判别（错误码不变、消息去 opencode 尾句）+ **继承态保存门**（defaultRuntime 变更且 intent 留空时校验有效运行时，design §1.2/P2-3）；`shared/schemas/config.ts:221-229` 注释；turnEngine 透传 runtime 行 configDir 键；T-C（422 反转 + fail-closed 保留 + 继承态 + turnEngine 放行） | T3 |
| RFC-237-T5 | systemAgentRun 补捞能力化 + 终态归一 | `runtime/types.ts` `captureSessionsToSink?` + opencode 实现搬入 + `systemAgentRun.ts:622-637` 特判消除；claude `parseEvent` 的 `is_error` result → `SystemAgentRunResult.resultError` + 新终态 `result-error`（design §4.1/P2-4，distiller/smoke 调用方随 TS 穷尽顺修）；T-E 回归 | T3 |
| RFC-237-T6 | mock-claude 全链 | turnEngine 全链用例（envelope→changeset→draft→`intent_turn_events`→capture 终态）；T-D | T2, T4, T5 |
| RFC-237-T7 | 源码锁强化 | `rfc143-runtime-driver-capability.test.ts` 正则升级 + `cli/start.ts` 白名单登记 + `routes/runtime.ts:83` 收口（优先能力化，否则显式 allowlist + 理由，design §5/P2-1）+ 自检样例；T-F（须在 T4/T5 消除旁路后收口） | T4, T5 |
| RFC-237-T8 | 前端 i18n + 差异附注 | en/zh `intentHint`/`intentRuntimeHint` 改写 + 新 key `intentRuntimeClaudeNote`；`settings.tsx` intent 卡有效协议解析 + 条件附注（`.settings-hint` 既有样式）；T-G 新测试文件 + T-H | T4 |
| RFC-237-T9 | 收口 | 全量四门禁 + STATE.md / `design/plan.md` 索引状态更新 + 真机一轮 intent 会话（真实 claude）验证记录 | 全部 |

## PR 拆分建议

默认单 PR（T1-T9）。若实现门要求缩小 diff，可拆两个：PR-1 = T1+T3（纯基建，零行为
变化）；PR-2 = 其余。不建议更细——admission 放行（T4）与 driver 物化（T2）合并交付才不
出现「保存通过但 spawn 拒绝」的中间态。

## 实施注意（防踩坑）

- **他人未提交改动**：`packages/frontend/src/routes/settings.tsx` 与
  `tests/settings-system-agents-render.test.tsx` 工作树里有他人的 Card 视觉重构未提交。
  T8 改 `settings.tsx` 时在其当前工作树内容之上最小编辑、一起 commit（消息只描述本 RFC
  改动）；渲染测试放**新文件**，不动他人测试文件。
- **RFC-235 领地**：`intent/turnSession.ts`、前端 intent 组件群是 RFC-235 的活跃面，本
  RFC 不触碰（只动 turnEngine 的 runtime 解析段与 systemAgentRun 捕获 seam）。
- claude 业务节点 golden byte-lock（RFC-143 相关测试）不得因 spawn.ts 改动而漂移——受控
  分支必须由 profile 显式进入，默认路径 byte-unchanged（T-A #2 锁）。
- 提交前四门禁 + push 后按 exact SHA 查 CI（`docs/dev-gotchas.md`）。

## 验收清单（与 proposal 验收标准一一对应）

- [ ] T-A/T-B/T-C/T-D/T-E/T-F/T-G/T-H 全绿（design §10）。
- [ ] opencode intent 路径、claude 业务/distiller/smoke 路径 byte-unchanged 回归绿。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿。
- [ ] Codex 设计门（RFC 批准前）与实现门（declare done 前）各一轮、findings 闭合。
- [ ] STATE.md 顶部与 `design/plan.md` RFC 索引状态推进。
