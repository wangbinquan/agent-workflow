# RFC-235 意图构建完整创建体验 UX 重构 — plan

状态：Draft v21 / 首版切片 In Progress（用户于 2026-07-29 明确授权“基于现在的设计先做出来一版”；首版只实施目标优先/双栏 UX 与 Intent turn Session 复用，完整 supporting contracts 仍待第二十一轮设计门与后续分批批准）

门禁报告：
[codex-design-gate-2026-07-29.md](./codex-design-gate-2026-07-29.md)。

## 1. 任务分解

### T1 Shared schema、migration 与持久身份

- [ ] T1.1 扩 `CreateIntentSessionSchema` 并新增 `IntentMutationEnvelope`、
      source-bound answers/retry/mount-approval bodies、`IntentGenerationReceipt`与 strict
      `IntentMountApprovalReceiptSchema`；approval receipt锁原/结果 turn seq、context revision、
      source-order closed outcomes与 exact approval turn identity；commit拒绝 duplicate `opId` 与
      `(opId,slotId)`；answers拒绝 duplicate question id/picked option、按 single/multi限制数量，
      source options按精确文本首次出现顺序去重。receipt schema无 transform，以编译期 equality
      锁 `z.output === IntentMountApprovalReceipt`，合法 approve/reject runtime parse逐字段不变。
- [ ] T1.1a 新增 shared `IntentArtifactHintSchema`（六类，Auto=wire omitted）并拆分 strict
      `IntentComposerCapabilitiesDtoV3`与 session-only `IntentArtifactCapabilitiesDtoV3`；
      前者接受 create/modify context并可携 opaque
      `IntentPreSessionSourceGrantV1`，后者的 `file.concreteSources`只含 session
      handle/display/binding digest。session/detail内部 schema支持 immutable nullable
      `artifactHint`，capability reason为 closed enum，unknown shape fail closed；两平台 npm/git
      `update=false`。另锁 strict restore raw-stream path/query、`StrictRestoreOptionsV3`、
      `PendingRestoreStageReceiptV3`、status/mutation lookup/cancel、legacy-adopted active status与
      typed repair summary；新增 strict `RestorePlanDtoV3`与 local-control
      `inspect-backup | stage | lookup | cancel` request/response union（fd cardinality按 operation
      固定）；新增 strict `LegacyPendingOperatorRequestV3/ReceiptV3`与
      `legacy-active-pair-ambiguous` operator action，receipt绑定 move publication id/target
      identity；reapply request/receipt必须携 canonical
      `RestoreExecutionOptionsV3 + optionsDigest`，quarantine为独立无 options分支；旧无 body
      DELETE/`{cleared:boolean}`
      shape删除。
- [ ] T1.2 新增唯一 branded `normalizeIntentMutationV1` 与 canonical envelope；scope只接
      trusted actor/session，raw parsed body随后丢弃。明确 create message/hint trim+omit、
      ordered-first mount dedup、source-bound answer/option/approval order、commit
      uniqueness+`opId/slotId` sort且 slot value逐字保留；ledger/writers/resolver只接受 normalized
      type。create normalized body包含可选 opaque pre-session grant bytes；同 id换 grant必须
      conflict，exact accepted replay不重新验证 grant时效。
- [ ] T1.3 backend companion 从现有 host `secret.key` 经 HKDF domain
      `intent-mutation:normalized-v1` 派生独立 key，再提供 HMAC fingerprinter + 非敏感 key id；
      ledger固定 `fingerprint_version='intent-normalized-v1'`，不复用 AES key，测试可注入固定
      key。
- [ ] T1.4 mount-approval body改 normalized discriminated decisions；shared source normalizer按
      `(resourceType,name)` 首次出现顺序去重，frontend/backend共用。
- [ ] T1.5 扩 response schemas：`inFlightTurnId`、turn mutation/source identity；mount-approval
      HTTP/detail content共用同一 strict receipt并校验 outer turn id/seq；
      turn另增 nullable strict
      `execution{captureState,lastEventSeq,eventBytes,rootSessionId,incompleteReason}`；
      `SessionViewResponseSchema`及 nested tree/message全部收紧 strict但不增加 Intent专属
      message kind；
      actor-safe mount `display{name,owner}`、ordered commit
      `attemptSeq/clientMutationId/draftId/draftHash/errorCode/recoveryCode/updatedAt`；journal state
      增 `compensating|repair-required`并与 prepared/applying同属 unsettled；另投影
      `preparedArtifactsVersion/artifactCleanupVerifiedAt`，DTO只允许
      `1|3|'unsupported'`；新写只接受 v3，让 v1 failed不冒充已验证 cleanup，unknown/v2 draft
      codec统一映射 unsupported并 fail closed。
- [ ] T1.6 扩 Intent WS schema为 `intent.apply.updated`与
      `intent.turn.execution.updated{sessionId,turnId,eventSeq}` invalidation；execution frame只
      带 locator/seq、不带 raw payload，保留 committed resource invalidation contract。
- [ ] T1.7 schema/db 新增 owner-scoped `intent_mutation_ledger`；session增
      applyAttemptSeq与 immutable nullable artifactHint，turn增 mutation/source/generation、
      `runAsUserId/runAsPolicy` 与
      runner-claim identity、`dumpAdmissionDigest/dumpAdmittedAt`及 execution capture summary；
      新增`intent_turn_events`的turn cascade FK、单调 event seq、runtime session parent关系、
      source/external event dedupe与 row/byte accounting；journal增
      attemptSeq/errorCode/recoveryCode、`runAsUserId/runAsPolicy`、
      `preparedArtifactsVersion/preparedArtifactsRevision/artifactCleanupVerifiedAt`、
      compensation claim id/time与防御性 unique indexes。新
      running/apply write必须是 exact session owner + `current-session-owner-v1`，新 artifact
      write固定 v3；Plugin writer phase/identity只能以 exact journal revision CAS变化；旧
      nullable row不可 resume final mutation。Plugin server-only manifest detail另增
      sourceKind/operation hash/spec HMAC fence；broker control root新增 strict
      `ArtifactWriterObligationLedgerV3`、`ArtifactPublicationLedgerV3`与
      `PendingRestoreControlLedgerV3` codec/revision（明确不进 backup/restore）。pending control
      envelope保存 stable caller scope/request digest/in-flight phase，public receipt不投影这两项；
      v1无 GC。另增 `LegacyPendingRestoreAdoptionV3`、
      `ArtifactLegacyArchiveAdoptionLedgerV3`、`WorktreeReconstructionLedgerV3`、restore
      ingress/client-locator与 worktree
      reconstruction strict phase codec。legacy pending record保存
      `active-pair | marker-only | archive-only | empty-active | failed-quarantine`实际 evidence；
      active-pair另有 non-restored `LegacyPendingOperatorLedgerV3`，按 stable caller/id/request
      digest保存 claimed/v3-staged/legacy-moving/legacy-held/v3-marker-published/quarantining/
      settled/repair phases，另嵌
      `LegacyPendingMovePublicationV3`的 declared/moving/moved/cleaning/cleaned、opaque
      hold/quarantine target slot、purpose/revision分型的 pre-move/post-cleanup absent proof、
      same-inode/parent-fsync/cleanup evidence，且不自动投影 stage。新增 `.strict()`
      `ArtifactEntryIdentityV3WireSchema`/decoded schema、唯一 canonical encoder、
      `LegacyPendingMovePublicationV3Schema`及 nested canonical equality comparator；dev/ino仅
      canonical uint64 decimal并唯一 decode为 bigint，mode/nlink/fsid为 safe integer，foreign
      id/parent/slot/role/fsync/removed identity在 discovery前拒绝。
      另建 build-bound durable root codec registry，覆盖 writer obligation、artifact
      publication、pending control/in-flight、legacy adoption/move/operator、legacy backup adoption
      与 worktree directory/registration/stale-cleanup/before-Git/effect/reconstruction roots；
      每项有 strict `*WireSchema/*Schema`、input/output equality与唯一 `encode*`。union encoder逐
      branch字段构造并以 `never` guard穷举，nested identity只调 leaf encoder，返回前重过 root
      wire schema；底层 ledger writer只接 root-kind branded canonical bytes，禁止 decoded
      `bigint`直接 stringify、通用 replacer、object spread或 partial mapper。
      restore generation marker与独立 SQLite publication分别以第15/16个 root纳入 registry：七态
      marker各有 strict wire/decoded
      branch、逐字段 encoder与 operation/digest/config disposition/staged/safety/published/
      displaced/publication/migration/barrier/cleanup cross-field约束；只保存 durable projection，
      不序列化 capability。storage frame另固定 strict outer schema、exact kind与 domain-separated
      digest；唯一 `loadCanonicalDurableRootV3(expectedCodec, rawFrame)`在 fatal UTF-8、size、
      outer/inner canonical equality及 decoded refinement全部通过后，才由 module-private
      constructor + runtime WeakSet生成可信实例。storage key另以 fixed namespace/root kind/
      validated root id/revision/frame digest + runtime membership封闭；publication ref lookup逐字段
      验证 full operation。artifact/SQLite root每个 checkpoint写 immutable frame并保存
      previous revision/frame digest；marker引用旧 anchor，restart只沿唯一连续 descendant找
      latest。purpose-specific verifier逐 receipt绑定 phase/mode/staged digest与
      expected/published/displaced identity；repair union按上一 phase保留完整 forensic prefix并由
      transition validator验证，不允许 nullable丢证。
      SQLite root保存 DB/WAL/SHM presence、sidecar remove intent/receipt与 DB no-replace/replace。
      业务层不暴露 raw lookup/rebrand/generic decode。
      worktree receipt
      保存 root/namespace/task-container/repo-target
      `declared|private-prepared|publishing|published|existing|removing|removed|closed-absent|
repair-required` publication state及
      ordered per-repo reservation、
      `already-absent|stale-removing|stale-removed|stale-retained` registration
      preparation、effect前 exact stale admin-entry cleanup intent、bounded repo-admin
      inventory、target/branch before-after、无 add intent的 before-git no-effect branch与
      `none|partial|registered` effect entry；top-level cleanup新增仅 root/namespace可用的
      `created-infrastructure-retained`。新增 `.strict()`
      `WorktreeDirectoryReservationPublicationV3Schema`、registration-preparation/effect schemas与
      逐字段 nested `superRefine`，不保留
      completed-index平行数组；adoption/operator/publication/caller receipt不得互换。
- [ ] T1.8 写有序 migration：旧 journal稳定回填 attemptSeq → session counter同步 MAX →
      SQLite NOT NULL/unique rebuild → legacy-unverifiable ledger/backfill；owner/id collision建
      ambiguous tombstone；旧 running null run-as由 boot terminal；旧 apply null run-as
      不再进入 final transaction。旧 Intent turn execution保持 null，不从`runMeta`伪造 event；
      新 agent reservation原子写 live/seq=0。strict迁移 legacy artifact：exact Skill id/op转 v3并忽略
      absolute path，只有 pluginId或损坏 identity的 unsettled row转 repair-required；既有 terminal
      历史只读、committed只 roll-forward。filesystem cutover另在 singleton lock + verified broker
      下按 released `.restore-pending/restore-pending.json + staged.tar.gz`与 failed quarantine
      真实 layout做 evidence adoption，并 adoption现有 backup archives；不通过 SQL migration、
      不信任 `stagedTarball`/legacy absolute path/filename，也不伪造 caller/publication receipt。
- [ ] T1.9 migration fixture实际执行 0/1/N、committed+failed、同毫秒/回拨后的 next claim=max+1；
      锁 legacy/unknown fingerprint与 generation/apply null run-as exact-POST/dispatch/final
      mutation fail closed、旧 `dumpAdmission*` null兼容、v1 Skill可升级、v1 Plugin
      repair-required、v2/unknown codec与损坏 receipt fail closed、旧 terminal cleanup
      timestamp保持 null/历史 detail标记 unverified；升级前真实 active-pair/marker-only/
      archive-only/empty-active/quarantine rename-before-error/error-written pending evidence及
      post-swap/catch-before-rename active-pair同形 fixture、
      scheduled/auto/manual/pre-\* archive adoption fixture及每 phase crash；`db:check` 与 schema
      snapshot。另锁`intent_turn_events` FK cascade、seq/external id unique、row/byte cap，
      旧 turn execution=null与新 reservation live。
- [ ] T1.10 shared strict body/response/WS tests；backend HMAC测试证明
      endpoint/scope/body/secret变化、key变化、duplicate/permutation合同均准确，DB/DTO/log/error
      无 raw secret或普通 hash；property test要求 fingerprint相等推出 executor normalized bytes
      相等，source guard禁止 raw wire type进入 executor。
- [ ] T1.11 新增 `INTENT_MODEL_CONTRACT_VERSION=3`与 shared六类 field tables/examples；prompt
      renderer只消费该合同。六 example逐个过 strict changeset schema、resolver与 canonical
      validator；golden锁 Plugin package `{kind:'package',spec}`、mounted file
      `{kind:'mounted-file',handle}`、required `description`/`optionsJson?`与 Workflow output
      `ports[{name,bind}]` + matching edge，source guard禁止 prompt旧 `description?/options?`及 raw
      file path。
- [ ] T1.12 更新 checked-in normative appendix与restore/legacy shared contracts：
      artifact与SQLite ref携`frameDigest`，root frame append-only lineage及latest-descendant helper；
      safety/barrier/cleanup exact semantic projection；artifact/SQLite lossless repair union与
      transition validator；legacy adoption的
      `operator-confirmation-required`和全部reapply phase、request/receipt/control/new operation
      必须绑定完整 options authority。严格 typecheck/runtime proof覆盖合法 lineage/repair及
      prepared-as-exchanged、alternate receipt、foreign phase/mode/digest/identity、same receipt id
      跨 role、repair drop/rewrite、legacy current-default回填负例。

依赖：无。T2–T8 不得在 T1 wire 未锁定前复制临时 type。

### T2 Generation reservation、dispatcher 与 OCC endpoints

