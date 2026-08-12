# RFC-284 — 技术设计（design）

> 读法：每节给出「单点落位 → 迁移调用方清单 → 失败模式 → 测试策略」。
> 行号锚以审计报告为准（审计基线 ≈ `e7361b02`，接手时先复核锚点是否漂移）。
> 首要原则沿袭 RFC-282：**功能不受影响 > 归一彻底程度**；每个换实现的批次
> 先写新旧对拍再删旧实现。

## §1 G1 微 helper 收口

### 1.1 safeJson（20 份 → 2，按语义族收口）

- **设计门修订（路 2 P1）**：20 份实测分**三个语义族**——parse 失败 `return {}` ×13
  （routes/tasks.ts:1207 等）、`throw ValidationError('invalid-json', 'request body is
not valid JSON')` ×4（codeHosts.ts:35 / scheduledTasks.ts:45 / webhookEndpoints.ts:36 /
  webhookTriggers.ts:57）、同码异文案 ×1（intentSessions.ts:84 "must be JSON"）。
  强并为一份必然改 wire 行为（坏 JSON 的错误码在 `invalid-json` 与 `validation-error`
  之间漂移）——因此收口为**两个** util：`safeJsonOrEmpty(req)`（返 `{}`）与
  `safeJsonOrThrowInvalid(req)`（throw ValidationError('invalid-json')，文案统一时
  intentSessions 的文案差异记入对照表并保持其现文案或列 C 清单）。
  种子 `taskActions.ts:536-542` 实测语义是**返 `{}`**（初稿误写「返 null」，已纠）。
- 迁移：各 routes 按现语义对号入座；webhookEndpoints/webhookTriggers 两文件的迁移
  **挪入 T28（RFC-283 后）**。string 入参变体（oidcProviders.ts:357 / mcpProbeStore.ts:132）
  保留本地并注释区分。
- 测试：grep 计数断言「本地 `async function safeJson` 定义在 routes 归零；两 util 各恰一份」
  - 两族各一条坏 JSON wire 行为锁（错误码不变）。

### 1.2 containment 双查（3 份 → 1 骨架 + 各点语义参数化）

- **设计门修订（双路 P2）**：三份是**真·四象限不同判**——
  envelope `resolveWorktreePath`（envelope.ts:134-148）对 realpath ENOENT
  **回退词法判定放行**（存在性由 handler 另报错、喂 followup），且 RFC-193 分支
  改写 targetAbs/relativePath、返回三元组；portArtifacts `readInsideRoot`
  （:277-291）与 `existsInsideRoot`（:469-483）对任何 resolve 失败**直接拒**，
  且接受绝对路径存量行（:275-286）。**不能统一语义**（任一方向都出零行为白名单）。
- 落位改为：`util/safePath.ts` 增 `checkLexicalThenRealpath(root, candidate, opts:
{ allowNonexistentByLexical: boolean; allowAbsolute: boolean })` 返回结构化
  verdict（lexical 结论 / realpath 结论或 ENOENT / 归一路径），三个调用点各自
  显式传参 + 薄适配保持现语义与现返回形状（envelope 的三元组在其适配层拼装）。
  共享的是**双查骨架**，不是判定策略。
- `worktreeFileContent.ts:68-138` handle-first O_NOFOLLOW 变体刻意升级不收编；
  `platformExec.isLexicallyInside` 保留为底层词法原语。
- 测试：迁移前为三点各写四象限（存在/不存在/symlink 内/symlink 外）+ 绝对路径
  行为快照，迁移后逐字节同判；「双查骨架在 src 只此一份」文本断言。
  **安全关键收口，对拍不许省。**

### 1.3 hash 包装（~11 → 1 组）

- 落位：`util/hash.ts`：`sha1Hex(input)` / `sha256Hex(input)`。
- 迁移：sha1Hex 三份（repoCredentials.ts:38 / webhookDispatch.ts:68 / gitRepoCache.ts:63）+ 内联 sha256 约 8 处（scheduler.ts:7406、mcpRuntimeTest.ts:156、intent/dumpBuilder.ts:99、auth/sessionStore.ts:33、auth/patStore.ts:72、taskOperations.ts:186 等）。**webhook 那份的输出进 dedup 键、session/pat 的进凭据链**——迁移是纯等价替换（同算法同编码），对拍断言输出字节相同。
- 例外：`pluginOperationRevision.ts` ↔ `mcpOperationRevision.ts` 的 16 行镜像桥**不收**（shared 无 node:crypto 的分层理由成立，注释互指即可）。

