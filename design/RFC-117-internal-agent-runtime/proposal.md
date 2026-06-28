# RFC-117 — 内部 framework agent 接入运行时选择(只选 profile)

状态:Draft

## 背景

平台用 `opencode` / `claude-code` 两种运行时(RFC-111)+ 命名运行时注册表(RFC-112)+ 运行时即执行 profile(RFC-113:**代理只选运行时、参数〔含 model〕归 profile**)驱动 agent。

RFC-111 引入 `RuntimeDriver` 抽象时,**D14 有意把 4 个内部 framework agent 留在 opencode**(收敛 v1 风险面),并在其 `proposal.md:88` 明确预告:「opencode 可选 / **内部 agent 多运行时」留独立 RFC**。RFC-113 的迁移也据此把这 4 个 agent **排除在 profile 迁移之外**(其 Codex P1-4:「它们不走『选运行时』模型」)。

本 RFC-117 兑现 D14 预告的后续:让这 4 个内部 agent 也「**和普通 agent 一样选运行时**」——按 RFC-113 之后的语义,即**只选一个 runtime profile**(profile 自带 model 等参数),功能本身**不再带独立 model 字段**。

### 现状:4 个内部 agent 实为「两类、非对称」

| Agent | 在 `agents` 表? | 执行路径 | 当前 runtime 行为 | model 来源 |
|---|---|---|---|---|
| **distiller**(记忆提取,RFC-041) | 否(inline config) | 自己 `Bun.spawn`(`memoryDistiller.ts:937`),一次性临时目录,无 task 上下文 | **真写死 opencode**(完全绕过 runtime 抽象) | config `memoryDistillModel` |
| **commit**(commit-push,RFC-075) | 否(`buildCommitAgent` 现造) | `runNode`(`scheduler.ts:1038`),但**唯一未接 `resolveFrozenRuntime`** 的派发点 → `runner.ts:453` fallback | **真写死 opencode** | config `commitPushModel` |
| **fusion / skill-merger**(RFC-101) | **是**(`aw-skill-merger`,builtin agent) | 标准 agent-single 派发(`scheduler.ts:2398` 经 `resolveFrozenRuntime`);`startTask` 透传 `defaultRuntime`(`fusion.ts:473`) | **已跟随 `defaultRuntime`** ✓ | 无 model config → 用所选 profile 的 model(已是 RFC-113 范式) |

- **真写死 opencode、需救**:distiller + commit。
- **后端已合规、只差「可单独指定」**:fusion / skill-merger。它们走标准派发,RFC-112 给该派发点加 `resolveFrozenRuntime` 时已顺带纳入、跟随 `defaultRuntime`;但 `aw-skill-merger` 受 **RFC-104 read-only 锁**(`agents.builtin=1`),用户无法单独给它选 runtime。

scheduler 共 4 个 `runNode` 派发点:commit(`1038`,漏接)、agent-single(`2398`✓)、multi 分片(`3711`✓)、multi 聚合(`3977`✓)。

## 目标

1. 4 个内部 agent 各可**独立选 runtime profile**,留空继承全局 `defaultRuntime`(对齐普通 agent 的 `runtime` 字段语义)。
2. 废弃独立 model 字段 `memoryDistillModel` / `commitPushModel`,其值**无损迁移**成带该 model 的 opencode profile(照 RFC-113 套路)。
3. distiller spawn **收编进统一 `RuntimeDriver.buildSpawn`**(实现 RFC-111 `types.ts` 计划但未做的 slice),复用 `driver.parseEvent`,消除约 150 行与 `runtime/opencode` 的重复。
4. claude-code 也能驱动这 4 个内部 agent(persona/model 经各自 driver 注入)。

## 非目标

- **不让 opencode 变可选**:daemon 仍硬要求 opencode(D14 的这半条不动)。
- **不改 runner.ts 业务节点主 spawn 路径**:`runner.ts` 业务节点的 if/else + `buildInlineConfig`(带 skills/mcp/inventory/in-place mutate 全套)**不切**到 system-agent `buildSpawn`——规避 RFC-111/112 的逐字 golden 断言回归。新 `buildSpawn` 首个消费者是 distiller。
- 不改 `RuntimeDriver` 的 `probe` / `listModels` / `captureSession`。
- 不给 fusion/skill-merger 新增 config 字段(它们经 `/agents` 编辑 builtin agent 的 runtime,与普通 agent 同一入口)。