- [ ] T2.1 抽 `authorizeIntentMutationScopeV1` 与统一 ledger claim/replay：session endpoint在
      private source前以 exact owner取得 branded scope；source loader只能按 scope session查询。
      normalization后 owner/id ledger lookup仍在 freshness与 capability之前；same
      endpoint/scope/fingerprint沿 typed anchor返回，mismatch/corrupt/legacy均 fail closed。absent
      commit才取得 `ArtifactAdmissionLeaseV1`，claim transaction二次 ledger lookup并验证
      boot/provider/op-kind lease，围住 probe→claim race。
- [ ] T2.2 create transaction原子 ledger + in-tx initial mount ACL + session + initial user turn +
      queued agent running + exact owner run-as policy；modify若携 pre-session grant，new id路径在
      同一 transaction验证 actor/target/ACL/source kind/config/spec fence与 expiry后才分配
      session handle。exact replay先沿原 session anchor返回，不因 grant过期/源漂移重复验证或
      dispatch；invalid new request零 ledger/session/turn。
- [ ] T2.3 message/answers transaction插 user request anchor + agent running/error并设置
      `inFlightTurnId` + ledger anchor；answers复验 source且只允许同 source approval receipt作为
      中间 turn。
- [ ] T2.4 retry以 latest terminal agent error为 source，预留新 agent turn；same id replay返回
      原 `IntentGenerationReceipt`。
- [ ] T2.5 新增 `hydrateIntentRunActor` 与 daemon-scoped
      `IntentGenerationDispatcher`：claim短 transaction读取 exact turn/session/current user；
      run-as/owner不一致、missing/disabled或无 `intent:write` 原位 settle
      `intent-runner-principal-unavailable`。普通 owner构造无 credential replay的
      session-equivalent current-role actor，只有 exact system-owned session可用 daemon actor，
      绝不 fallback。
- [ ] T2.6 valid principal 后才 CAS claim、注册 claimId/controller live registry、best-effort
      started event与统一 try/catch/finally；route只 non-throwing wake。`runIntentTurn` 改
      `runReservedIntentTurn`，不再自行 mint。
- [ ] T2.7 reservation 后解析 config，再在 exact inFlight/claim短 transaction检查 budget；
      新 `prepareIntentDisclosureSnapshotInTx` 同一 transaction读取 current owner/session/
      mounts、六类 rows/grants，产出完整 visible-set tokens与 frozen catalog。dump只能消费
      snapshot/Skill immutable version。
- [ ] T2.8 紧邻 spawn 的 `admitIntentDisclosureInTx` 重读 current user与完整
      visible-set/token digest，CAS `dumpAdmissionDigest/At`后才释放 seed。任何
      user/role/ACL/grant/content/root/claim变化丢弃 seed并 settle
      `intent-context-resource-unavailable`；admission后变化不追溯取消 live run。
- [ ] T2.8a create transaction把 strict hint写入 immutable session列；dispatcher每轮从 current
      session与 fresh host qualification构造
      `IntentDocInput.requestedArtifactHint/artifactCapabilities`，在 fenced user/resource文本外
      渲染 trusted section。Plugin mount另按 server-only source fence投影 concrete
      handle/display/binding digest，raw spec/cachedPath不进入 dump。weak hint由明确用户目标覆盖，
      capability不可覆盖；pre-session grant本身不进入 dump。Darwin unsupported npm/git Plugin必须
      问回/解释而非生成 op。
- [ ] T2.8b 抽`SystemAgentEventSinkV1/SessionCaptureSink`：`runSystemAgent`的stdout/stderr line
      consumer按 runtime parse结果 awaited、有序、有界写 sink；现有OpenCode/Claude parent/
      live-child/post-run child capture改接 generic sink，node adapter保持
      `node_run_events`逐字段语义，Intent adapter写`intent_turn_events`。system agent在child
      reap与bounded pipe flush后、private session store cleanup前执行post-run capture并标
      complete/truncated/incomplete；观测失败不改变 Intent业务 outcome，unreaped不读 store。
- [ ] T2.9 maintenance 增 daemon-alive orphan reconcile：unclaimed超 grace重新 dispatch，
      claimed-without-live-owner连续 grace后 terminal settle；live owner不按墙钟误杀；boot
      recovery仍先 settle旧 daemon owner/null-policy row且不以 system resume。
- [ ] T2.10 routes接 V2 receipt且不直接 launch；cancel携 `expectedInFlightTurnId`，queued/live
      分别 exact settle/signal matching claim，不得取消后来 turn。新增
      `GET /api/intent-sessions/:sessionId/turns/:turnId/session`，先复用detail owner/system-admin
      audit read scope，再验证 exact session-owned agent turn；foreign/missing同形404、user turn
      typed 410，event rows只经`parseSessionTree + SessionViewResponseSchema`输出。
- [ ] T2.11 backend tests：reservation commit→claim、claim→registry、registry→run/broadcast注入
      fault且 daemon 不退出；periodic最终 terminal/释放 slot；合法长任务不被回收。另覆盖
      route actor销毁、missing/disabled user、PAT/session revocation、role升降、ordinary admin、
      exact system owner；在 catalog ACL/各类与Skill文件读取/final admission前注入 grant revoke、
      owner transfer、visibility/content change、delete/rename/role downgrade；非 admin
      foreign-private canary不得进 seed/model，admin只保留 final current-role resource-admin
      visibility。另覆盖 admission→spawn语义、config/runtime/budget、reserve/claim后 boot、
      cancel CAS、两个 tab同文本与 response loss；六类 hint/Auto/modify从 body→session→INTENT.md，
      fresh capability drift与 explicit-goal-over-hint；Darwin modify valid grant→session handle、
      tampered/cross-actor/cross-id/expired/drift零状态，以及 accepted response loss后 grant过期仍
      ledger-first exact replay；spy断言 ordinary owner从未被 system替代。另覆盖OpenCode/Claude
      parent/tool/reasoning/child capture、stream insert/capture/flush/unreaped faults、row/byte
      truncation与business-result independence；owner/audit/foreign/cross-session/user-turn route
      矩阵、授权前零 event read、WS 500ms locator-only节流与 node adapter regression。

依赖：T1。

### T3 Source-bound decisions、actor-safe mounts 与 status fence

- [ ] T3.1 新 service原子处理 mount decisions：wire-only parse后先做 immutable exact-owner
      404 gate；只有 branded scope可读取/safeParse同 session durable source。唯一 normalizer再
      拒绝 duplicate/missing/extra并投影 source order，随后做 expected seq验证、
      `canViewResourceInTx` + exact resource name/ACL recheck；writer只消费 normalized object。
- [ ] T3.2 transaction一次更新 manifest、至多 bump一个 context revision并写 source/id-bound
      receipt turn；HTTP/detail content按 shared strict schema逐字段相同，预生成 approval turn id，
      投影 `resultingTurnSeq/resultingContextRevision`与 source-order outcomes；
      reject/already-mounted/no-op语义明确，任一失败整批 rollback。
- [ ] T3.3 answers source validator覆盖 approval receipt之后继续；迟到 answer/approval统一
      `intent-source-superseded`，不插 turn、不 fire。
- [ ] T3.4 detail route按六类资源表投影 actor-safe mount name/owner；deleted/invisible/missing
      owner返回 `display=null`，不泄露 raw label。
- [ ] T3.5 manual add/remove/rebase带 required `expectedContextRevision`；同一 `dbTxSync` fresh
      owner/active/context/inFlight/unsettled，add用 `canViewResourceInTx`，conditional update
      检查 changes。
- [ ] T3.6 `setIntentSessionStatus` 改 fresh single transaction，检查 exact owner/inFlight/
      `assertNoUnsettledApply`；same status idempotent。
- [ ] T3.7 apply claim原子写 journal current-owner run-as。final transaction按 journal重读 current
      active user/role并重绑 prepared principals；复验 `status==='active'`，session update做
      active/currentDraft/context conditional CAS并检查 changes。
- [ ] T3.8 server-only manifest detail增 `ownerUserId/visibility/aclRevision/builtin`
      authorization fence；`authorizeIntentBundleInTx` 对每个 modify target重跑 current
      owner/builtin copy-only分类与 content/ACL fence，并用 final actor复验完整 bundle refs/humans。
      authority、六类写、provenance、journal committed与 session CAS同 transaction；失败只
      CAS compensating并保存 typed root error，不静默 modify→copy或直接 terminal failed。
- [ ] T3.9 新增 v3 artifact receipt/revision：npm/git Plugin由 apply caller预生成 generation id，
      owner/strict parse/normalize/HMAC后先查 ledger；existing exact不读 current capability，直接沿
      anchor返回。只有 absent才做 source-kind/platform validation与 zero-write probe；Darwin/静态
      unavailable在 ledger/journal/id/leaf前返回 definitive pre-accept 422，零 anchor/后台排队。
      probe返回不可序列化 `ArtifactAdmissionLeaseV1`，claim transaction二次查 ledger并验证
      boot/provider/op-kind/expiry。前端**收到** definitive 422才销毁 frozen attempt/id；response
      loss保持 outcome-unknown并重放 frozen id/body，capability后来恢复时允许该 id被第一次
      accepted。accepted后 capability翻 red只按 anchored journal收敛，exact replay不返回422。
      admitted operation才先追加
      `writer.phase='reserved'` receipt再进入 exported caller-id installer；file:零 host-owned
      artifact。Skill caller预生成 skill/op id，并在一个 transaction内追加 receipt + invisible
      reserving row + reserve lock；`skillOperations.beginOperation`提供 caller-id入口，
      materialize不得另 mint。receipt只存 canonical ids与版本化 writer identity，禁止 absolute
      path；每次 append/phase更新均以 artifact revision CAS。
- [ ] T3.10 新增 `ArtifactFsCapabilityV3`与可产出的
      `ArtifactDir/ArtifactWritableTemp/ArtifactSealedFile/ArtifactEntry/ArtifactTreeWriter/
ArtifactSealedTreeCapabilityV3`：file API固定
      `createTemp/writeTemp/sealTemp/commitFile*`，tree API
      固定 `createTree/mkdir/writeFile/seal/commitTree*`；replace统一返回角色固定的
      `{published,displaced}`。tree writer只接受自身 staging-dir capability；operation/slot closed
      allowlist禁止跨 canonical target。publication前由 broker-owned、非 restore 的
      `ArtifactPublicationLedgerV3`记录 operation/slot role/staged/expected，exchange后记录
      published/displaced；crash只 exact resume，file/tree displaced absent且 receipt
      cleanup-verified前不得 complete。
      closed operation/slot另明确
      `restore-database-file|restore-live-database-wal-removal|
restore-live-database-shm-removal|restore-safety-database-file|restore-safety-database-wal|
restore-safety-database-shm|restore-safety-config-file|restore-safety-skills-root|
restore-config-file|restore-skills-root|pending-restore-archive|backup-staging-tree|
backup-archive`；safety与 live publication/removal slot不得混用，config regular file不能交给
      tree writer，backup不能借 Skill/restore identity。
      daemon持有 app-home root dirfd；Linux traversal加
      `RESOLVE_NO_XDEV`并逐段核对 dev/fsid，temp用 `O_TMPFILE`写完后才 `linkat/renameat2`；
      macOS用 `O_RESOLVE_BENEATH/O_NOFOLLOW_ANY/O_UNIQUE` +
      `AT_UNIQUE/RENAME_RESOLVE_BENEATH`，private named staging每次 write前后核对 exact
      nlink=1。sealed directory publication用 Linux `RENAME_NOREPLACE|EXCHANGE`、Darwin
      `RENAME_EXCL|SWAP`；Skill producer改接 `ArtifactTreeWriterV3`，Plugin/Skill
      install/version/publish/import/ZIP/fusion/recovery/cleanup/GC/doctor纳入 inventory/source
      guard；canonical root API不得接裸 path/raw fd/callback。hardlink temp、mount crossing与最后
      fstat→syscall replacement只能零外部写或 fail closed。
- [ ] T3.11 verified broker executable必须先于 root authority：Linux embedded helper bytes写
      sealed memfd并从 verified fd `execveat`；Darwin child只拿无 authority socket，parent用 audit
      token + pinned designated requirement/CDHash验证 actual running image后才经 `SCM_RIGHTS`给
      root dirfd。unsigned/wrong build/open→spawn swap全部 capability unavailable；test build用专门
      signing identity，不得关闭验证。
- [ ] T3.12 新增 verified-self `OwnedArtifactContainmentV3`：daemon/supervisor在 control
      authority前 no-dump/no-core，supervisor清 env/argv/fds、锁+DONTDUMP memory后自生成一次性
      Ed25519 keypair；private key不导出/落盘/进入 descendant。READY携 public key/key id，host
      验证 nonce/start/PID namespace后以 artifact revision CAS持久 exact release record/public
      key/digest，成功才 GO。当前 only-admitted provider为 Linux private PID + mount namespace
      anchor；child
      filesystem sandbox只允许 opened generation leaf内写，authority parent与 leaf外 host路径
      不可写。normal/EOF/timeout/cancel/watchdog/restart都收口包含
      `setsid + double-fork + closed-pipe`的 namespace process set；只有绑定 release digest/
      artifact revision/namespace/direct leader/zero process事实且由 supervisor私钥签名的
      `ArtifactContainmentEmptyProofV3`可写 quiesced。verified broker另维护不随 DB restore的
      `ArtifactWriterObligationLedgerV3`；release先 fsync obligation，再 CAS DB，二者 exact匹配才
      GO。新 daemon用 obligation+journal共同的 public key验签；
      signature/replay/identity ambiguity进 compensating/repair-required。Linux exact
      qualification另用无 app-state authority的 same-UID sibling证明 ptrace/process_vm_readv、
      `/proc/*/{mem,fd}`、control injection失败。Darwin npm/git Plugin与 Linux capability unavailable
      均在 journal/leaf/GO前 typed fail closed，绝不回退 PGID、child-list轮询、Seatbelt或
      unsandboxed prefix；managed Skill/file: control paths仍可用。既有 RFC-224 API/测试语义保持。