### 1.4 drained/timeout race（2+2 → 1）

- 落位：`util/process.ts` 增 `raceWithFallback(promise, ms, fallback)`。
- 迁移：`util/git.ts:195` 与 `gitRepoCache.ts:139`（逐字拷贝对）；`runtime/opencode/util.ts:105` 与 `runtime/claudeCode/probe.ts:89` 的 timeout race 同构对。250ms 窗口值保持各调用点自持（语义参数不上收）。

### 1.5 探针三胞胎（spawnProbe）

- 落位：`util/process.ts` 增 `spawnVersionProbe(head: string[], opts: { timeoutMs?,
env?, cwd?, maxBytes? })`——组杀 + exit 先行 + capped read 的单一实现；杀链统一
  `killProcessTree`（models 版已用、两份 probe 版是裸 `process.kill(-pid)`，统一到前者）。
- **设计门修订（路 1 P3）三处真实差异全交代**：① opencode/util.ts:76 的 detached
  **仅在 timeoutMs 有值时开**（:70 注释承诺无-timeout 时保持历史 flat spawn
  byte-for-byte）——该承诺**参数化保留**（timeoutMs 缺省 → flat spawn 路径不变）；
  ② models 版是双流 readCapped + timer.unref + finally 异步 reap
  （reapModelsProcessGroup）——由 opts.maxBytes 与统一 finally 组杀覆盖，
  reap 语义对拍三态（超时/正常/立死）确认输出不变；③ finally 补杀姿势统一为
  「组杀 + finally 二次组杀防漏」。
- 迁移：`runtime/opencode/util.ts:55-130`、`runtime/claudeCode/probe.ts:42-108`、
  `util/opencode-models.ts:132-187`（该文件本批同时迁入 `runtime/opencode/`，见 §3.6）。

### 1.6 monotonic updatedAt（4 → 1）

- 落位：`util/time.ts` `monotonicNow(prev: number): number`。迁移 plugin.ts:494 / mcp.ts:154,298 / agent.ts:771。`resourceOperationCoordinator.ts:111-116` 带 floors 的变体用途不同，不收。

## §2 G2 资源侧去重

### 2.1 反查引用泛型（4 → 1）

- 落位：`services/resourceRefs.ts` 增 `findAgentsReferencingIdInJsonColumn({ column, id, matcher })`（async + inTx 双形态；LIKE `%"<id>"%` 预过滤 + JSON parse 精确匹配）。
- 迁移：mcp.ts:360-427、plugin.ts:311-377、skillReferenceGuard.ts:20-84（**补上它缺的 LIKE 预过滤**——行为不变、扫描量降）、agentDeps.ts:228-245。`ReferencingAgentRow` 类型单点导出。

### 2.2 scheduled 引用扫描单点（3 → 1）

- 落位：`services/scheduledTasks.ts` 导出 `scheduledRowsReferencing({ launchKind, payloadKey, id })`；迁移 agent.ts:804-818 / workflow.ts:784-800 / workgroups.ts:894-931。

### 2.3 by-resource grant SQL（5 → 1）

- 落位：`resourceAcl.ts` 增 `grantsOfResourceWhere(type, resourceId)` + `listResourceGrantUserIds(InTx)`；迁移 resourceAcl 内两处 + workflow.ts:741-745 + workgroups.ts:560-563 + mcpRuntimeTestTransitions.ts:251-256。

### 2.4 快照式可见性（3 → 1）

- 落位：`resourceAcl.ts` 增纯函数 `isVisibleToAudienceSnapshot(userId, role, { visibility, ownerUserId, grantedUserIds })`——**含 admin 分支**（isResourceAdminRole）。
- 迁移：ws/registry.ts:383-398,400-416（迁移后其对 `:942` adminShortCircuit 的非局部依赖消除——admin 判断进入共享函数；上层 shortCircuit 保留为性能捷径但不再是正确性前提）、mcpRuntimeTestTransitions.ts:126-133。**注（路 1 P3）**：mcpRuntimeTestTransitions 版多一道 `status==='active'` 检查（:126-127）——该检查**留在调用方**，共享函数签名不含 status 位。
- 测试：三处迁移前行为快照（admin/owner/grant/public/private × 当事人/旁人矩阵），迁移后同判。

### 2.5 resourcePolicy 'agent' 死条目（D2）+ 单点破口