## 用户故事

- **US-1(降本)**:作为平台使用者,我把业务任务跑在 claude,但想让记忆提取用便宜的 opencode 模型省钱——在「设置 → 记忆」给记忆提取单独选一个 opencode profile 即可,与全局默认互不影响。
- **US-2(全局切换不漏)**:我把全局 `defaultRuntime` 设成 claude-code,期望「全用 claude」——改后 commit message 生成、记忆提取也跟着用 claude(此前它们偷偷留在 opencode)。
- **US-3(融合选引擎)**:我在 `/agents` 给内置 `aw-skill-merger` 选一个 runtime profile,技能融合就用该引擎跑。

## 验收标准

1. 「设置」里记忆提取 / commit-push 各有一个 **runtime profile 选择器**(非 model 下拉),留空=继承全局默认;不再有独立 model 下拉。
2. distiller / commit 选了 profile 时用该 profile 的 (protocol, binary, model) spawn;留空时继承 `defaultRuntime`;`defaultRuntime` 也空时回退 opencode。
3. distiller 经 `RuntimeDriver.buildSpawn` + `parseEvent` 执行;源码不再有自写的 `extractEventText` / inline 事件 JSON 解析;opencode + claude 两种 stdout 都能提取 `candidates`(回归锁 silently-`[]` bug)。
4. 内置 `aw-skill-merger` 的 `runtime` 字段可在 `/agents` 编辑(RFC-104 锁的窄例外),其余字段仍锁;选定后 fusion 用该 runtime 跑。
5. 启动迁移:`memoryDistillModel` / `commitPushModel` 非空时,建/复用一个 `{protocol:'opencode', model:该值}` profile 并指向;旧字段从 config schema 移除;迁移幂等、有 fail-loud 守卫防丢值。
6. 行为变化文档化:distiller/commit 从「写死 opencode」改为「跟随 profile / defaultRuntime」。
7. 门禁全绿(`typecheck && test && format:check` + `build:binary` smoke)+ Codex 设计/实现双 gate findings 全 fold。

## 决策(D1–D8)

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| **D1** | 选择形态 | **各功能独立可选 runtime profile**(留空继承全局) | 对齐 RFC-113 后普通 agent 的 `runtime` 语义(用户答)。 |
| **D2** | model 归属 | **废弃独立 model 字段、只选 profile**;旧值迁移成 opencode profile | RFC-113「参数归运行时」;保留 model 字段会与 profile 自带 model 双源冲突(用户答)。 |
| **D3** | 覆盖范围 | **4 个内部 agent 全做**(distiller/commit/fusion/skill-merger) | 彻底清掉 D14「内部 agent 留 opencode」(用户答)。 |
| **D4** | distiller 改法 | **收编进统一 `RuntimeDriver.buildSpawn` + `parseEvent`** | 实现 RFC-111 计划的 buildSpawn slice;消除约 150 行重复(用户答)。 |
| **D5** | buildSpawn 范围 | 新增**面向系统 agent**(无 skills/mcp/plugins/inventory)的 `buildSpawn`;**不动 runner 业务节点主路径** | 规避 RFC-111/112 逐字 golden 回归;系统 agent 场景简单、首个消费者 distiller。 |
| **D6** | commit 接入 | scheduler 第 4 派发点补 `resolveFrozenRuntime(commitPushRuntime, defaultRuntime)`,对齐其余 3 点;`buildCommitAgent` 去 model | 复用既有 frozen-runtime 通路;model 归 profile。 |
| **D7** | fusion/skill-merger 接入 | 后端已合规;**放开 builtin agent 的 `runtime` 字段编辑**(RFC-104 窄例外),经 `/agents` 选;无新 config、无 model 迁移 | 它已跟随 defaultRuntime + 参数归 profile;缺口仅「只读锁挡住单独指定」。 |
| **D8** | 迁移与守卫 | 启动时 config-model→opencode profile(照 RFC-113 `migrateAgentParamsToRuntimes` 去重/命名)+ 删旧 config 字段 + fail-loud 守卫(照 RFC-115 `assertConfigDefaultsMigrated`) | 无损、幂等、防跳级丢值。 |