- [ ] T3.13 新增 `ArtifactRestoreCapabilityV3`、`PendingRestoreStageCapabilityV3`与统一
      `executeRestoreGenerationV3`：cold CLI和 pending startup取得 singleton lock后、
      DB/config/restore前先启动 verified broker；pending DB swap前先核对 non-restored
      publication receipts并把 external released obligations全部 quiesce，swap后与 restored
      business rows、Skill/Plugin refs合并 cleanup/repair。restore operation保存
      `restoreOperationId + archive/db/config-or-null/tree digests + canonical
noMigrate/noSafetyBackup/skipIntegrityCheck + optionsDigest`，并以 versioned/domain-separated
      canonical digest绑定每个 publication ref。archive DB/WAL/SHM先 exact-copy到 broker-private
      generation，打开私有副本 checkpoint/consolidate后才可写 `staging` marker；live
      DB/WAL/SHM/config/Skills在 destructive effect前逐项记录
      `absent|present(identity,digest)`。safety严格分
      `captured|skipped-by-operator`，后者只对应 `noSafetyBackup=true`且仍保留 live observation。
      新第16个 `restore-sqlite-publication` root先 durable declared，再逐
      wal-removing/unlink/parent-fsync/wal-settled、shm同序、sidecars-settled、db-publishing/
      db-published收敛；DB publish不能早于 sidecar settled。DB/Skills live absent走 no-replace、
      displaced=null、cleanup not-applicable，present走 exact replace/removed；empty incoming
      Skills仍是 sealed真实空 tree。config保持 preserve/no-replace/replace。migration记录
      `applied|skipped-no-migrate|not-required`并与 options/schema delta绑定。七态 marker由
      同目录 normative executable appendix里的14个 strict phase schema、7个 encoder与完整
      refiner实现；cold/pending在任何 DB open前按 root-specific locator加载 marker/SQLite/
      publication receipt并核 full operation。Linux `RENAME_EXCHANGE`、Darwin `RENAME_SWAP`分别由
      file/tree primitive执行；crash只 exact resume/roll-forward/repair。archive
      必须先经 `PendingRestoreIngressCapabilityV3` seal成
      `ReadOnlyBackupCapabilityV3`；补齐 `RestoreExecutionOptionsV3/
RestoreSafetyGenerationV3Decoded/RestoreSqlitePublicationV3Decoded/
RestoreGenerationMarkerV3Decoded` phase types。HTTP改 strict raw-stream PUT，
      route在读 body前做 actor/id replay gate，broker writer逐 chunk backpressure、hard cap、
      digest、file+parent fsync与 disconnect/partial cleanup；live/stopped CLI fd、pending marker、
      dry-run同样不接 raw path/fd。新增 `RestoreInspectionServiceV3`：default plan与
      `--dry-run`只消费 sealed capability并返回 `RestorePlanDtoV3`，不写 pending/control/
      publication/locator；embedded current migration axis直接从 sealed build journal读取，禁止
      inspection调用写 runtime目录的 `extractMigrationsTo()`。streaming extractor拒绝 absolute/`..`/symlink/
      hardlink/device/FIFO/duplicate/case-fold collision/超限 entry并只经 tree writer写 staging；
      live daemon下 HTTP直接调用 ingress/stage service，CLI通过 peer-credential+boot-nonce local
      control socket发送 strict `inspect-backup | stage | lookup | cancel` frame；inspect/stage以
      `SCM_RIGHTS`各传一个 archive fd，lookup/cancel零 fd，stopped CLI持 lock启动同一 broker。
      stage/status/mutation lookup/cancel使用 shared exact id/revision strict receipt；Settings在
      effect前持久化不含 path/name/archive内容的 actor-bound locator，CLI在 effect前 fsync+打印
      mutation id并提供 replay/status；broker-owned non-restored
      `PendingRestoreControlLedgerV3`以 stable caller scope/id/request digest在 effect前 fsync。
      cancel先 durable `canceling` record，再 exact删除 archive/marker，最后 terminal receipt；
      boot在控制面前用 publication identities收敛，status null/restart后 same id仍 exact replay。
      v1无 GC。Settings只枚举 current actor prefix，foreign actor locator忽略保留；原 actor回来
      继续 lookup，只有 terminal current key或显式带恢复能力丢失警告的 clear才删除。startup另以
      独立 `legacy-unverifiable` adoption phases处理真实
      `restore-pending.json/staged.tar.gz`与 failed quarantine：strict旧 marker但忽略
      `stagedTarball` path，先分 active-pair/marker-only/archive-only/empty-active/
      failed-quarantine evidence。
      active-pair因与 released post-swap failure/catch-before-quarantine物理不可区分，先 durable
      `operator-confirmation-required`并在 DB open前以 `legacy-active-pair-ambiguous`停止；stopped
      CLI提供 `--legacy-status/--legacy-inspect/--legacy-reapply/--legacy-quarantine`，只可按 exact
      adoption id/evidence digest inspect，再以新 mutation显式 reapply或 quarantine；reapply先
      claim operator ledger，随后 checkpoint V3 private stage；hold/quarantine rename前先以
      `LegacyPendingMovePublicationV3` durable保存 action/source、exact parents、opaque target
      slot与 target-absent proof，再走 moving/rename/双 parent fsync/moved。reapply继续 V3
      marker与 generation并在 terminal后先 durable cleaning revision、exact remove、post-cleanup
      source/target absent observation与 target-parent re-fsync，再写 cleaned；restart按
      declared/moving/moved/cleaning/cleaned分 phase truth table收敛，只有 cleaning的 exact neither
      可 roll forward，quarantine保留 moved target。
      response loss沿 operator/move/adoption/V3 receipts收敛。marker-only只按已消费 exact cleanup，
      archive-only只 durable quarantine；failed/invalid/ambiguous转 typed repair，绝不合成原
      caller receipt。
      restore/pendingRestore/upload/Skill migration/recovery无裸 `rm/cp/rename`例外，
      old/displaced file/tree仅在 identity/obligation barrier后按 entry kind做 V3 cleanup。
- [ ] T3.13a 新增独立 `ArtifactBackupCapabilityV3`：closed operation仅
      `backup-export|backup-retention|backup-legacy-adoption`，slot仅
      `backup-staging-tree|backup-archive|backup-archive-adoption`。manual/API/
      scheduled/auto/pre-migration/pre-restore共用 export service；config/skills/worktrees只从
      canonical
      read capabilities进入 closed logical names，workflow YAML/manifest受 byte/count上限。
      healthy DB由 branded SQLite online-backup/serialize adapter写 broker sink且看不到 path；
      corrupt/pre-migration DB/WAL/SHM只做 exact read-capability copy。packer sandbox只见 sealed
      staging与单 output temp。可选 worktree按 DB snapshot的完整 ordered `task_repos[]` mint task
      source，broker逐 repo排除 `.git`并写 v2 layout；任一 repo
      missing/race/unsafe/over-cap时 exact清全部 private partial并 task级 skip。new closed
      `worktree-reconstruction` operation绑定 task/repo/branch/base/repo-admin/target fences与 locks；
      从 canonical worktrees root + task id + ordered descriptors mint
      task-container/repo-target reservations。每个缺失 root/namespace/container/target先 durable
      声明 parent/leaf/private slot，在 broker-private namespace创建/fsync并记录 identity，再写
      `publishing`，以 Linux `renameat2(RENAME_NOREPLACE)`/Darwin
      `renameatx_np(RENAME_EXCL)` same-inode发布 canonical slot、fsync parent并写 receipt；whole
      multi parent缺失不走 generic mkdir。Git adapter只消费 terminal exact empty reservation，
      qualification不支持 existing empty target或 no-replace directory publication时在任何
      declaration/directory effect前 typed unavailable。adapter记录
      registration/branch与 bounded repo-admin inventory before。unique-stale先以
      cleanup attempt及唯一 expected-target admin entry parent/leaf/identity写入
      `stale-removing`，再以独立 durable effect推进为 `stale-removed`与 effective absent；Git
      remove effect前 cancel/明确未开始且 original inventory未变则写
      `stale-retained + effect:none,before-git`并清 target skip；
      already-absent/stale-removed到 add intent之间的 cancel/baseline未变 typed failure也先写无
      add intent的 effective-absent before-git no-effect/compensating receipt，再清 target
      terminal；任何 snapshot drift仍 repair。Git
      syscall前保存 addAttempt/target-empty/effective-baseline/admin inventory及经 Git-version
      qualification可预声明的 exact admin-slot absent intent；全部 repo的 naming/inventory cap在
      directory declaration前资格化，无法唯一预声明或 inventory超 cap时零 effect typed skip。
      response loss或非零返回后严格发现
      `not-started|partial|registered|ambiguous`。branch-only、registration-only、
      expected-target partial admin directory/target delta先持久化再逐项逆序补偿；建立 exact target后
      先持久化 target/registration/branch/admin after，再 overlay sealed tree并验证 `.git`
      back-reference/branch/status；non-restored
      reconstruction ledger以 per-repo discriminated entry在每个 Git side effect前 fsync，DB
      open后与 restored repo rows合并。add-before-result/result-before-ledger fsync只做唯一 exact
      discovery或 repair；partial add按 durable receipt逆序补偿，仅删除 operation-created
      identity匹配的 target与空 task parent，并 exact清未发布 private slot；preexisting parent永不
      删。declared后零目录 effect用双 absent/parent proof写 `closed-absent`；container reservation
      尚未形成时逐层引用
      closed-absent/removed/existing-retained/created-infrastructure-retained仍可 terminal
      compensated；最后一类只允许同 reconstruction创建、identity仍匹配且按策略保留的
      root/namespace。
      `discoverInterruptedAdd=not-started`的明确 Git失败写 `effect:none`与 before/no-effect proof，
      但只比较 stale cleanup后的 effective absent baseline，Git非零不得直接冒充 no-effect；
      `partial|registered`保存真实 delta与 cleanup checkpoints。single-existing container在
      preflight `target-present` skip，只有
      operation-created published container可别名 target。每个 cleanup在 effect前写 `removing`、
      proven absent后写 `removed`，repo/top-level compensated receipt引用 exact cleanup
      record。v1 payload
      只允许 single-repo，multi-repo typed skip；archive path/meta字段无 authority。publication
      ledger先于 no-replace archive publish。旧 archive先由 descriptor-rooted adoption验证
      regular/nlink/digest/strict manifest/kind并写独立 durable receipt，再进入
      `published|legacy-adopted` inventory；scheduled/auto继续 count/days/size轮转，manual/pre-\*/
      last-good保护，malformed/ambiguous只 repair不删。retention用 discriminated receipt exact
      remove，禁止删 active/protected/last-good。source guard覆盖 backup/raw snapshot/scheduler/
      worktree/archive/Git adapter，不保留 raw-path fallback。
- [ ] T3.14 新增 compensation coordinator与 strict cleanup：short-tx claim + daemon live owner，
      boot barrier在 HTTP/Plugin GC/worker前把旧 daemon遗留 prepared/applying以 exact CAS转
      `compensating + intent-apply-daemon-restart`并重领 lost claim；periodic同样只收连续 grace
      scans无 apply/compensation live owner的 exact row，两个 live registry都不按墙钟误杀。按
      receipt逆序，Plugin先要求 reserved-without-GO或带 valid empty proof的 writer quiesced，再
      以 filesystem capability只删 exact generation；
      Skill只删 exact reserving identity。cleanup错误保持 compensating并重试；全部 writer
      quiesced/receipt absent才 CAS failed。v1 Plugin、v2/unknown codec、损坏/path identity进
      repair-required，只可由保守 GC/doctor零残留 proof收口。新 failed同 transaction写
      `artifactCleanupVerifiedAt`。