- `DisableableResourceKind` 删 'agent'；表条目删除；`:105` 锚点注释修正。守卫：新测试逐条读 `RESOURCE_DISABLE_POLICY` 的 kind，对照 drizzle schema 对应表**必须存在 `enabled` 列**（用 drizzle 表对象反射，不 grep 文本）；变异实证：临时加回 'agent' 必红。
- `bundle/apply.ts:743` 改 `initialPrivateResourceAcl(ctx.actor.user.id)`（一行）。
- skill 唯一性：`isSkillNameOccupiedForOwner` 内部改 `ownerScopedNameWhere`；错误识别改 `isOwnerNameUniqueViolation('skills','skills_owner_name_unique')`。对拍：占用/未占用/并发唯一约束三态。

### 2.6 fence 选型表（文档）

- `resourceAcl.ts` 头注释追加六类 OCC fence 对照表（机制/理由/错误码现状），并注明「stale 错误码归一在 RFC-285」。

## §3 G3 runtime/执行器收口

### 3.1 selfCheck 蕴含守卫

- `runtime/selfCheck.ts` 增两条：`startupObservation === 'inventory-file' ⇒ typeof driver.readInventory === 'function'`；`'init-event' ⇒ typeof driver.parseStartupInventory === 'function'`。boot 拒启（复用现有 assert 路径），注入式纯函数可测。

### 3.2 二元 cast 修复

- `mcpRuntimeTest.ts:2547` 改 `defaultConfigDirProfile(session.runtimeProtocol)`（`runtimeRegistry.ts:264` 既有函数）。

### 3.3 session-not-found 下沉（D10）

- `RuntimeDriver` 增可选 `detectSessionNotFound?(stderrTail: string): boolean`；opencode driver 持现四条正则；claude driver 补其措辞（以真实 claude resume 失败输出为准——**实现时须实测采样，不靠记忆**；采不到就先只迁 opencode、claude 留 TODO 注释+登记，不瞎写正则）。`sessionModeFallback.ts` 改为调用能力面；`decideResumeSessionId` 的 `supportsSessionResume` reserved 位保持不动。
- 失败模式：claude 措辞猜错 → 告警仍缺失但不误报（方法返回 false 走原路径），安全方向。

### 3.4 drainTimedOut 消费（D9）

- runner 在 `runResult.drainTimedOut === true` 时：`log.warn`（结构化）+ 写入该 run 的 `startup_verification_json` 附加字段 `outputTailTruncated: true`（shared schema 加可选字段，向后兼容）；envelope 解析失败路径的 errorMessage 前缀加 `output tail truncated;`。前端 StartupVerificationBanner 已消费该 JSON，新字段按既有 warning 形态渲染（i18n key 双语）。
- **设计门修订（双路 P2/P3）无宿主分支明确**：`startupVerificationJson` 现仅在
  `declaredHasContent && !observationSkippedByDesign` 时才写（runner.ts:1826-1828），
  且 `StartupVerificationRecordSchema` 三段必填——零注入/无观测的 run 该列为 NULL。
  裁决：**该场景只打结构化 warn + errorMessage 前缀，不合成占位 record**（不为一个
  布尔字段伪造三段必填结构；观测面记录仅在既有 record 存在时附加字段）。测试覆盖
  两分支：有 record run 的字段附加 + NULL 列 run 的 warn-only。
- smoke/distiller 各自结果域补同款 warn（不落库）。

### 3.5 进程治理对齐

- pluginInstaller `runCommand` → `runManagedProcess`（保留 `resolveNpmCommandForHost` win32 解包；超时树杀）。**设计门修订（双路 P3/P2）**：现 64KB 是**前缀**总量截断（:780-786 + :291 slice(0,…)），managedProcess 是 rolling-tail 行/流上限——两套上限**不同轴、无等价配置**；失败错误文案的截断方向会从「头 64KB」变「滚动尾」，信号死 exitCode 与超时即杀 vs TERM→KILL 宽限亦有差异。处置：截断方向与超时宽限变化列入 proposal C 清单（C7），对拍加 >64KB stderr fixture 的 message 断言 + 信号死/超时错误类型断言；outcome 与产物路径仍须逐字节不变。
- `structuralDiff/deep/indexers.ts:152-165` probeIndexer 与 `scriptRun.ts:266-300` probeInterpreter：**均直接复用 §1.5 `spawnVersionProbe`**（初稿曾让 probeIndexer 照 scriptRun 姿势——那正是同节要修的弱站点，已纠）；`deep/runner.ts:47-57` kill 换 killProcessTree。
- git 双点（util/git.ts:135-208 ↔ gitRepoCache.ts:95-151）：**不收编**（RFC-208/252 特化语义有据），加一条双向源码文本锁测试（镜像段落 drift 即红）。
- `MAX_STREAM_LINE_CHARS`：runner.ts:2080 改 re-export `MANAGED_PROCESS_MAX_LINE_CHARS`。

