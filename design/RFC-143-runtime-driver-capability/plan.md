# RFC-143 — 任务分解与 PR 拆分

原则：**fortify-then-refactor**——每个 PR 先补 oracle（红）再动刀；从低风险机械收口逐步逼近最硬的业务 spawn。单个 RFC 拆 5 个 PR（`plan.md` 说明拆分，各自立 PR，commit 前缀 `feat(runtime): RFC-143 ...`）。

## PR 依赖图

```
PR-1（接口+派生单源，地基）
 ├── PR-2（probe/listModels/defaultBinary）
 ├── PR-3（inventory/live-poll/capture + 空转 bug）
 └── PR-4（业务/smoke spawn，最硬，建议 PR-2/3 后）
PR-5（resolveOpencodeCmd dedup + 半死代码，独立，可最后）
```

---

## PR-1｜RuntimeDriver 接口扩展 + 派生单源（低风险地基）

- **T1** 扩 `runtime/types.ts` 的 `RuntimeDriver`：加 `minVersion` 字段 + `buildBusinessSpawn`/`defaultBinary`/`probe`/`listModels`/`captureSessions` 必需方法签名 + `readInventory?`/`startLiveCapture?` optional 方法签名；补 `BusinessNodeSpawnContext`/`SessionCaptureContext`/`LiveCaptureContext`/`ListModelsOpts`/`RuntimeModelList`/`InventorySnapshot` 类型；`RuntimeProbe` 加可选 `apiKeySource?`。两 driver 暂以「委托现有自由函数」占位实现（保持编译绿）。
- **T2** 派生单源：`RUNTIME_PROTOCOLS`/`BUILTIN_NAMES` 从 `Object.keys(DRIVERS)` 派生（`runtimeRegistry.ts`）；`ProtocolSchema`（`routes/runtimes.ts:28`）从 DRIVERS keys 派生。
- **T3** `nodeRunMint.ts:307,373` 硬编码 `'opencode' || 'claude-code'` 集合 → `isKnownRuntimeKind`（基于 RUNTIME_PROTOCOLS）；`runtimeRegistry.ts:171` 改用 `BUILTIN_NAMES`。
- **T4** 确认 `resolveRuntime`（`runtime/index.ts:32`）生产无调用者（rg），删或改查表；`runtime-resolve.test.ts` 同步。
- **T5** oracle：派生单源源码锁测试（RUNTIME_PROTOCOLS/BUILTIN_NAMES/ProtocolSchema 派生自 DRIVERS；无硬编码 kind 字面量集合）；mock-driver 测试**骨架**（先声明第三 kind 的 driver 占位，红，作为 PR-4 完成后转绿的验收基座）。
- 验收：typecheck×3 / test / binary smoke 绿；派生锁绿；mock 骨架按预期红（接口未全实现）。

## PR-2｜probe + listModels + defaultBinary 收口（纯能力，中低风险）

- **T6** oracle：probe/listModels/defaultBinary 现有单测先迁移为「经 driver 调用」的期望形态（红）。
- **T7** probe：`extractVersion`/`compareSemver` 提到 `util/semver.ts` 单份，两 driver import（消重复）；实现 `opencodeDriver.probe`/`claudeCodeDriver.probe` + `minVersion`；`routes/runtimes.ts:129` / `cli/start.ts:77,134` / `cli/doctor.ts` 改调 `driver.probe`（boot 硬/软 gate 策略留调用点）。
- **T8** listModels：统一签名 `Promise<RuntimeModelList>`（claude 忽略 binary、恒 cached:true，静态表内化进 claude driver；opencode CLI+cache 内化进 opencode driver）；`routes/runtime.ts:35` 改调 `driver.listModels`。
- **T9** defaultBinary：`driver.defaultBinary(config)` 统一；消 `runtimeRegistry.ts:239` + `routes/runtimes.ts:80` 两拷贝 + `runtimeHead`；`memoryDistiller.ts:925` env override 内化进 opencode driver。
- 验收：门禁全绿；probe/listModels/defaultBinary 调用点无 `protocol === xxx` / `isClaude`。

## PR-3｜inventory + live-poll + capture 收口（含空转 bug 修复）