- [ ] T3.15 backend tests：foreign/manager/admin auditor对正确/错误 source-aware answers/
      approvals同形404且零 source read/ledger/turn；owner missing/corrupt/cross-session/advanced/
      archived replay。另覆盖 late source、同名多 owner、approval ACL/name TOCTOU、multi decision
      rollback、reject-only/one-bump/replay；create/manual另覆盖 archive-before-tx、grant revoke、
      visibility change、delete、response loss；prepared↔archive/reopen/final-tx、Workflow/
      Workgroup owner transfer、builtin flip、user/role/reference ACL变化全交错，锁零 DB side
      effect、先 compensating后 exact failed replay。artifact部分另用 fake npm
      `setsid + double-fork + closed-pipe` delayed writer在
      READY/persist/GO/install/direct-exit/EMPTY/manifest各断点真杀 daemon；Linux PID namespace与
      Ed25519 signature证明restart/timeout/cancel后 empty，terminal后目录不复活；wrong key/signature/
      old release replay、same-UID ptrace/mem/fd/control attack不得误杀或 terminal。Darwin npm/git
      preflight断言零 ledger/journal/leaf/child、strict 422/零排队；response已知时销毁 id，
      response丢失+fixture翻绿时旧 frozen id可首次 accepted且总 effect一次；另覆盖 green
      accepted→response loss→capability red→exact replay仍返回原 anchor。mounted file handle
      control成功；raw path/cross-session handle/source fence drift在 open前拒绝。Plugin/Skill在
      anonymous/named temp hardlink、mount crossing、最后
      fstat→mkdir/open/write/link/rename/unlink syscall窗口替换 parent/leaf，lifecycle自身植入
      sentinel symlink再写；两平台 host writer inventory与 Linux child sandbox都断言 sentinel零
      bytes。helper swap在 root fd前拒绝；capability unavailable断言 GO、npm、producer全为零。
      Skill sealed tree在 prepared/exchange/receipt/displaced-cleanup每点真 crash，tree writer
      拒绝 canonical dir、operation/slot mismatch零写；non-restored publication ledger在业务 DB
      回滚后仍保留 displaced authority并与 current inventory合并。cold/pending restore在 marker
      每 phase真实 crash并 exact resume；incoming/live config present/absent矩阵保持 regular file，
      file↔dir与 file/tree publication crash矩阵 fail closed；backup B→released delayed
      writer→kill→restore B组合证明
      non-restored obligation仍可验签/cleanup且 HTTP/GC不早开。HTTP raw-stream ingress覆盖
      content-length有/无、64GiB archive/256GiB expanded/1,000,000 entry边界、chunk
      backpressure/disconnect、digest mismatch、seal/fsync与每点真 crash；live/stopped CLI fd、
      pending marker/dry-run只产出 read-only capability并共享同 limits。daemon live/stopped的
      default plan/`--dry-run`逐字段同一 `RestorePlanDtoV3`；inspect peer/nonce/fd/digest/frame/
      response-loss/kill均 exact cleanup且 control/publication/locator/DB/FS零写；embedded
      inspection spy锁 `extractMigrationsTo()`零调用。
      live CLI/HTTP stage覆盖 peer/nonce/fd digest、并发 cancel/response loss/daemon race；
      无 body lookup可直接找 terminal，但同 id重复 PUT/CLI换 archive必须验完整 digest后 conflict；
      Settings safe locator覆盖 A response-loss→B reload/restart→A：B不查不删A，A exact
      reconcile；explicit clear确认且 storage无 path/name/archive内容。CLI id在 effect前
      fsync+打印并可 replay/status；cancel ledger
      prepare/delete archive/delete marker/terminal各断点真 crash，marker absent+restart exact replay、
      caller/body mismatch及 later-stage identity不误删。旧 binary真实 active-pair/marker-only/
      archive-only/empty-active/quarantine rename-before-error/error-written fixture，另在 DB swap后、
      config、skills、migration、worktree及 catch→rename逐点 kill；新 binary在 adoption
      discovered/classified/operator-claimed/v3-staged/legacy-moving/legacy-held/
      v3-marker-published/quarantining/settled/cleanup每 phase crash后 exact resume；hold/quarantine
      move另在 declared/moving/rename/双 parent fsync/moved/cleaning/remove/
      post-cleanup observation/target-parent re-fsync/cleaned逐点 kill并验证 rename phase的
      source-only/target-only exact收敛、cleaning exact neither roll forward、moved neither/
      source reappear/both/replacement repair。逐字段替换 move nested id/parent/slot/role/fence/
      fsync/removed identity均须在 descriptor open前 fail。所有 active-pair都先
      DB-open fail closed，
      stopped CLI exact inspect后显式
      reapply/quarantine；marker-only只 consumed、archive-only只 quarantine，failed/invalid/
      identity replacement typed repair且无 caller receipt。manual/scheduled/auto/pre-migration/
      pre-restore/healthy/corrupt backup验证 closed operation/slot、SQLite sink、packer isolation、
      publication crash与 retention保护；升级前 scheduled/auto/manual/pre-\* archives在
      scan/digest/manifest/adoption receipt各点 crash可重试，count/days/size与保护策略不退化，
      symlink/hardlink/partial/corrupt/unknown manifest零删除。worktree single/multi-repo从
      ordered `task_repos[]`捕获，任一 repo missing/race/symlink/mount/over-cap时 task级 skip且
      无半个 payload；真实 Git root/namespace/task-container/target在 declaration/private mkdir/
      identity checkpoint/publishing/no-replace rename/parent fsync/publication receipt，以及后续
      registration preparation/stale-removing/stale-removed/adding/add result/effect-ledger
      fsync/overlay/postcondition/compensation各断点，
      覆盖 declaration后 ENOSPC/EIO/cancel双 absent `closed-absent`、reservation未形成的 terminal
      compensated、Git非零且真实 `not-started`的 `effect:none`、single-existing target typed
      skip、operation-created shared root/namespace的 `created-infrastructure-retained`，
      unique-stale cleanup intent前后/response-loss、already-absent/stale-removed到 add intent前
      cancel/baseline未变 typed failure及 snapshot drift、branch-only/registration-only/
      expected-target partial admin-dir/target delta、stale remove effect前 cancel/明确未开始的
      `before-git` skip与 cleanup
      first-fail/second-success，
      以及 whole parent absent、parent-only、partial child、private-only/canonical-only/both、
      add-before-result、result-before-ledger fsync、target/registration/branch replacement与 multi
      第 N repo失败；existing/foreign parent/target零误删，operation-created empty task parent与
      未发布 private slot exact收口。逐字段替换 directory absent/removed publication、
      stale cleanup intent/registration preparation/before-git baseline/add intent/effect nested
      id/parent/slot/role/fence/identity，以及 foreign addIntent presence必须 safeParse fail，v1
      single恢复/v1 multi typed skip；archive path/meta不能改变
      repo/target/branch/argv。恶意
      archive entry矩阵零 staging外写，source guard无裸 root/pending/backup writer。Skill另覆盖
      reserve→materialize/version；
      cleanup first-fail-second-success、同 plugin多 generation/current ref、长期 node run、
      mounted file源、claim loss、boot早于HTTP/GC、v1与
      unknown codec repair-required/GC proof均须 deterministic打红旧设计。

依赖：T1；T3.7–T3.14 与 T4.1–T4.5 同批协调，不允许独立 landing 留半条 authority或假
terminal。

### T4 Apply journal 可观测性

- [ ] T4.1 commit strict parse后只调用唯一 normalizer：拒绝 duplicate
      `opId/(opId,slotId)`，按 `opId/slotId`排序且 value逐字保留；HMAC、ledger writer与
      `resolveIntentBundle`消费同一 branded object。exact replay在 current capability前沿 journal
      anchor返回，changed draft/decision/secret在 freshness/capability前 conflict；absent new
      claim才消费 admission lease并原子写 ledger+journal、递增 session `applyAttemptSeq`，同时写
      exact current-owner run-as。
- [ ] T4.2 root failure先写 typed `errorCode` 与 allowlisted/sanitized detail并转
      compensating；cleanup status单独写 allowlisted `recoveryCode`。只有 coordinator可写
      terminal failed，不靠 error string regex恢复前端 gate。
- [ ] T4.3 detail commits显式 `.orderBy(attemptSeq)` 并投影安全 identity/timestamps；route以
      response schema parse输出。
- [ ] T4.4 apply service通过 callback在 durable
      prepared/applying/compensating/repair-required/failed/committed每次 transition发
      `intent.apply.updated`；committed仍刷新六类资源 list。
- [ ] T4.5 frontend WS rules为所有 apply update invalidate list/detail；detail在任一
      prepared/applying/compensating或local locator unknown时 1.5s poll；repair-required改
      30s低频 reconcile，failed/committed停止。
- [ ] T4.6 tests：same id changed draft/applyMode/slot/human/waiver/secret、duplicate/reversed
      decisions与 duplicate/reordered secret/human/waiver、cross-endpoint pair；断言纯换序使用
      同 normalized bytes，changed value conflict。同毫秒、墙钟回拨、乱序 row、多个 session并发
      attemptSeq；六态 frame、断线 reopen reconcile、DTO exact
      draft/client association；null/unknown apply run-as不可 resume，typed principal/foreign
      failure exact replay不重新 prestage；任何 compensating/repair-required均继续阻断
      archive/session write/new apply；v3 failed缺 cleanup timestamp fail closed，v1 failed显示
      legacy cleanup unverified；accepted response loss后翻红 capability仍 exact replay原
      prepared/compensating/failed/committed anchor。

依赖：T1；T4.1–T4.5 与 T3.7–T3.14 同批。

### T5 Frontend runtime contracts 与纯 view-model

- [ ] T5.1 新增 `lib/intent-api.ts`：list/detail/create/action都从 `unknown` 经 shared schema
      safeParse；contract error不含 raw payload。
- [ ] T5.1a context-aware capabilities resolve endpoint同样从 `unknown` strict parse；新增纯
      `projectIntentComposerCapabilities`，unknown platform/reason/shape对受影响项 fail closed，
      不让 URL/entry hint绕过 disabled。pre-create DTO只接受 opaque grant/display/expiry；
      session model DTO的 `file.concreteSources`只接 parsed
      handle/display/binding digest，unknown/duplicate/cross-session source fail closed，两者不可
      相互代用。
- [ ] T5.2 `normalizeIntentArtifactHint/buildIntentCreatePayload` 接 clientMutationId、typed modify
      target、可选 pre-session grant、message max与 canonical frozen wire payload；modify在
      capability resolve前冻结 id，grant/body同 attempt重试。仅用于前端 frozen retry，不能取代
      server `normalizeIntentMutationV1`。
- [ ] T5.3 `deriveIntentJourneyState` 只消费 parsed DTO；commit按 attemptSeq、current failure按
      draftId，不再有 awaiting-start/createdAt heuristic；compensating/repair-required优先于
      current draft error并保持 Apply current/blocked。
- [ ] T5.4 `projectIntentTimeline` 使用 top-level mutation/source identity与 preceding questions；
      unknown content不 raw JSON、不产生 controls。
- [ ] T5.4a 新增`loadIntentTurnSession`，从unknown strict parse现有
      `SessionViewResponseSchema`；抽`SessionConversationPanel`接query key/loader/poll而不接
      task/Intent id。新增per-turn disclosure reducer：最新running仅首次默认展开，手动折叠不被
      refetch覆盖，terminal停止poll，duplicate/out-of-order WS eventSeq只幂等invalidate。
- [ ] T5.5 抽 generation receipt reducer、source-bound decision reducer与 OCC/effect
      reconciliation；明确哪些可 exact replay、哪些只能描述目标状态。
- [ ] T5.6 抽 `buildCommitSteps/buildIntentCommitRequest`、`PinnedIntentDraft` 与 exact journal
      recovery；safe locator类型在编译期不允许 decisions/slots。
- [ ] T5.7 表驱动 tests：outer DTO fail closed、invalid attempt order/六态、跨轮 source、相同
      文本两 tab、mount target marker、pinned draft与 locator不含 secret；repair-required不能
      开新 attempt；另锁 Linux/Darwin capability matrix、Auto、disabled roving selection与
      pre-accept known-422/outcome-unknown reducer语义，以及 accepted locator在 capability red后仍
      进入 durable reconcile而不销毁 id；generic Darwin与exact modify grant、grant error/
      re-resolve、accepted replay不被 expiry/drift覆盖。另锁execution outer/nested DTO
      malformed局部失败、default-open/manual-close/new-turn状态机与WS/poll query lifecycle。
- [ ] T5.8 重构 Settings restore client：共享 strict raw-stream stage/status/mutation lookup/cancel
      wrapper与 `RestoreControlLocatorV1` reducer；stage/cancel fetch前写 actor-namespaced safe
      localStorage locator，terminal strict receipt后删除，reload/outcome-unknown先 lookup。
      actor变化只忽略/隐藏 foreign prefix，不查、不覆盖、不删除；原 actor回来继续 reconcile。
      显式 clear exact locator前确认“会失去响应丢失后的本机找回能力”，服务端仍 owner gate；
      incomplete upload提示用同 id重新选 archive，
      locator用 strict非敏感 options重建相同 query；repair summary只显示 closed code/operator
      action，不显示 raw dir/error。删除 multipart
      `FormData`、empty-body DELETE与 `{cleared:boolean}` optimistic path；storage/URL/log negative
      tests断言无 filename/path/archive bytes/digest。

依赖：T1–T4 的最终 response contracts。

### T6 创建 Composer 与最近会话

- [ ] T6.1 新增 discriminated `IntentCreateComposer`，inline/dialog共用 form、payload builder、
      create attempt reducer与唯一 submit路径；modify在 resolve capability前冻结
      `clientMutationId`，valid grant随 frozen payload提交。
- [ ] T6.2 三条双语 blank-only示例；点击填入/聚焦但不提交。
- [ ] T6.3 Auto + 六类接 `ChoiceCards/ResourceIcon`；新增 intent icon并替换 sidebar借用图标。
      ChoiceCards做 backward-compatible disabled option/`aria-describedby`；Darwin Plugin保持可见
      但 generic create不可选并显示明确 host reason；只有 exact actor-safe file Plugin modify
      resolve出 pre-session grant时启用该 source-bound copy上下文。Auto不能绕过受信 model
      capability。
- [ ] T6.4 modify context以 strict type/id + frozen attempt id调用 side-effect-free resolve，
      投影 actor-safe name/owner/grant expiry；不可读/contract error禁用 create，不显示 query raw
      id或 grant内部 fence。
- [ ] T6.5 `/intent` 改 inline Composer + responsive session link cards；公共 `Card`最小增
      `params`，删除重复 CTA/table navigation。
- [ ] T6.6 search为快捷 Dialog open authority；close/success replace清 ephemeral query，
      back/forward与focus fallback完整。
- [ ] T6.7 create pending锁控件/dismiss；transport loss只 replay同 frozen body/id，
      fingerprint mismatch返回 definitive `intent-mutation-id-reused`；accepted response loss后
      grant过期/源漂移仍重放原 attempt并导航原 session，不能预先 re-resolve覆盖 body。
- [ ] T6.8 Composer/list/modify/capability outer DTO、键盘、390px overflow与 response-loss DOM
      tests；unsupported URL/entry hint聚焦原因且零 create request。

依赖：T1.1a/T1.11、T2.2/T2.8a、T3.4、T5.1–T5.2。对应首轮 P2-3：不能只依赖 payload helper。

### T7 Journey、Conversation 与挂载交互

- [ ] T7.1 新增非交互 `IntentJourneyProgress` 与 `.intent-session__workspace`，桌面
      0.9fr/1.1fr、≤1080px单列、唯一主滚动。
- [ ] T7.2 统一 `canMutate/canStartSessionWrite/canAdvanceIntent`，消费 inFlight turn与 ordered
      unsettled journals；prepared/applying/compensating/repair-required全部锁写，
      archived/admin audit每类 mutation均负向锁。
- [ ] T7.3 新增语义 timeline；七 turn kind可读投影、answers不 JSON、running/launch error/
      cancel/retry位于上下文中。
- [ ] T7.3a 新增`IntentTurnSession` disclosure并复用
      `SessionConversationPanel → ConversationFlow/SubagentBlock`；最新running默认展开、
      terminal/history折叠，summary显示live/complete/truncated/incomplete与event count，局部
      loading/error不替换turn业务内容。Task`SessionTab`只换共享panel，attempt picker/
      injected memories/runtime inventory原结构不变；Intent不渲染这些task-only概念。
- [ ] T7.4 pending questions接原生 radio/checkbox；state/body携 source/expected seq/id；
      exact receipt后清，source conflict丢旧 state。
- [ ] T7.5 `IntentMountApprovalCard` 接 atomic decisions；HTTP/detail receipt都先 strict parse并
      逐项匹配 frozen identity/decision，只有 `resultingTurnSeq`可成为 answers expected seq；
      malformed/mismatch/identity-field injection零 answers POST。transport loss exact batch
      replay，第一步成功后只 replay answers；approval commit后 response-loss/restart从 detail
      receipt恢复时 answers仍只提交一次。