### 3.6 opencode-models 迁移 + 死导出

- `util/opencode-models.ts` → `runtime/opencode/models.ts` 邻位（或并入现有 models.ts）；`runtimeRegistry.ts` 对 `evictOpencodeModelsCache` 的具名依赖改为 driver 可选方法 `evictBinaryCaches?(binaryPath)`（registry 变 kind-blind）。
- 删除 `resolveOpencodeCmd` re-export 与实现（生产消费为零；1 个测试改直连或删）。
- `types.ts` legacy ctx 两型加 `@deprecated`（真删随 RFC-282 B4 登记项）。

### 3.7 spawn 棘轮

- 新测试 `spawn-site-ratchet.test.ts`：扫 src 下 spawn 站点与显式 allowlist 精确对账；新增站点必须改名单（带 why 注释）。**设计门修订（双路 P3）**：
  - 站点全集补齐（路 1 实测）：managedProcess、util/git×2、gitRepoCache、探针族（收编后经 spawnVersionProbe 的唯一点）、tar/npm、**cli/doctor.ts:290,330、services/controlListener.ts:253、util/process.ts:74,161,170（杀链自身的 ps/探测）、util/win32Acl.ts:14,256**。
  - 扫描模式集扩为 `Bun\s*(\.|\[)\s*['"]?spawn`、`spawnSync`、`child_process`、`Bun\.\$`（防别名/下标/模板串绕过），**排除注释行**（mcpProbe.ts:300 注释假阳）。
  - allowlist 条目附加约束「不得 re-export spawn 能力」，同一测试扫描名单文件的导出面（防白名单 wrapper 洗白）。

## §4 G4 调度/任务侧与边界制度

- `buildChildDeps`（scheduler.ts:3710-3765）：`RunTaskOptions` 拆出 `inheritable: InheritableRunConfig` 子对象，子任务整体透传；不可继承字段留顶层。**设计门修订（路 2 P2）双向锁**：对拍不止「现有全部转发字段逐一等值」（14 项，含 RFC-266 池配置、RFC-282 收尾修过的 configPath 三段），还须**锁不转发面**——`secretBox`/`commitPush`/`mergeAgent`/`scriptInterpreters`/`scriptDepsInstallTimeoutMs`/`fanoutMaxShardTotal`/`codeHostConnections`/`codeHostFetch` 今天刻意（或事实上）不转发，实现时逐字段登记处置表（inherit / 刻意不继承+why / 疑似漏配待另立），并加「dropped 集合不变」断言与转发集对拍成对——防「看起来像可继承」的字段被顺手塞进 inheritable 造成静默行为变更。
- `nodeRunMint.ts` 增 `nextRetryIndex(db, taskId, nodeId, { topLevelOnly })`；迁移 task.ts:3700 / review.ts:2657-2667 / taskQuestionDispatch.ts:1739 / scheduler mint 处，**各点口径参数化保持现语义**（含/不含 child rows 差异写进调用点参数，行为不变）。
- memoryDistillScheduler.ts:151-152 改 `agentRefOfNode`。
- S4（D11）：`stuckTaskDetector` S4 规则对 `parent_task_id IS NOT NULL` 行阈值 30min；alert detail 增 `childBudgetWaitHint`。测试：5min<t<30min 的子任务不告警、顶层照告；30min+ 子任务告警带 hint。
- cadence 常量：`services/daemonCadence.ts` 注册表（名称→ms→来源注释）；start.ts 两处裸 1h 与各扫描器默认值改引用（数值不变）。
- diffSplit（D12）：删 `util/diffSplit.ts` + `diff-split.test.ts` + `diff-split-binary-boundary.test.ts`；`git.ts:1482` 的指向注释改写。
- `wrapperProgress.phase`：codec 移除写入、读旧行 passthrough；两处自述注释删除。**设计门修订（路 2 P3）**：旧版 daemon 回滚读新行会因旧 codec `phase` 必填 safeParse 失败 → 走 init path 重跑 wrapper（不崩但重复工作）——**明示不承诺回滚兼容**（进 proposal C5 措辞）。
- 边界规则：`.dependency-cruiser.cjs` 增三条（no-routes-to-db / no-util-to-upper / no-auth-to-services），存量违例按 (rule,from,to) 进 `scripts/depcheck.ts` KNOWN_VIOLATIONS。**设计门修订（路 2 P2/P3）四点**：
  - 三条新规则统一加 `viaOnly: { dependencyTypesNot: ['type-only'] }`（既有 no-runtime-cycles 的先例姿势）——否则 routes→db 会把 `routes/resourcePackages.ts`/`resourceAcl.ts` 两条 `import type` 记成违规，日一计数 20≠18 当场红；design 同时注明「barrel 转口不在边级规则射程，属已知局限」。
  - **no-auth-to-services 的白名单面**：`auth/sessionStore.ts:12`、`auth/patStore.ts:18` 现存 `@/ws/revalidationHook` 依赖（注册式轻模块、无环）——规则 to 面定义为 `services/` 单方向（不写成「只准 db/util/shared」），`ws/revalidationHook` 显式豁免并注明理由。
  - **过渡账目**：规则在批 A（T2）落、authLoginPolicy 迁移在批 F（T24）——中间 `auth/session.ts:19 → services/authLoginPolicy` 这条现存反向边先入 KNOWN_VIOLATIONS（removeWhen=T24），T24 完成后棘轮销账。
  - routes→db 的 18 文件账目与 RFC-283/T28 有先后耦合：webhook 两路由被抽 service 后账目条目会变过期（depcheck 检查③禁过期），后落地一方须同步清账——plan T2/T28 注明。
