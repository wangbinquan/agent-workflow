# RFC-284 — 技术设计（design）

> 读法：每节给出「单点落位 → 迁移调用方清单 → 失败模式 → 测试策略」。
> 行号锚以审计报告为准（审计基线 ≈ `e7361b02`，接手时先复核锚点是否漂移）。
> 首要原则沿袭 RFC-282：**功能不受影响 > 归一彻底程度**；每个换实现的批次
> 先写新旧对拍再删旧实现。

## §1 G1 微 helper 收口

### 1.1 safeJson（20 份 → 1）

- 落位：`util/http.ts` 新增 `export async function safeJson(req: Request): Promise<unknown | null>`（以 `services/workgroup/taskActions.ts:536` 已 export 版为种子语义：parse 失败返 null，不 throw）。
- 迁移：17 个 routes 文件的本地同名定义 + `taskActions.ts` 本体改 re-export；两个字符串入参变体（`oidcProviders.ts:357`、`mcpProbeStore.ts:132`）语义不同（入参 string），改名 `safeJsonParse` 另收一点或保留本地（design 决策：**保留本地并注释区分**，避免语义混淆）。
- 失败模式：某 route 的本地版有细微差异（如 content-type 检查）→ 迁移前逐份 diff，差异版不强并（记录在 plan 对照表）。
- 测试：grep 计数断言「`async function safeJson` 在 src 出现次数 == 1」。

### 1.2 containment 双查（3+ 份 → 1）

- 落位：`util/safePath.ts` 增 `lexicalThenRealpathInside(root, candidate)`（先词法后 realpath 双查；语义以 `portArtifacts.ts:227-283` 现实现为准——它自述"对齐 worktreeFiles.ts / RFC-103 T7"）。
- 迁移：`envelope.ts:131-160`、`portArtifacts.ts:227-283,474` 改调；`worktreeFileContent.ts:68-138` 的 handle-first O_NOFOLLOW 变体是**刻意升级不收编**（注释已完备）；`platformExec.isLexicallyInside` 是纯词法原语、保留作底层被复用。
- 失败模式：三处对 symlink/不存在路径的边界行为不一致 → 迁移前为每处写行为快照测试（存在/不存在/symlink 内/symlink 外 四象限），迁移后逐字节同判。
- 测试：四象限行为锁 + 「双查模式在 src 只此一份」文本断言。**这是安全关键收口，对拍不许省。**

### 1.3 hash 包装（~11 → 1 组）

- 落位：`util/hash.ts`：`sha1Hex(input)` / `sha256Hex(input)`。
- 迁移：sha1Hex 三份（repoCredentials.ts:38 / webhookDispatch.ts:68 / gitRepoCache.ts:63）+ 内联 sha256 约 8 处（scheduler.ts:7406、mcpRuntimeTest.ts:156、intent/dumpBuilder.ts:99、auth/sessionStore.ts:33、auth/patStore.ts:72、taskOperations.ts:186 等）。**webhook 那份的输出进 dedup 键、session/pat 的进凭据链**——迁移是纯等价替换（同算法同编码），对拍断言输出字节相同。
- 例外：`pluginOperationRevision.ts` ↔ `mcpOperationRevision.ts` 的 16 行镜像桥**不收**（shared 无 node:crypto 的分层理由成立，注释互指即可）。

### 1.4 drained/timeout race（2+2 → 1）

- 落位：`util/process.ts` 增 `raceWithFallback(promise, ms, fallback)`。
- 迁移：`util/git.ts:195` 与 `gitRepoCache.ts:139`（逐字拷贝对）；`runtime/opencode/util.ts:105` 与 `runtime/claudeCode/probe.ts:89` 的 timeout race 同构对。250ms 窗口值保持各调用点自持（语义参数不上收）。

### 1.5 探针三胞胎（spawnProbe）

- 落位：`util/process.ts` 增 `spawnVersionProbe(head: string[], opts: { timeoutMs })`——detached + 组杀 + exit 先行 + capped read 的单一实现；杀链统一用 `killProcessTree`（三份中 models 版已用、两份 probe 版是裸 `process.kill(-pid)`，统一到前者）。
- 迁移：`runtime/opencode/util.ts:55-130`、`runtime/claudeCode/probe.ts:42-108`、`util/opencode-models.ts:132-187`（该文件本批同时迁入 `runtime/opencode/`，见 §3.6）。
- 失败模式：三份的 finally 补杀姿势有出入 → 以「组杀 + finally 二次组杀防漏」为统一语义，对拍各自的超时/正常/立死三态输出。

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
- 迁移：ws/registry.ts:383-398,400-416（迁移后其对 `:942` adminShortCircuit 的非局部依赖消除——admin 判断进入共享函数；上层 shortCircuit 保留为性能捷径但不再是正确性前提）、mcpRuntimeTestTransitions.ts:126-133。
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
- smoke/distiller 各自结果域补同款 warn（不落库）。

### 3.5 进程治理对齐