- [ ] T7.6 mounted context以 name/type/full owner为主、handle次级；display null安全 fallback，
      long owner不 ellipsis。
- [ ] T7.7 **修改** `IntentMountDialog`：单项 picker、parent-owned submit、
      `canSubmit/disabledReason`；打开后 generation/apply gate变化锁定，无内部多 POST loop。
- [ ] T7.8 continue message用 generation receipt；manual mount/rebase/cancel用 exact OCC/turn
      fence，不把相同文本、任意 revision bump或新 agent turn冒充本 attempt。
- [ ] T7.9 conversation/DOM/backend-integration tests覆盖 late source、atomic approval、
      manual mount response loss、cross-tab gate、malformed content与 audit/archived；另覆盖
      parent/reasoning/tool/nested subagent统一DOM、展开状态、capture chips、局部contract error、
      audit只读、390px nested/tool overflow及task Session regression snapshot。

依赖：T2、T3.1–T3.4、T4.5、T5.3–T5.5。对应首轮 P2-3：source/marker helper不可缺席。

### T8 Review workspace 与 secret-safe Commit Dialog

- [ ] T8.1 新增 `IntentReviewWorkspace`；outer detail + changeset safeParse后才建 op view；
      validation/stale/parse/no-draft均有同屏 disabled reason。
- [ ] T8.2 op cards继续复用 `IntentOpPreview`富预览；action bar在summary后，desktop-only sticky，
      mobile normal flow。
- [ ] T8.3 commit history按 attemptSeq，显示 draft identity/errorCode/receipt；exact
      clientMutationId只在 technical details。compensating显示撤销中，repair-required只显示
      allowlisted recoveryCode/管理员提示，不暴露 path/generation id；v1 failed显示 legacy
      cleanup unverified，只有 v3 failed + verified timestamp显示补偿已收口。
- [ ] T8.4 点击 Review时由 route建立 `PinnedIntentDraft`；Dialog不接 live draft props。
      D1→D2 identity变化立即 lock、erase、close并要求复核。
- [ ] T8.5 Stepper按 strategy?→inputs?→review；slot按 op分组，secret/waiver gate，
      secret不进入 review。
- [ ] T8.6 commit feature hook用 reducer + private `requestRef` + direct `api.post`；禁止把
      `CommitIntent`作为 TanStack mutation variables。
- [ ] T8.7 sessionStorage只存 safe locator；exact journal六态/无 row/draft changed/detail
      unreachable恢复。repair-required擦除 secret request/ref但保留 locator和写锁；terminal/
      unmount/discard/draft change集中 erase。
- [ ] T8.8 详情接 `UnsavedChangesGuard`；共享 guard只做 backward-compatible可选文案。
      editing discard、submitting/outcome unknown Back/forward/beforeunload/force leave合同完整。
- [ ] T8.9 tests直接检查 MutationCache/QueryCache/storage/URL/log/error；使用 sentinel secret
      与 D1/D2相同 slot id；覆盖 close/ESC、Back、refresh、locator recovery和 exact replay。

依赖：T3.6–T3.14、T4、T5.1/T5.6、T7 skeleton。对应首轮 P2-3：
failure-code/journal/compensation contracts必须先落，不能只依赖 commit builder。

### T9 样式、i18n、真实浏览器与 E2E

- [ ] T9.1 新增 `.intent-*` token化样式；create Dialog scoped近全高、Commit Stepper body单滚动、
      safe-area/focus-visible/reduced-motion；dynamic viewport缩高时 header/footer不 shrink、只允许
      声明 body滚动，coarse pointer targets至少44×44px。
- [ ] T9.2 中英文 key同批对称；删旧 key前全仓查引用。
- [ ] T9.3 扩真实 intent stub：必须读取 `INTENT.md`的 contract version、requested hint与 host
      capability并按六类 strict-valid examples分支；另含 runtime prelaunch failure、single/multi
      questions、mount requests、mounted file handle（并拒绝 raw path）、第二 draft与 delayed
      apply；normalized stream fixture同时产parent reasoning/tool/error与child subagent event，
      可控capture failure/byte cap。
- [ ] T9.4 E2E：inline create→draft→commit/provenance、resource modify actor-safe context、
      source approval→answers、response loss exact receipt；至少一条 create→periodic
      dispatcher→draft使用真实 active非-system、非 admin session并在 wake 后丢弃 route actor，
      带 private grant/foreign-private canary并断言 disclosure admission已持久，不能只用
      daemon/admin token。另覆盖 accepted commit response丢失后 host capability翻红仍从 exact
      journal reconcile，以及 mounted file Plugin copy只使用 handle、route/model/payload均无 raw
      path；Darwin resource shortcut先 resolve pre-session grant、create transaction换 session
      handle，accepted create response loss后 expiry/drift仍 exact replay。delayed generation期间
      断言最新Intent turn自动展开统一session flow、WS更新，断WS后poll继续；terminal/reload保持
      event顺序，第二turn让旧turn默认折叠；capture failure/truncation不阻断Review/commit，并与
      task node Session同一renderer DOM作对照。
- [ ] T9.5 双 page/tab：D1 wizard后 D2到达；另一 tab prepared apply立刻锁本 tab，
      compensating/repair-required继续锁且有诚实文案，failed/committed终态恢复；
      archive/apply服务端交错由 backend suite证明。
- [ ] T9.6 manual mount archive/ACL gate transition；commit sentinel secret的
      Back/refresh/force leave与 locator recovery；instrumentation证明 cache/storage/log/ledger
      无 raw secret或普通 hash。
- [ ] T9.7 1280×800 light/dark、390×844 light/dark，以及 390×568 `hasTouch:true` light/dark；
      create/commit Dialog打开聚焦后从844动态 resize到568模拟软键盘。双栏/单栏、长 Owner、复杂
      preview、展开的nested turn session、唯一 scroll owner、focused field/CTA hit-test、44px
      target、footer/safe-area/无 horizontal overflow。
- [ ] T9.8 keyboard、touch tap、axe critical/serious=0、reduced-motion；与
      agents/workflows/workgroups及task Session
      side-by-side视觉核对并记录截图。
- [ ] T9.9 platform artifact gate：macOS真实跑 signed broker的 actual-process identity、
      named-temp hardlink/mount/last-check→syscall/symlink sentinel、sealed Skill tree
      publish/exchange、config regular-file + whole-tree restore crash矩阵，并证明 npm/git Intent在
      generic Composer/model前置 disabled、exact file-Plugin modify grant可达且 preflight零越权；
      HTTP raw-stream与 live daemon/stopped daemon CLI各跑 stage，chunk cap/backpressure/
      disconnect/seal-fsync、peer/boot/fd-digest篡改；另跑 daemon-live/stopped default plan与
      `--dry-run` strict相等及 inspect零 side effect。Settings跑A→B→A reload/restart safe locator、
      explicit clear warning，CLI replay/status、cancel response-loss+restart exact replay均 fail
      closed；用上一版 binary落真实 active-pair/marker-only/archive-only/empty-active/quarantine
      rename/error evidence，并在 DB swap/config/skills/migration/worktree/catch-before-rename真实
      kill；新 binary必须把所有 active-pair同形投影为 operator-confirmation-required，再跑 stopped
      CLI inspect/reapply/quarantine response-loss/restart与 move-publication每个 crash window。
      五类 backup继续跑 adoption/crash/
      retention。两平台跑
      manual/scheduled/auto/pre-migration/pre-restore backup
      export、SQLite/corrupt copy、packer isolation、publication crash、legacy adoption与
      retention保护，并跑 single/multi-repo root/namespace/task/target directory publication +
      per-repo registration/overlay/compensation（declaration/private mkdir/publishing/
      no-replace rename/receipt、whole parent absent、add-before-result、effect-ledger fsync crash、
      identity replacement、closed-absent、no-Git-effect、single-existing alias skip、
      created-infrastructure-retained、unique-stale baseline cleanup、branch/registration/admin/
      target partial delta）；legacy hold另覆盖 remove后与 parent re-fsync后 kill的
      `cleaning + neither → cleaned`。两类 recovery codec跑 nested foreign-value mutation matrix，
      证明 parse failure早于 filesystem/DB side effect；identity codec另跑 zero/uint64 max/
      大于 JS safe integer、`+1|01|-1|overflow`与 decoded→wire→decoded round trip，并把 live bigint
      observation差异注入每类 nested recovery row；durable root registry再逐 root、逐
      identity-bearing union branch注入超 JS-safe bigint，跑 decoded root→explicit encoder→strict
      wire→JSON bytes→decoded root exact round trip，并以 typecheck锁 root input/output equality、
      registry key/kind与 `never`穷举。legacy `moving` fsync→rename前、worktree
      `declared` fsync→private mkdir前真 kill可 exact resume且 effect至多一次；source guard拒绝
      decoded root stringify、bigint replacer、`toJSON`、spread/cast与 partial mapper。restore
      marker七态逐态超 JS-safe bigint round trip与 swapped identity/ref/config/options负例；
      normative appendix以 strict tsc/runtime运行14 schemas、7 encoders、两套 refiners与真实
      WAL-only/stale-WAL fixture；cold/pending各真实 kill safety fsync、WAL/SHM remove
      intent/unlink/parent-fsync、DB publication syscall/receipt及
      `db-swapped→config/skills exchange`窗口。registry每个 root由进程 A落盘 frame、进程 B只从
      raw bytes + expected codec load；wrong kind、digest flip、outer/inner非 canonical bytes、
      duplicate key、BOM/trailing、foreign payload、invalid UTF-8/oversize全拒绝，source guard确认
      无 public raw lookup/rebrand或 loader-bypass decode；
      hosted Linux integration真实跑 private PID+mount namespace的
      `setsid + double-fork + delayed-write` normal/timeout/cancel/daemon-restart、Ed25519
      signature、same-UID process probe、O_TMPFILE/mount/restore/helper-swap矩阵；另跑
      pre-restore external obligation→delayed EMPTY→DB swap→exact cleanup，以及 mounted `file:`
      handle/source-fence、raw-path canary矩阵。两平台 single-binary smoke核对 embedded helper
      digest/signing/version；不得用 mock结果代替。

依赖：T6–T8；先构建最新 e2e binary。

### T10 门禁、评审与文档收口

- [ ] T10.1 shared/backend/frontend定向 suites + Intent E2E。
- [ ] T10.2 `bun run --filter @agent-workflow/backend db:check` 与 migration fixture。
- [ ] T10.3 `bun run typecheck && bun run lint && bun run test &&
bun run format:check && bun run depcheck`。
- [ ] T10.4 production + e2e binary build/version smoke。
- [ ] T10.5 Codex 实现门；全部 P0/P1/P2裁决并复审到通过。
- [ ] T10.6 对照 proposal AC-1..73及 D29–D73，更新本 plan交付记录、
      `design/plan.md` 与 `STATE.md`。
- [ ] T10.7 仅在用户明确授权后精确路径 commit/push，并按 exact SHA核验 CI。

依赖：T1–T9。

## 2. 依赖图

```text
T1 ledger + shared + migration
├─ T2 generation dispatcher/OCC ─┐
├─ T3 source/manual/status ──────┤
└─ T4 apply observability ───────┼─ T5 frontend contracts
                                 ├─ T6 create/list ───────┐
                                 ├─ T7 conversation ─────┼─ T9 UX/E2E ─ T10 gates
                                 └─ T8 review/commit ─────┘
```

交叉约束：

- T3.7–T3.14（含 T3.13a）final current-owner/target authority、V3
  descriptor/temp/restore ingress/backup/adoption/worktree Git capability、
  verified broker、Ed25519 kernel process-set quiescence与 exact artifact compensation必须与
  T4.1–T4.5同一 backend
  batch，不能留下“可观察但仍能穿
  archive/owner transfer”或“cleanup未证明却 terminal failed”的中间状态。
- T1 ledger/HMAC 必须先于 T2/T3 receipt writers与 T4 commit claim；三处不得保留平行的
  idempotency authority。
- T1 unique normalizer 必须先于所有 executor；HMAC、ledger scope、turn/session/journal writer、
  mount handle allocator与 apply resolver不得各自重建 body。property/source guard与实现同批
  landing。
- T2 dispatcher 与 maintenance 同批落地；不能先改 reservation 后仍由 route fire，制造第二轮
  P1-2 的中间状态。
- T2 run-as migration、principal hydration、claim/maintenance与 two-phase disclosure
  admission必须同批；不允许出现 nullable principal可运行、普通 owner回退 system、claim后仍
  消费 route actor或未 admission seed进入模型的中间状态。
- T1 shared model contract/hint/capability schema必须先于 T2 model seed与 T5/T6 ChoiceCards；
  prompt、backend与frontend不得复制六类 allowlist或 platform矩阵。
- Composer capability resolve、pre-session grant签发、create transaction换 session handle与
  model capability必须同批；不能先让 UI启用 Darwin modify、却让 create还只能接受 session
  handle。
- restore shared wire、backend ingress/control ledger、Settings safe locator与 CLI pre-effect
  locator必须同批；local-control inspect/stage/lookup/cancel union与 inspection service也同批。
  不能先删旧 HTTP path却没有 caller replay，不能先保留 locator却让 server返回弱 boolean，也
  不能让 daemon-live dry-run回退 raw path。legacy evidence codec与 worktree reservation/per-repo
  ledger必须和各自 startup recovery barrier同批；active-pair operator receipt与 directory
  private→canonical publication state不能后补；legacy move pre-effect target publication与
  worktree closed-absent/no-Git-effect terminal也必须同批，否则会重新留下自动重放、无凭据
  rename或不可构造的 optional-recovery终态。
- T6 必须同时依赖 T2 create receipt、T3 actor-safe target、T5 runtime parse。
- T7 必须同时依赖 T2 generation receipt + generic session sink/read endpoint、T3 atomic source
  contracts、T4 cross-tab invalidation与T5.4a shared session panel/disclosure reducer。
- T8 必须同时依赖 T3 status/final authority/artifact recovery、T4 exact六态 journal、T5
  pinned/locator helpers、T7 detail skeleton。