- `authLoginPolicy.ts` → `auth/loginPolicy.ts`（60 个正向消费方 import 路径不变——它们 import 的是 `auth/actor` 等；本文件的消费方实测 **7 个** src import 文件改路径〔初稿写 8，按路 1 实测纠正；若含测试另计并在迁移时逐一列出〕）。
- webhook CRUD 抽 `services/webhookEndpoints.ts` + `services/webhookTriggers.ts`（路由变薄壳）。**blocked by RFC-283**；抽取时保留 RFC-283 落地后的行为字节不变。
- `loadClosureRefNames`（routes/agents.ts:577-634；初稿误记为 buildClosureRefNameMaps，已纠）→ `services/agent.ts`；multipart 编排（routes/tasks.ts:1298-1516）→ `services/launchMultipart.ts`（文件已存在）。对拍：两条启动臂（JSON/multipart）的门检顺序与错误码不变。
- `mcp/tools.ts:120-123` StartTaskSchema 镜像：改由 shared 的 StartTask schema 推导字段名（`satisfies` 键集断言），漂移编译期红。**挪入 T28 批（RFC-283 A4/A5 也在改 mcp/tools.ts，避免并发冲突）**。
- env 开关：`docs/dev-gotchas.md` 或新 `docs/env-flags.md` 登记全部 `AGENT_WORKFLOW_*`/`AW_*`；`AW_RUNTIME_STATUS_PROBE_TIMEOUT_MS`（routes/runtimes.ts:115-121）改 `ListRuntimesOpts.probeTimeoutMsForTest` opts 注入，env 通道删除。
- clarify 迁移（D18）：clarifyAutoDispatch/clarifyQueue/clarifyRerunLedger/clarifyRounds/clarifySeal 五文件迁 `services/clarify/`，原路径留 `export * from './clarify/xxx'` facade；迁移前 `git status` 确认无他人在途改动。

## §5 失败模式（全局）

- 收口引入行为漂移 → 每批对拍先行（§各节）；C1-C6 之外零行为差异是硬验收。
- 并发踩踏 → webhook 批 blocked by RFC-283；clarify 迁移前确认工作树；每批小步提交。
- 锚点漂移 → 实现前逐锚复核（审计基线到实现时 main 已前进）。

## §6 测试策略

- 每个收口点：唯一性 grep/计数断言 + 迁移前后对拍（行为快照或字节等价）。
- 守卫类（AC-2/3/4/5）：红→绿测试对 + 变异实证（临时违规必红，还原即绿）。
- 每批 pin worktree `gate:local` 全绿；推后 exact-SHA 查 CI。
- 实现门：按仓规跑（共享 main 上用独立子代理对抗评审替代 Codex `--base`，沿 RFC-281/282 先例）。