- pluginInstaller `runCommand` → `runManagedProcess`（保留 `resolveNpmCommandForHost` win32 解包；64KB 截断语义改用 managedProcess 行/字节上限等价配置；超时树杀）。对拍：正常安装/超时/失败三态的 outcome 与产物路径不变。
- `structuralDiff/deep/indexers.ts:152-165` probeIndexer 补 10s deadline（照 scriptRun.ts:276-287 姿势）；`deep/runner.ts:47-57` kill 换 killProcessTree。
- `scriptRun.ts:266-300` probeInterpreter：spawn 加 detached、超时组杀、有界读（照 §1.5 spawnVersionProbe，直接复用）。
- git 双点（util/git.ts:135-208 ↔ gitRepoCache.ts:95-151）：**不收编**（RFC-208/252 特化语义有据），加一条双向源码文本锁测试（镜像段落 drift 即红）。
- `MAX_STREAM_LINE_CHARS`：runner.ts:2080 改 re-export `MANAGED_PROCESS_MAX_LINE_CHARS`。

### 3.6 opencode-models 迁移 + 死导出

- `util/opencode-models.ts` → `runtime/opencode/models.ts` 邻位（或并入现有 models.ts）；`runtimeRegistry.ts` 对 `evictOpencodeModelsCache` 的具名依赖改为 driver 可选方法 `evictBinaryCaches?(binaryPath)`（registry 变 kind-blind）。
- 删除 `resolveOpencodeCmd` re-export 与实现（生产消费为零；1 个测试改直连或删）。
- `types.ts` legacy ctx 两型加 `@deprecated`（真删随 RFC-282 B4 登记项）。

### 3.7 spawn 棘轮

- 新测试 `spawn-site-ratchet.test.ts`：扫 src 下 `Bun.spawn(`/`spawnSync(`/`child_process`，与显式 allowlist（managedProcess、util/git×2、gitRepoCache、探针经 spawnVersionProbe 后的唯一点、tar/npm 等逐一列明）精确对账；新增站点必须改名单（带 why 注释）。

## §4 G4 调度/任务侧与边界制度

- `buildChildDeps`（scheduler.ts:3710-3765）：`RunTaskOptions` 拆出 `inheritable: InheritableRunConfig` 子对象，子任务整体透传；不可继承字段留顶层。对拍：现有全部转发字段逐一等值（含 RFC-266 池配置、RFC-282 收尾修过的 configPath 三段）。
- `nodeRunMint.ts` 增 `nextRetryIndex(db, taskId, nodeId, { topLevelOnly })`；迁移 task.ts:3700 / review.ts:2657-2667 / taskQuestionDispatch.ts:1739 / scheduler mint 处，**各点口径参数化保持现语义**（含/不含 child rows 差异写进调用点参数，行为不变）。
- memoryDistillScheduler.ts:151-152 改 `agentRefOfNode`。
- S4（D11）：`stuckTaskDetector` S4 规则对 `parent_task_id IS NOT NULL` 行阈值 30min；alert detail 增 `childBudgetWaitHint`。测试：5min<t<30min 的子任务不告警、顶层照告；30min+ 子任务告警带 hint。
- cadence 常量：`services/daemonCadence.ts` 注册表（名称→ms→来源注释）；start.ts 两处裸 1h 与各扫描器默认值改引用（数值不变）。
- diffSplit（D12）：删 `util/diffSplit.ts` + `diff-split.test.ts` + `diff-split-binary-boundary.test.ts`；`git.ts:1482` 的指向注释改写。
- `wrapperProgress.phase`：codec 移除写入、读旧行 passthrough；两处自述注释删除。
- 边界规则：`.dependency-cruiser.cjs` 增三条（no-routes-to-db / no-util-to-upper / no-auth-to-services），存量违例按 (rule,from,to) 进 `scripts/depcheck.ts` KNOWN_VIOLATIONS（routes→db 18 文件、util/git 族沿用既有 6 条合并 removeWhen、auth 迁移后应为零）。**ESLint flat-config 陷阱注意：扩展既有 block 不新增同名对象**（RFC-282 教训）。
- `authLoginPolicy.ts` → `auth/loginPolicy.ts`（60 个正向消费方 import 路径不变——它们 import 的是 `auth/actor` 等；本文件的 8 个消费方改路径）。
- webhook CRUD 抽 `services/webhookEndpoints.ts` + `services/webhookTriggers.ts`（路由变薄壳）。**blocked by RFC-283**；抽取时保留 RFC-283 落地后的行为字节不变。
- `buildClosureRefNameMaps`（routes/agents.ts:576-634）→ `services/agent.ts`；multipart 编排（routes/tasks.ts:1298-1516）→ `services/launchMultipart.ts`（文件已存在）。对拍：两条启动臂（JSON/multipart）的门检顺序与错误码不变。
- `mcp/tools.ts:120-123` StartTaskSchema 镜像：改由 shared 的 StartTask schema 推导字段名（`satisfies` 键集断言），漂移编译期红。
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