- 共享工作树不并行编辑 `intentSessions.ts`、`intent.detail.tsx` 或 i18n 值块。

## 3. 实施批次

这是一个 same-binary 协调发布单元，包含一条 forward migration；不是纯前端发布：

1. **Batch 1 — durable contracts**：T1。
2. **Batch 2 — backend correctness**：T2–T4；shared/backend tests全绿后才接 UI。
3. **Batch 3 — frontend runtime + create/list**：T5–T6。
4. **Batch 4 — session workspace + commit**：T7–T8。
5. **Batch 5 — visual/e2e/gates**：T9–T10。

批次是验证边界，不授权提前 commit/push；整个 RFC 默认一个 publication scope。migration、
backend 与 embedded frontend必须同一 binary交付，不支持 RFC-235 frontend连接旧 daemon。

## 4. 必跑验证

```bash
bun run --filter @agent-workflow/backend db:check
bun run --filter @agent-workflow/shared test
bun run test:backend
bun run test:frontend
bun run typecheck
bun run lint
bun run test
bun run format:check
bun run depcheck
bun run build:binary
bun run build:binary:e2e
bun x tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --types bun design/RFC-235-intent-builder-ux/restore-generation-v3.normative.ts
bun design/RFC-235-intent-builder-ux/restore-generation-v3.normative.ts
bunx playwright test e2e/intent-builder.spec.ts --project=chromium
```

说明：

- 根 `bun test` 不能代替 frontend Vitest；使用 repo scripts。
- backend suites 必须显式跑 unified-ledger endpoint pairs、owner-before-source、daemon-alive
  handoff、disclosure snapshot/admission、normalizer duplicate/permutation/property、
  artifact hint→trusted INTENT.md、six-type model contract parse/resolve/canonical golden、
  current-owner principal/foreign-private canary、migration next-claim、manual ACL/archive、
  apply current-owner/target authority interleaving、v3 artifact revision/record-before-act、
  approval strict receipt/combined response-loss、accepted replay before capability与
  `ArtifactAdmissionLeaseV1` claim race、known/unknown pre-accept response、
  Linux PID namespace + Ed25519/same-UID process proof、Darwin generic Composer/model前置
  rejection与exact modify pre-session grant、
  V3 anonymous/named temp + sealed file/tree exchange + no-XDEV + verified helper +
  config regular-file/whole-tree restore、external writer obligation跨 DB swap、HTTP/CLI/pending
  sealed ingress、live/stopped daemon strict inspection + pending stage control、
  actor-namespaced locator A→B→A retention/durable cancel ledger、真实 active-pair/marker-only/
  archive-only/empty-active/failed-quarantine evidence adoption、released post-swap kill →
  operator-confirmed reapply/quarantine、backup export/SQLite sink/packer/legacy archive
  adoption/retention authority、ordered `task_repos[]` Git worktree root/namespace/task/target
  private→canonical reservation publication、closed-absent/no-Git-effect terminal与 per-repo
  effect-ledger reconstruction、legacy move publication、mounted file exact
  handle/source fence、child sandbox zero-write、真实 crash与 strict compensation retry/legacy
  repair。
- `e2e/` 不在 workspace typecheck，修改 testid/文案/wire 后单独 lint/run。
- CSS 视觉证据来自最新 binary；Linux visual baseline只取 CI artifact。

## 5. 验收清单

- [ ] AC-1..7：创建入口、Dialog、最近会话。
- [ ] AC-8..13：journey、conversation、source-bound questions/approvals、strict approval
      receipt/combined response-loss、durable generation。
- [ ] AC-14..17：ordered apply、pinned commit、secret/navigation lifecycle。
- [ ] AC-18..21：i18n、a11y、390×568 touch/soft-keyboard resize、outer DTO parse、actor-safe
      mount identity。
- [ ] AC-22：create/manual mount transaction freshness。
- [ ] AC-23：archive/apply final fence。
- [ ] AC-24：shared/backend/frontend/browser/binary/实现门。
- [ ] AC-25：durable current-owner run-as、principal terminal与禁止普通 owner system fallback。
- [ ] AC-26：single normalized execution object、duplicate/order规则与 fingerprint/executor性质。
- [ ] AC-27：apply journal run-as、final current-user/target copy-only/ACL/reference authority与
      失败先进入 compensating。
- [ ] AC-28：完整 disclosure snapshot/token、final admission digest/CAS与明确线性化语义。
- [ ] AC-29：immutable owner scope先于 private source hydration，同形404与 owner exact replay。
- [ ] AC-30：v3 exact artifact receipt/revision、caller-owned generation/reserve id、
      persist-before-GO containment identity/public key、Linux PID namespace + Ed25519 process-set
      empty proof/same-UID control probe、Darwin npm/git pre-act capability rejection、
      `ArtifactFsCapabilityV3` dir/temp/entry authority、O_TMPFILE/private staging/no-XDEV、
      verified helper、`ArtifactRestoreCapabilityV3`、Linux exact-leaf child sandbox、
      last-check→syscall zero-write containment、strict cleanup、
      compensating/repair-required诚实投影与 cleanup成功后才 terminal failed。
- [ ] AC-31：shared model contract六类 strict parse/resolve/canonical golden、Plugin/Workflow字段
      对齐、immutable hint从 create/session进入 trusted INTENT.md，stub真实读 model input。
- [ ] AC-32：strict host capability在 Composer/model前置；Darwin generic Plugin disabled、
      D42 exact file-Plugin modify除外，Linux六类 admitted path、Review drift defense；schema
      parity不冒充 platform apply parity。
- [ ] AC-33：cold/pending restore generation、safety snapshot、DB/FS swap、migration/identity
      barrier与 phase crash recovery全走 V3 broker；known 422销毁 id、unknown rejection允许原 id
      首次 accepted且 accepted effect至多一次。
- [ ] AC-34：existing exact accepted commit replay先于 current capability；absent probe与
      `ArtifactAdmissionLeaseV1`二次 claim验证关闭 probe→claim race。
- [ ] AC-35：Skill/file/tree sealed publication统一返回 published/displaced authority，
      record-before-exchange、crash exact resume与 displaced cleanup门禁完整。
- [ ] AC-36：非 restore `ArtifactWriterObligationLedgerV3`在 DB swap前后保持 released writer
      public key/identity，writer quiescence、合并与 cleanup/repair完成前不开 HTTP/GC/workers。
- [ ] AC-37：live/stopped daemon pending stage只经 `PendingRestoreStageCapabilityV3`与 exact local
      admin control protocol，archive fd/digest/options和 stage receipt均绑定。
- [ ] AC-38：mounted `file:`只经 opaque session handle与 server-only source fence进入模型/
      resolver；raw path/spec不可注入，read-only source不被删除或改写。
- [ ] AC-39：restore保持 `config.json` regular-file ABI；explicit preserve/replace、
      sealed-file `commitFile*` publication与 sealed Skill tree publication分型，
      present/absent/file-dir/crash矩阵 exact恢复。
- [ ] AC-40：`ArtifactBackupCapabilityV3`给 manual/scheduled/auto/pre-migration/pre-restore/
      healthy/corrupt模式闭集 operation/slot；SQLite sink、sealed staging/packer、publication ledger
      与独立 retention authority全链无裸 path。
- [ ] AC-41：`PendingRestoreControlLedgerV3`在 stage/cancel effect前持久化 stable caller/id/request
      identity；cancel删除与 terminal receipt各 crash phase可恢复，status null/restart仍 exact
      replay；v1无 GC且 later stage不误删。
- [ ] AC-42：pre-create与session capability DTO分离；Darwin exact file-Plugin modify由绑定 actor/
      target/fence/attempt的 opaque grant在 create transaction换成 session handle，invalid new
      request零状态，accepted replay不被 grant expiry/source drift覆盖。
- [ ] AC-43：HTTP raw stream、live/stopped CLI fd、pending marker与 dry-run都只经 bounded ingress
      seal成 `ReadOnlyBackupCapabilityV3`；size/backpressure/digest/fsync/crash cleanup与完整 phase
      types可执行，无 multipart/raw path/fd fallback。
- [ ] AC-44：stage/status/mutation lookup/cancel与 local-control wire strict；Settings owner-bound
      safe locator、CLI pre-effect持久化/打印/replay使 reload/response loss/restart可找回 exact
      receipt；foreign actor locator只忽略保留，原 actor回来继续 reconcile，显式 clear有能力丢失
      警告；旧 empty-body DELETE/boolean contract删除。
- [ ] AC-45：upgrade前 pending marker/failed quarantine只经 canonical descriptor和
      `legacy-unverifiable` evidence adoption/typed repair；active-pair只进入 operator gate、
      marker-only只 consumed、archive-only只 quarantine、failed/invalid零未证明 live mutation，
      不信 `stagedTarball`/旧 absolute path、不伪造 caller receipt。
- [ ] AC-46：旧 backup用独立 durable adoption receipt进入统一 retention inventory；scheduled/
      auto count/days/size继续，manual/pre-\*/last-good保护，malformed/ambiguous零删除，adoption不
      冒充 publication。
- [ ] AC-47：worktree v2 capture/reconstruction以完整 ordered `task_repos[]`为 task级合同；真实
      root/namespace/task/target publication reservation + Git registration + overlay + postcondition与
      partial compensation完整，whole parent absent可 mint，v1 single兼容/v1 multi typed skip，
      archive path/meta零 authority。
- [ ] AC-48：daemon live/stopped default plan与 `--dry-run`同一 `RestorePlanDtoV3`；live只经
      authenticated `inspect-backup` delegated fd，所有错误/响应丢失 exact cleanup且
      control/pending/publication/locator/业务状态零写；embedded sealed migration axis不落 runtime
      文件。
- [ ] AC-49：Settings actor locator A→B→A与 reload/restart保持可恢复；B不查不删A，A exact
      reconcile，terminal只删 current exact key，显式 clear确认且不改变 server ledger/授权。
- [ ] AC-50：released `restore-pending.json` strict codec与 active-pair/marker-only/archive-only/
      empty-active/failed-quarantine evidence、mkdir/copy/cleanup/rename/error-write crash矩阵完整；record只含实际
      identities，active-pair不自动 stage/apply，replacement只 repair。
- [ ] AC-51：worktree canonical root/task-container/repo-target closed reservations在 Git前
      走 durable declaration + broker-private identity + no-replace canonical publication；whole
      parent absent、parent-only、partial child可 exact resume，补偿只删 operation-created
      identity匹配空 entry，preexisting零误删。
- [ ] AC-52：worktree per-repo ledger保存 reservation、descriptor/task/repo fences、
      registration/target identity与 branch/ref before-after；add-before-result、result-before-fsync、
      identity replacement及 partial multi只 exact resume/compensate或 repair；全 cleanup后是
      terminal typed compensated skip，不是假 reconstructed，无平行数组。
- [ ] AC-53：合法 legacy pending与 released post-swap/catch-before-quarantine同形 active-pair均在
      DB open前产生同一 typed operator gate，零自动 apply；stopped CLI exact inspect后的
      reapply/quarantine具 caller-scoped durable claim与 handoff phase、exact replay/conflict/
      identity-drift repair。
- [ ] AC-54：root/namespace/task-container/single target/multi child每个 directory publication在
      canonical effect前已有 durable intent；declaration/private mkdir/identity/publishing/
      no-replace rename/parent fsync/receipt/removing/removed逐点 kill可 exact
      before/after/repair；declared+neither可重做，prepared/publishing+neither、both或 replacement
      只 repair，private orphan与 canonical operation-created entry均可按 identity补偿并持久化
      cleanup receipt。
- [ ] AC-55：legacy reapply hold与operator quarantine在 rename前均有 durable move publication，
      绑定 action/source/exact parents/opaque target slot/target-absent proof；rename与双 parent
      fsync后只凭 same-inode target收敛。source-only/target-only exact before/after，
      rename phases的 both/neither/replacement只 repair；settled receipt持续引用同一
      publication，hold cleaning/cleaned按 phase truth table可重放。
- [ ] AC-56：worktree declaration后零 effect可 terminal `closed-absent`且不伪造 removed identity；
      container reservation尚未形成也能逐层 compensated。Git明确 `not-started`时
      `effect:none`保存 before/no-effect proof并完成 target cleanup，top-level可真实返回
      `git-registration-failed`；single-existing container在 preflight `target-present` skip，
      不成为 operation-created alias。
- [ ] AC-57：reapply hold在 `cleaning` exact remove后或 target-parent fsync后 kill，restart以
      moved identity、purpose/revision分型的 post-cleanup source/target absence evidence与 parent
      re-fsync补写 `cleaned`；`moved + neither`、source reappear、both/replacement仍 repair。
- [ ] AC-58：worktree operation-created shared root/namespace可用 strict
      `created-infrastructure-retained` terminal；unique-stale cleanup独立持久化并把 effective
      baseline推进 absent，且 exact stale admin-entry removal intent先于 effect；若 remove
      effect前 cancel/明确未开始则以 stale-retained + before-git no-effect清 target并 skip，
      already-absent/stale-removed到 add intent之间取消或 baseline未变的 typed failure则以
      no-add-intent effective-absent before-git receipt清 target并 terminal，snapshot drift仍
      repair；Git branch-only/registration-only/operation-owned
      partial admin/target delta均有 `partial` effect与可重试逆序 compensation，
      foreign/ambiguous零误删。
- [ ] AC-59：legacy move、worktree directory、registration preparation、Git effect及顶层 receipt
      schemas全部 `.strict()`并使用 canonical identity comparator/完整 nested `superRefine`；
      foreign id/parent/slot/role/fence/fsync/removed identity、stale cleanup entry/digest与
      before-git baseline/preparation/addIntent矛盾在 descriptor open、discover、remove、checkpoint
      及 DB open前 safeParse失败。
- [ ] AC-60：`IntentMountApprovalReceiptSchema` output以编译期断言锁为原 receipt且合法
      approve/reject逐字段不变；identity字段注入、missing/extra/order/outer-turn mismatch零 answers
      POST。独立 `ArtifactEntryIdentityV3WireSchema`只接受 canonical uint64 dev/ino和 safe numeric
      companions，唯一 decoded schema输出真实 bigint、唯一 encoder提供 canonical round trip；
      response-loss/restart从 detail receipt恢复且 answers只提交一次。