- **T10** oracle：live poller 空转回归测试（claude runNode 断言 opencode SQLite 零 open）；capture/inventory 集成锚点。
- **T11** `startLiveCapture?`：opencode driver 实现（内化 `startLiveSubagentCapture`）；claude 不实现；`runner.ts:1120` 改 `driver.startLiveCapture?.(ctx) ?? NOOP_HANDLE`——**空转 bug 消除**。
- **T12** `readInventory?`：opencode driver 实现（回读 `runRoot/inventory.json`）；claude 不实现；`runner.ts:1500` 改 `await driver.readInventory?.({ runRoot }) ?? null`。（注入部分在 PR-4 随 buildBusinessSpawn 搬迁；本 PR 先收回读 + 把 `runner.ts:536` 的注入 gate 暂留占位或一并处理，视 T15 排期。）
- **T13** `captureSessions`：必需方法，并集 ctx；两 driver 各实现（opencode SQLite / claude JSONL）；`runner.ts:1457` 改 `driver.captureSessions(ctx)`。
- 验收：空转回归绿；capture 两 runtime 各自路径绿；`runner.ts` capture/live/inventory-回读 段无 `runtime === xxx`。

## PR-4｜业务 spawn + smoke spawn 收口（核心难点，最高风险，最后做）

- **T14** oracle：确认 `runtime-opencode-golden.test.ts` 现状绿作为基线；补 buildBusinessSpawn 的 opencode/claude 各自输出等价性测试（对拍收口前后 argv/env）。
- **T15** opencode `buildBusinessSpawn`：把 `buildInlineConfig`（含 dependsOn 闭包 resolve）+ inventory plugin 追加 + memory block 织入 inline prompt + `JSON.stringify` + `buildOpencodeSpawn` 调用整块搬进 opencode driver；`SpawnPlan.diagnostics` 回传 model/variant/temperature/mcpKeys/pluginNames；inventory 注入随此并入（与 PR-3 T12 回读配对）。
- **T16** claude `buildBusinessSpawn`：system-prompt-file 组装 + `toClaudeMcpConfig`/`toClaudeAgents` + 凭据桥决策**内化进 claude driver**（runner 不再传 `bridgeCredentials`）+ `buildClaudeSpawn` 调用；`diagnostics` 回传。
- **T17** `runner.ts:830` 主分支替换为 `const plan = driver.buildBusinessSpawn(ctx)`；`opencodeCmd`/`runtimeCmd` 双字段收敛成 `testBinaryOverride`；`runtime-spawn-head.test.ts` 同步。
- **T18** smoke（`runtimeSmoke.ts:99`）：复用 `driver.buildSpawn`（system-agent）或 `buildBusinessSpawn`；消 `buildSmokePlan` if/else。
- **T19** 验收终锁：`runtime-opencode-golden` byte-for-byte 绿（**硬约束**）；旁路清零源码文本锁（`rg` 断言 `packages/backend/src` 排除 runtime/ + tests 无 runtime/protocol/isClaude 判别）；mock-driver 集成测试转绿（PR-1 T5 骨架，证明「注册即扩展」零调用点改动）。
- 验收：golden 逐字绿；旁路清零锁绿；mock driver 集成绿；门禁 + binary smoke 全绿。

## PR-5｜resolveOpencodeCmd dedup + 半死代码收尾（独立）

- **T20** `resolveOpencodeCmd` 5 拷贝（`routes/{tasks,clarify,taskQuestions,reviews,fusions}.ts`）→ 单一实现（util 或走 `driver.defaultBinary`）；opencode-only launch thread 语义保留。
- **T21** `resolveInternalAgentRuntime` legacyModel 半死分支（`runtimeRegistry.ts:217`）确认无活数据（`assertConfigDefaultsMigrated` 已强制迁移）后删；有活数据则显式标 opencode-only。
- 验收：门禁全绿；resolveOpencodeCmd 单份源码锁。

---

## 总验收清单（proposal §4 映射）

1. ✅ 旁路清零（PR-4 T19 源码文本锁）
2. ✅ golden 锁 byte-for-byte（PR-4 T19）
3. ✅ live poller 空转消除（PR-3 T10/T11）
4. ✅ mock driver「注册即扩展」证明（PR-1 T5 骨架 → PR-4 T19 转绿）
5. ✅ 派生单源（PR-1 T5）
6. ✅ 门禁全绿含 binary smoke（每 PR）
7. ✅ Codex 设计门（本文档）+ 实现门（每 PR）

## 风险与回滚

- **最高风险 = PR-4**（业务 spawn）。缓解：§4.2「分支体整块下移、spawn 函数不动」保证 golden byte 不变；T14 收口前后 argv/env 对拍；任何 golden 红即回滚该处重做。
- **binary 模块环**（memory `reference_binary_build_module_cycle`）：派生单源触 shared 导出——每 PR 必跑 `build:binary`。
- **协作者并发**：runtime 域近期 RFC-111/112/113/116/135 活跃改动——每 PR rebase 前 `git pull --rebase`，保 `runtime-buildspawn` / `memory-distiller:633` 文本锁 + `claudeSandboxEnv` IS_SANDBOX 精确串不被动。