- [ ] AC-61：所有 durable artifact root均有 registry-owned strict wire/decoded schema pair、
      compile-time input/output equality与唯一顶层 encoder；每个 union branch以 `never` guard穷举，
      nested identity只调用 leaf encoder，storage只接 root-kind branded canonical bytes。使用超
      JS-safe bigint逐 root/branch跑 encode→JSON→decode exact round trip；legacy moving-before-rename
      与 worktree declared-before-mkdir kill可恢复且 effect至多一次。decoded direct stringify、
      bigint replacer、`toJSON`、spread/cast、partial mapper及 missing/extra/swapped identity在任何
      effect前失败。
- [ ] AC-62：restore generation marker作为 registry第 15个 root，七态拥有 exact strict
      wire/decoded branch与逐字段 encoder；operation/digest/config disposition/staged/safety/
      published/displaced identity、publication/migration/barrier/cleanup proof全部 cross-field
      绑定。每态以超 JS-safe bigint round trip；cold/pending分别在 safety→DB与 DB→FS窗口真 kill，
      restart exact resume且 exchange至多一次。
- [ ] AC-63：registry每个 root跨进程 disk frame round trip只走
      `loadCanonicalDurableRootV3(expectedCodec, rawFrame)`，返回对象通过 runtime
      membership/kind检查；wrong kind、digest flip、outer/inner非 canonical bytes、duplicate
      key、BOM/trailing、valid foreign payload、invalid UTF-8/oversize全在 decode/effect前拒绝。
      source guard证明无 public raw lookup/rebrand/cast或 loader-bypass decoder。
- [ ] AC-64：真实 SQLite fixture覆盖 incoming WAL-only committed rows、live stale WAL/SHM与
      safety trio；private consolidation不丢行。safety fsync、WAL/SHM remove intent/unlink/
      parent-fsync、DB publish syscall/receipt各点 cold/pending真 kill，最终 DB exact incoming、
      safety仍可恢复且 stale sidecar零重放。
- [ ] AC-65：`restore-generation-v3.normative.ts`以 repo Zod 3.25.76 strict typecheck与 runtime
      exit 0；14个 phase schema、7个 explicit encoder、两套 full refiner与 codec equality真实存在。
      每 phase extra/null/identity/ref/revision负例均早于 effect。
- [ ] AC-66：root-specific storage key只由 private factory产生且 runtime membership有效；
      publication ref locator对 wrong namespace/kind/segment、same-kind foreign receipt、
      wrong id/revision/role/full operation/digest与 collision effect前失败，digest golden固定。
- [ ] AC-67：三个 canonical restore options及 digest贯穿 pending/in-flight/legacy/operation/
      marker/SQLite root；changed replay conflict。`fs-swapped`后 kill时 migration
      applied恰一次、skipped-no-migrate/not-required零次；no-safety分支不伪造 backup且 exact
      roll-forward。
- [ ] AC-68：live DB present/absent × Skills present/absent与 config preserve/no-replace/replace
      矩阵、clean app-home cold/pending E2E全绿；各 publication/cleanup crash点无 placeholder、假
      displaced identity或 foreign delete，empty incoming Skills为 sealed真实空 tree。
- [ ] AC-69：artifact/SQLite immutable revision-addressed frames与 previous digest lineage完整；
      marker旧 anchor在每个 inner checkpoint→outer marker窗口真 kill后可找到唯一 latest
      descendant，gap/fork/overwrite/foreign root effect前 repair。
- [ ] AC-70：safety/barrier/cleanup purpose-specific verifier逐字段绑定
      phase/mode/staged digest及expected/published/displaced identity；prepared/alternate/
      same-id-cross-role/foreign semantic receipt负例全拒。
- [ ] AC-71：artifact每 phase与SQLite每 prefix的repair都保留完整 forensic state并由transition
      validator锁 lineage；drop/null/rewrite ref/identity/sidecar intent/cleanup evidence或从repair
      继续推进均fail closed。
- [ ] AC-72：legacy adoption从operator-confirmation开始及全部reapply request/receipt/control/
      operation持有逐字段相同 options authority；restart exact replay，missing/changed/defaulted/
      digest mismatch在archive/DB effect前拒绝。
- [ ] AC-73：Intent agent turn的parent/reasoning/tool/subagent过程经独立有界durable events与同一
      `parseSessionTree/SessionViewResponse/ConversationFlow`呈现；owner/audit/foreign gate、
      live WS+poll、refresh/order/dedupe、complete/truncated/incomplete、task Session regression、
      keyboard/a11y/390px及业务结果不受capture失败影响全部通过。
- [ ] migration + shared/backend/WS/API diff与 RFC 文档一致；不存在“零 backend”残留断言。
- [ ] RFC-234 ACL、OCC、secret、all-or-nothing与既有 testid回归仍绿。
- [ ] 用户明确批准 RFC 后才开始生产代码；用户明确授权后才 commit/push。

## 6. 风险登记

| 风险                                      | 防线                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| migration 回填后 session counter仍为 0    | journal稳定编号后同步 per-session MAX；fixture实际 next claim=max+1                                           |
| 旧 mutation 无 body可重建                 | legacy-unverifiable anchor/ambiguous tombstone；POST fail closed、detail只读 reconcile                        |
| reserved turn 在 route→runner handoff失主 | route-independent dispatcher + claim/live registry + periodic daemon-alive reconcile                          |
| dispatcher 丢 route actor后身份漂移       | durable owner/policy + claim/current-user hydrate；普通 owner零 system fallback                               |
| 撤权后 cached dump进入模型                | frozen full visible-set tokens + final admission digest/CAS；失败先丢 seed                                    |
| 合法长 generation 被 orphan sweep误杀     | live registry优先；只有无 owner exact row过 grace才收口，runtime timeout另管                                  |
| source-aware error泄露 foreign turn       | wire-only parse后 immutable owner 404 gate；scoped source loader与同形负测                                    |
| mutation id 跨 endpoint/表复用            | owner-scoped统一 ledger + endpoint/scope/HMAC + structured conflict                                           |
| fingerprint body 与 executor raw body分叉 | 唯一 branded normalizer同时供 HMAC/writer/resolver；raw wire source guard                                     |
| duplicate/换序导致 last-wins差异          | duplicate先拒绝；有序/集合逐 endpoint固定，commit sort后执行同一 normalized object                            |
| commit secret产生可枚举 hash              | 现有 host secret.key domain-separated HMAC；不持久 raw/普通 hash                                              |
| EMPTY proof共享 key可读/重启不可验        | supervisor no-dump后自生成 Ed25519；private不导出，journal public key验签；signature replay锁                 |
| stale answer/approval穿过新轮次           | sourceTurnId + expectedTurnSeq + fresh transaction validation                                                 |
| approval部分成功/丢响应后误发 answers     | whole-batch tx + strict HTTP/detail receipt + resultingTurnSeq；逐项 exact replay                             |
| archived/撤权穿过 manual mount            | same-tx owner/active/context/inFlight/apply + create/add canViewResourceInTx                                  |
| owner transfer穿过 apply                  | journal current-owner run-as + final copy-only/auth/content fence + final actor rebinding                     |
| archive穿过 apply                         | status tx `assertNoUnsettledApply` + final active CAS                                                         |
| final authority失败留下外部 artifacts     | v3 receipt/revision先记后写 + strict reverse cleanup；成功前保持 compensating                                 |
| lifecycle `setsid`逃逸后继续写            | Linux PID namespace+Ed25519 empty；Darwin receipt/FS前 capability reject                                      |
| same-UID process读取 signer/control       | daemon/supervisor no-dump/no-core + locked memory/anonymous fd + qualification；host compromise显式边界       |
| named temp hardlink后写出受控根           | Linux O_TMPFILE；Darwin broker-private unique staging + per-write nlink check                                 |
| mount crossing/last-check→path syscall    | V3 root-dirfd + NO_XDEV/dev+fsid + descriptor syscall；child exact-leaf sandbox                               |
| restore whole Skill tree绕过 capability   | startup-before-DB restore authority + phase marker + descriptor root swap/source guard                        |
| restore把 regular config误当目录          | `configDisposition` + sealed-file commit；Skill才用 sealed tree                                               |
| backup source guard后没有合法 writer      | 独立 backup-export/retention operation + staging/archive slot + SQLite sink/packer sandbox                    |
| embedded helper open→exec被替换           | Linux sealed memfd execveat；Darwin actual-process code identity先于 root fd                                  |
| cleanup失败或 daemon中途退出              | durable compensation claim/live owner + boot barrier/periodic重领；first-fail-second-success                  |
| legacy plugin artifact没有 generation id  | repair-required；禁止按 pluginId猜删，等安全 GC/doctor零残留 proof                                            |
| cross-tab apply state不可见               | 每次 transition/terminal WS + reconnect reconcile + state-aware unsettled poll                                |
| apply history误关联                       | attemptSeq order + draftId/hash/clientMutationId，不用 createdAt                                              |
| D1 secret提交 D2                          | parent pinned snapshot + live identity erase/close + server current draft fence                               |
| secret进 MutationCache/storage/log        | direct submit/private ref + safe locator type + sentinel negative tests                                       |
| navigation丢 exact request                | shared guard + beforeunload + locator-first +明确 force-leave恢复                                             |
| manual mount批量部分成功                  | Dialog限单项 + parent gate + exact revision                                                                   |
| 同名资源误认                              | actor-safe name/type/full owner；server exact id/name/ACL fence                                               |
| malformed outer DTO放宽控件               | shared response safeParse fail closed，零 raw payload                                                         |
| artifact hint UI有值、模型看不到          | immutable session hint + trusted INTENT.md + six-type stub/golden                                             |
| prompt字段与 strict schema漂移            | versioned shared model contract + parse/resolve/canonical six-type gate                                       |
| Darwin Plugin走到 Review才死路            | strict host DTO在 Composer/model前置 disabled；Review只做 drift defense                                       |
| 零状态422却承诺旧 id永久拒绝              | known 422客户端丢 id；unknown replay可首次接受，ledger从 accepted claim起 at-most-once                        |
| accepted replay被当前 capability错误拒绝  | normalized/HMAC后先查 ledger；existing exact直接沿 anchor返回，absent才验证 lease                             |
| Skill目录发布缺 exact exchange authority  | sealed tree + published/displaced双 capability + publication receipt；cleanup前不 terminal                    |
| restore换 DB 后丢 released writer公钥     | broker-owned non-restored obligation ledger；swap前 quiesce、swap后与 restored refs合并                       |
| live daemon持锁时 CLI stage绕过 broker    | daemon-owned stage service + peer/boot绑定 admin socket + SCM_RIGHTS archive fd                               |
| cancel effect后响应丢失无法重放           | non-restored pending control ledger先记后删；boot exact收敛；v1无 GC                                          |
| `file:`布尔能力允许模型换任意 path        | DTO枚举 concrete source handles；mounted-file union拒绝 spec，final按 server fence重验                        |
| Darwin modify需先有 session handle        | context-aware pre-session grant绑定 frozen create id；transaction重验后换 session handle                      |
| HTTP upload无 capability入口              | raw-stream bounded broker sink → fsync/seal `ReadOnlyBackupCapabilityV3`；route零 temp path/fd                |
| ledger有 receipt但 caller丢 mutation id   | Settings actor-bound safe locator + CLI pre-effect fsync/print/replay；server scope仍最终授权                 |
| upgrade旧 pending无法安全判 phase         | active-pair operator-confirmation-required；stopped CLI exact inspect + 新 mutation reapply/quarantine        |
| 旧 archive掉出 retention                  | 独立 legacy adoption receipt + discriminated inventory；manifest kind分类与 exact identity remove             |
| worktree只解包成普通目录                  | ordered task_repos task-level operation + Git registration adapter + overlay/postcondition/compensation       |
| daemon-live dry-run没有合法 authority     | strict inspect-backup local-control + delegated fd + shared inspection service；零 control/publication写      |
| actor切换自动删 locator                   | actor prefix只忽略保留；原 actor exact reconcile；显式 clear警告恢复能力丢失                                  |
| legacy marker/layout被假想 schema误读     | 锁 released restore-pending.json字段 + active-pair五态 evidence + post-swap/catch kill矩阵                    |
| active-pair被误判 clean pending           | 物理同形一律 DB-open前 operator gate；不自动发布 V3，exact decision receipt后才 reapply/quarantine            |
| legacy rename后未记目标                   | move publication先记 opaque target/absent proof；source/target闭集 discovery + same-inode receipt             |
| hold remove后合法 neither被判 repair      | phase-sensitive discovery + post-cleanup purpose/revision proof + target-parent re-fsync                      |
| multi task parent不存在无法创建           | root→namespace→container→target private preparation + no-replace publication                                  |
| canonical mkdir先于 reservation receipt   | durable declaration/private identity/publishing；private/canonical exact discovery + kill tests               |
| 零目录/Git effect无法 terminal            | `closed-absent` + `effect:none`；reservation-null逐层 cleanup；single-existing typed skip                     |
| shared infrastructure保留无终态           | root/namespace-only `created-infrastructure-retained` + same reconstruction/identity/policy proof             |
| stale/partial Git delta卡住补偿           | exact stale intent + terminal preparation no-effect + bounded inventory + none/partial/registered逆序 cleanup |
| nested typed row可携 foreign identity     | `.strict()` schemas + canonical identity comparator + exhaustive superRefine/negative mutation matrix         |
| Git add后 receipt缺 target/ref证据        | per-repo discriminated effect ledger；target/registration/branch before-after + exact discovery/CAS           |
| marker旧ref被inner checkpoint变 foreign   | immutable revision-addressed frame + previous digest lineage；旧anchor验真后找唯一latest descendant           |
| 同role receipt冒充真实publication语义     | safety/barrier/cleanup purpose projection逐字段绑定phase/mode/digest/identities                               |
| repair nullable字段丢既有恢复证据         | phase-discriminated lossless forensic union + previous→repair transition validator                            |
| legacy reapply重启后猜当前options         | operator确认起完整options authority贯穿request/receipt/control/operation                                      |
| Intent执行事件拖垮DB/页面                 | per-turn 10k rows/8MiB双cap + lazy expanded fetch + locator-only WS；truncated诚实显示                        |
| session capture失败误判意图任务失败       | captureState独立于business outcome；post-run capture before cleanup，typed incomplete局部呈现                 |
| 复用Session时搬入task-only概念            | 只抽SessionConversationPanel/ConversationFlow；attempt/memory/inventory仍由SessionTab拥有                     |
| mobile modal/双栏溢出                     | single-scroll + 1080/720断点 + 390×844及390×568 touch/dynamic-resize browser gate                             |

## 7. 设计门与交付记录

- 本地 preflight：
  [design-preflight-2026-07-28.md](./design-preflight-2026-07-28.md)，已被正式门禁补充/纠正。
- Codex 设计门首轮：
  [codex-design-gate-2026-07-29.md](./codex-design-gate-2026-07-29.md)，
  `NEEDS_REVISION — P0=0, P1=8, P2=3`；11项已折入 v2。
- Codex 设计门第二轮：隔离 snapshot
  `f7a87466c9d1d4226da32ec5149580d086065415`，
  `NEEDS_REVISION — P0=0, P1=4, P2=0`；统一 ledger、dispatcher ownership、migration
  counter与 manual in-tx gate 已折入 v3。
- Codex 设计门第三轮：隔离 snapshot
  `31eb1473de61b125f65c4ace7d15f3fdd8d626aa`，
  `NEEDS_REVISION — P0=0, P1=2, P2=0`；current-owner execution actor与
  fingerprint/executor single-normal-form已逐条复证并折入 v4。
- Codex 设计门第四轮：隔离 snapshot
  `3ec8c246772d898b12f69aa44a8cec7aa93910c8`，
  `NEEDS_REVISION — P0=1, P1=2, P2=0`；apply owner-transfer final-authority、
  dump disclosure admission与 source owner-before-hydration已逐条复证并折入 v5。
- Codex 设计门第五轮：隔离 snapshot
  `cadf74aa7c20a47ef8d8d522cda8f675ce9adb39`，
  `NEEDS_REVISION — P0=0, P1=1, P2=0`；第四轮三项均 Closed，新 finding为 Plugin/Skill
  artifact缺 exact durable identity、cleanup失败仍可假 terminal。v6 exact receipts、caller-owned
  generation/reserve id、compensation coordinator、strict cleanup与 repair-required已折入
  v6。
- Codex 设计门第六轮：隔离 snapshot
  `a3c72b914b70a6b0253af37a2e765126b7307065`，
  `NEEDS_REVISION — P0=0, P1=2, P2=0`；v5 identity/cleanup子项部分 Closed，新增两条残余
  必要条件：安装 writer进程树静默证明与首次 write前的 no-symlink containment。v3 receipt
  revision、persist-before-GO owned process-group supervisor、boot barrier与
  `ManagedArtifactPathAuthorityV1`已折入 v7。
- Codex 设计门第七轮：隔离 snapshot
  `e415fed3b8cea6444a82e532fceffc94c7ba61bf`，
  `NEEDS_REVISION — P0=0, P1=3, P2=0`；主 UX、ACL/OCC/secret、current-owner/final-authority、
  migration/legacy无新增阻断。普通 PGID仍漏 `setsid + double-fork` descendant，inode复验仍漏
  last-check→path-syscall TOCTOU，combined approval→answers缺 strict receipt wire。Linux private
  PID namespace process-set proof + Darwin pre-act capability rejection、descriptor-relative
  `ArtifactFsCapabilityV2` + exact-leaf child sandbox、`IntentMountApprovalReceiptSchema`已折入
  v8。
- Codex 设计门第八轮：隔离 snapshot
  `a794df21d1d7fbd9b66a7981e2d7c0500925f604`，
  `NEEDS_REVISION — P0=0, P1=6, P2=1`；Linux kernel process-set主体与 strict approval receipt
  已闭合，残余为 EMPTY proof trust root、零状态旧 id承诺、filesystem temp/mount/restore/helper
  authority、Darwin Plugin死路、Plugin/Workflow prompt drift、hint未入模型与短视口/touch门禁。
  v9已折入 supervisor-owned Ed25519、诚实 pre-accept语义、`ArtifactFsCapabilityV3` +
  `ArtifactRestoreCapabilityV3` + verified helper、Composer/model capability前置、shared model
  contract/immutable hint及390×568 touch/dynamic-resize scene，已交第九轮全新隔离复审。
- Codex 设计门第九轮：隔离 snapshot
  `9457d2859e76a91462e8565be7ed31fa5c879b42`，
  `NEEDS_REVISION — P0=0, P1=5, P2=0`；既有 UX、权限/OCC/secret、migration、dispatcher与前八轮
  已闭合项未出现新增阻断。残余为 accepted replay仍会被当前 capability挡住、Skill目录发布
  authority不完整、restore换 DB会遗失 released writer验签义务、live daemon下 CLI stage无合法
  broker入口，以及 `file:`布尔能力未绑定 actor选择的 exact source。v10已折入
  ledger-first exact replay + admission lease、sealed tree双 entry exchange receipt、
  non-restored writer obligation ledger、daemon-owned pending-stage control与 opaque mounted-file
  handle/source fence，已交第十轮全新隔离复审。
- Codex 设计门第十轮：隔离 snapshot
  `b08ac303833aa8cdc7f405fce8dcfb164e3f88c3`，
  `NEEDS_REVISION — P0=0, P1=4, P2=0`；第九轮五项与既有主 UX/contracts均闭合。残余为
  restore把 regular `config.json`误建模成 tree、backup没有可 mint operation/slot、cancel effect
  后缺 durable replay ledger，以及 Darwin modify必须先有 session handle的 capability循环。v11已
  折入 config file/Skill tree分型 publication、独立 backup authority、non-restored pending control
  ledger与 attempt-bound pre-session source grant，待第十一轮全新隔离复审。
- Codex 设计门第十一轮：隔离 snapshot
  `61b1cee7d5e6809a3a7bf8f06c8bd9c572261441`，
  `NEEDS_REVISION — P0=0, P1=5, P2=0`；第十轮四项、方案 A主 UX与 RFC-234主合同均闭合。
  残余为 HTTP restore stream没有合法 read-only capability入口、Settings/CLI caller缺 replay
  locator、升级前 pending marker缺 adoption、旧 backup archive掉出新 retention inventory，以及
  worktree reconstruction只有 extractor且遗漏 ordered `task_repos[]`/Git registration。v12已
  折入 bounded restore ingress + 完整 phase types、strict caller wire/safe locator、
  legacy pending/backup两类独立 adoption，以及 task-level multi-repo Git reconstruction，
  待第十二轮全新隔离复审。
- Codex 设计门第十二轮：隔离 snapshot
  `ed6a2291cb8698bc23deeeda9db31d322d24b157`，
  `NEEDS_REVISION — P0=0, P1=5, P2=0`；方案 A主 UX、RFC-234主合同以及 v12 ingress/
  legacy-backup主体均无新增阻断。残余为 daemon-live dry-run缺 inspect wire、actor mismatch误删
  locator、legacy pending的 filename/字段/partial evidence与 released binary不符、missing
  multi-task parent无 reservation authority，以及 reconstruction receipt缺 target/registration/
  branch before-after effect证据。v13已折入 strict inspect local-control、actor-namespaced locator
  retention、released legacy五态 evidence、task/target reservation与 per-repo effect ledger，
  待第十三轮全新隔离复审。
- Codex 设计门第十三轮：隔离 snapshot
  `266816d78f73d73f0e87c5e57619e2d8ec033d42`，
  `NEEDS_REVISION — P0=0, P1=2, P2=0`；方案 A主 UX、RFC-234主合同、inspect、actor locator与
  Git add效果账本闭合。残余为 released post-swap failure/catch-before-quarantine与合法
  marker+archive物理同形却被自动当 clean pending，以及 canonical directory mkdir/fsync先于
  reservation receipt。v14已折入 active-pair operator-confirmed fail-closed recovery与
  durable declaration + broker-private prepare + no-replace canonical directory publication，
  待第十四轮全新隔离复审。
- Codex 设计门第十四轮：隔离 snapshot
  `38d50b61bd3b9416b962df6d7b930697a1beb686`，
  `NEEDS_REVISION — P0=0, P1=2, P2=0`；方案 A主 UX、RFC-234主合同、active-pair operator
  gate与 no-replace directory publication主路径闭合。残余为 legacy hold/quarantine rename前没有
  durable target publication，以及 worktree declaration/no-Git-effect/single-existing分支无法
  构造真实 terminal compensation。v15已折入 pre-effect legacy move publication、
  `closed-absent`、`effect:none`与 strict single alias，待第十五轮全新隔离复审。
- Codex 设计门第十五轮：隔离 snapshot
  `0afc2aaf4016869b8c5c84cbcdfa53fdfa7cec0c`，
  `NEEDS_REVISION — P0=0, P1=3, P2=0`；rename前 target publication、zero-directory/
  absent-baseline no-Git-effect与 single alias主体闭合。残余为 `cleaning`删除后的合法 neither被
  误判 repair；retained shared infrastructure、unique-stale cleanup与 Git partial delta没有全域
  terminal algebra；nested strict codec未逐字段绑定 foreign identity。v16已折入 phase-sensitive
  cleanup、created-infrastructure retention、registration preparation/partial effect及 canonical
  nested schemas，待第十六轮全新隔离复审。
- Codex 设计门第十六轮：隔离 snapshot
  `a7956163df521f244ab5957d37df5dc4b725d272`，
  `NEEDS_REVISION — P0=0, P1=1, P2=0`；v15三项、方案 A主 UX与 RFC-234主合同均闭合。唯一新
  根因是 identity bigint decode transform误挂 mount approval receipt schema，使合法审批提交后
  frontend/detail recovery都无法 parse并继续 answers。v17已拆开 receipt与 identity input/output
  boundary，补 canonical uint64 codec、唯一 encoder及组合 response-loss fixtures，待第十七轮全新
  隔离复审。
- Codex 设计门第十七轮：隔离 snapshot
  `211733a5b90dacb2d5a262d5c65dfb1e317ef66c`，
  `NEEDS_REVISION — P0=0, P1=1, P2=0`；R16-P1-01、identity leaf codec、方案 A主 UX及
  RFC-234主合同均闭合。唯一新 P1为 decoded bigint recovery records只有 leaf encoder，
  artifact/pending/legacy/worktree durable roots没有可执行的顶层 wire producer，正常
  record-before-act checkpoint无法写出。v18已加入 closed root codec registry、成对 wire/decoded
  schemas、逐 branch `never` encoder、branded writer boundary与全 root round-trip/kill fixtures，
  待第十八轮全新隔离复审。
- Codex 设计门第十八轮：隔离 snapshot
  `389992880bc3d2d053cbddb041bc2683496bbead`，
  `NEEDS_REVISION — P0=0, P1=2, P2=0`；R17 root producer、leaf bigint、方案 A主 UX及
  RFC-234主合同均闭合。残余为 restore generation marker未进入 14-key registry，以及重启从
  raw disk bytes到 TypeScript brand之间没有唯一 loader/runtime trust boundary。v19已把 marker
  作为第 15个 exact root，补七态 wire/decoded/encoder/cross-field合同；canonical outer frame与
  expected-codec raw loader、runtime WeakSet、跨进程/非 canonical/foreign负例也已折入，待第十九轮
  全新隔离复审。
- Codex 设计门第十九轮：隔离 snapshot
  `7aa7df03d5c68db3ae221ad7a4cfdd846aff07ac`，
  `NEEDS_REVISION — P0=1, P1=4, P2=0`；方案 A主 UX、RFC-234 final authority及历史 closure均未
  回退。P0为 restore把 SQLite generation误建模成单 DB文件、遗漏 DB slot与 WAL/SHM destructive
  protocol；四个 P1为 marker schema/encoder仍未定义、publication locator/operation digest缺失、
  options跨 checkpoint丢失及 DB/Skills absent target不可表达。v20已加入同 snapshot normative
  executable appendix、第16个 SQLite publication root、root-specific key/full-operation digest、
  durable options/migration disposition与 absent/no-replace algebra，待第二十轮全新隔离复审。
- Codex 设计门第二十轮：隔离 snapshot
  `5ebdfa356d96550f10e07100d44dae8e11539f7d`，
  `NEEDS_REVISION — P0=0, P1=4, P2=0`；第十九轮五项、方案 A主 UX与历史 closure均闭合。残余为
  long-lived marker引用可变 root后被合法 inner checkpoint判foreign、publication ref未绑定
  phase/mode/staged/published/displaced语义、artifact/SQLite repair可丢已知证据，以及legacy
  adoption/operator reapply未全链绑定 restore options。v21已加入immutable revision-addressed
  lineage/latest-descendant、purpose-specific semantic projection、lossless forensic repair +
  transition validators与legacy options authority；同轮用户新增的Intent turn session执行过程
  复用要求也已按独立durable events + unified parser/renderer/backend capture seam折入，待第二十一轮
  全新隔离复审。
- 用户批准：2026-07-29 已明确授权“基于现在的设计先做出来一版”；授权范围仅为目标优先/
  响应式/双栏 UX 与 Intent turn Session 持久化、权限、WS/poll 和共享 renderer 切片，不等同于
  批准完整 v21 supporting-contract 主线。
- 首版实现：`IntentCreateComposer`、`IntentSessionList`、`IntentJourneyProgress`、
  `IntentTurnSession`、共享 `SessionConversationPanel`；backend 增独立 turn event store、
  `SystemAgentEventSinkV1`、OpenCode post-run child capture、owner/admin Session API 与
  throttled WS locator。主 Session live，子 Session 首版 post-run 回填。
- 未实现并继续保留 Draft：统一 mutation ledger/current-owner dispatcher、完整 artifact
  recovery/restore authority、分步 CommitDialog、mount approval 全流及本计划其余 supporting
  contracts；不得把本次首版发布记为 RFC-235 全量 Done。
- 实现门与发布：首版代码在本次“提交上库”流程中执行完整本地门禁、Codex 实现门、精确路径
  commit/push 与 exact-SHA CI；最终证据以发布结果为准。
