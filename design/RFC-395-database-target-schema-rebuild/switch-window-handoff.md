# RFC-395 II-b 换表窗口交接清单（2026-10-24）

本文件汇总换表窗口第一波、修复轮各包留给第二波、A（激活）、Q（收口）与 T18（集中验证）的事项：接口请求、目标 schema 增量、规则版本变化与共享账本条目。条目按包的英文原文保留，路径相对 `packages/backend/`（除非另写）。文中 `/private/tmp/...` 路径是当次会话的证据文件，可能已不存在；事项本身在这里写全。决定依据见 plan §6.13「换表窗口分解」「第一波审查与修复轮」。

# RFC-395 II-b wave 1 — collected requests, deltas and ledger entries (input for wave 2, A and Q)

Each section quotes the package report's §6 by reference; the full text is in `/private/tmp/rfc395-wave1-<pkg>/report.md`.

## M-a (done 2026-10-24 20:10; 91 files; own diagnostics 0; shared tsc exit 2 with 193 diagnostics in 56 other paths)

- A: wire the final embedded target head (the test factory compiles `createHistoryVersion(targetPersistenceSchema)` per process
  until then); once production providers bind epoch 2 and the row-rule mapper, converge the test-only PostgreSQL adapter onto the
  production constructor; keep the frozen helper's separate table set and source client through the accessor codemod; update the
  before-A dual-binding assertions in `tests/rfc395-target-test-database.test.ts` at A-1.
- B / Q: keep the historical URL-sealing assertions of `tests/rfc279-database-redundancy-cleanup.test.ts`; when the boot helper
  retires, move them to the converter entry instead of deleting them.
- M-b / M-c: business tests use `await createTestDb()` and target builders; default `describeEachProvider` already installs epoch 2;
  the 84 historical migration tests and the frozen source API are excluded from the global factory replacement.
- Roster / destinations / V2 rule delta: none.
- Ledger entries for T18 (Q): new factory and its tests; before-A binding imports; factory / source-consumer census moved to
  `createFrozenEpoch1Db` / `openFrozenEpoch1Db` / `migrateFrozenSqlite`; re-check R1 / V1 dormancy and provider-fixture guards.
- Note: M-a edited `tests/epoch1-permission-text-backup.test.ts` (committed in 73d7e1f04) to pin the V1 plain-text source contract.

## X (X1 done 2026-10-24 ~20:15; 30 files; own diagnostics 0 by targeted check; full tsc did not finish — stale process)

- **X2 still to do** (wave 1): the 14 remaining runtime adapters (`/private/tmp/rfc395-wave1-x/remaining-runtime.md`: collaboration
  review / committedReviewArtifactReader / crewstation reviewArtifacts / reviewRepairParticipant, memory distill read / work stores,
  development-automation crewstation objectIndex, digital-employee reactionArtifactStore / runtimeStore, task-execution crewstation
  portArtifactContent / taskArtifacts / taskInputFiles, legacyTaskExecutionInjectionResolver, nodeOutputQueries), the 96 test candidates
  (`remaining-test-candidates.md`), the frozen skill-bytes helper in `platform/content/migration/skillContent.ts`, and retiring the
  `content/skills@3` / `content/skill_versions@3` claims in `platform/content/migration/index.ts` (keep `skill_content_entries`) with
  an independent immutable identity for the B-created initial snapshot; runtime reader parity.
- A: bind epoch-2 tables; choose and inject the content policy and the local / object transport; wire the two probes
  (`content:catalog-bytes-and-publications`, `content:skill-reference-columns`); replace skill-identity-barrier / backfillLegacyVersions /
  fusion-provenance boot steps with B's conversion and bind the normal skill `recoverOperations` separately; move the legacy readers
  after their last importer (10 `platform/content/legacy*.ts`, `skillIdentityMigration.ts`, `skillMigrateOp.ts` — the restore path
  still calls the old identity migration; it must not reach epoch 2).
- P: consume `createSkillContentLocationQuery` (current version / exact snapshot); physical release of local / database content waits
  for all live / history / backup holders; local-file pending without a catalog identity must not go to hosted-object maintenance.
- F / M-b: `public/participants.ts:114` `recoverOperations` is consumed; M-b updates `rfc345-skill-catalog-boot-participant.test.ts`.
- B's roster delta (from B): `skill_versions.sources` gains `skills`.
- Ledger entries for T18: content runtime factory, probes and three provider tests; reclassify contentRefCodec / contentStore from
  dormant to runtime-reachable; hosted publications moved to content tables; removed boot / backfill / provenance calls.

## H (done 2026-10-24 ~20:25; 49 files; own diagnostics 0; full tsc exit 2 in 123 s, 182 diagnostics in 51 other paths)

- A / A-4: inject `createCodeHistoryPackageReader({ db, content, installation })` as the third argument of the code-history
  composition (admitted receipt's source generation / contract descriptor; fresh install explicit); pass stable
  `{ activeGeneration, updatedAt }` to the writer composition and delete the activate binding (`bootstrap/daemonApplication.ts:855`,
  `daemonModules/digitalEmployee.ts:206`); delete the old draining binding (`daemonModules/developmentAutomation.ts:30`, `:176`), its
  polling (`daemonSession.ts:526`) and the `legacy-mission-recovery` boot item (`daemonApplication.ts:893`); close the old re-export at
  `modules/development-automation/composition.ts:47`; wire the `code-capability:history-index` probe.
- M-b: migrate history-adapter tests that still pass PersistenceDb (`rfc304-delivery-chain-read`, `rfc349-code-work-items-postgresql-
  adapter`, `rfc349-code-delivery-postgresql-adapter`, `rfc349-code-attempts-postgresql-adapter`, `rfc349-code-metrics-postgresql-
  adapter`, `rfc349-code-history-composition`); writer activate / refresh / migrationSnapshot callers (`rfc317-cross-context-ports`,
  `rfc359-w4-d7a-adapters`, `rfc359-w4-d13-adapters`, `rfc370-development-invalid-body`); draining assertions (`rfc383-writer-gates`,
  `rfc383-daemon-employee-automation-bundles`, `rfc338-maintenance-architecture`); plus `rfc310-digital-employee-writer-cutover`,
  `rfc349-digital-development-maintenance-postgresql`, `rfc359-t1-task-execution-atoms.test.ts:101` (family receipt.mode).
- M-c: `rfc341-committed-event-store`, `rfc359-w16-task-lifecycle-write-sequence` after H.
- Roster / destinations delta: none.
- Ledger entries for T18: four new `rfc395-*` tests; provider / same-file-pair re-check for H's 21 test files and two helpers;
  reviewed-consumer / source-lock entries for the deleted phase-change API, writer draining helper and old demo history DTO.

## B (done 2026-10-24 ~20:30; 31 files — 21 new, 10 dormant modified; own targeted diagnostics 0; my kill ended its stale full tsc)

- A: register the five owner compositions and `createSkillBootConversion(X helper)` in `bootstrap/conversionRules.ts`; aggregate the
  four environment contributions with `createBootUpgradeEnvironment([...])` and inject `ConversionPort.bootUpgradeEnvironment` (key
  provider re-opens the original input, never creates / rotates keys while probing; the same path for the switch and old-epoch
  restore); keep `bootstrap/epochMigration.ts:100` forwarding the facts; A-4 removes the old upgrade sub-calls but keeps normal
  recovery and fresh-seed behaviour.
- X: retire the `content/skills@3` / `content/skill_versions@3` claims, implement the `SkillBootContentConverter` helper (X2 has it).
- F: export `skillBootEnvironment` from its composition for A.
- T: B-1 lookup consumption confirmed (`modules/task-execution/infrastructure/migration/task/rule.ts:92`).
- Roster delta (A): `skill_versions.sources` → `["skill_versions", "skills"]` (`bootstrap/targetSchemaRoster.json:1145`).
- Destinations note (A): document the deterministic initial version, husk archive, fusion / memory re-point, schedule disable / heal,
  runtime binary backfill and URL display / ciphertext effects; no new target columns.
- M-b / V3 tests: the strict plan payload gains `bootUpgradeEffects`, `bootUpgradeEnvironmentDigest`, `bootUpgradeFactsDigest`;
  fixtures need a real empty-facts digest; the freeze-time K-2 case must assert the target is not created yet.
- Ledger entries for T18: six @1 rules, three boot lookups, exact retirement of the old generic / alignment / content claims, seven new
  tests, the plan-material fields and the roster delta.

## N-a (done 2026-10-24 ~20:35; 22 files — 18 src, 4 tests; own diagnostics 0; full tsc exit 2, 182 diagnostics in 51 other paths)

- **T (follow-up after T finishes)**: make `selectedRunId` nullable in `modules/task-execution/infrastructure/persistence/targetSchema.ts:473`
  (the selection clear writes a NULL tombstone); sync T's validators, V2 rule and conversion tests; report the schema / history /
  roster delta to A.
- N-b: replace the callers of the old helpers / snapshot signatures in `nodeRunMintParticipant`, `nodeExecutionPersistence`,
  `nodeRunLifecycleTransition`, `nodeRunLifecyclePersistence`, `taskLifecycle` (keep owner CAS, nonce and lock order); move the oracle
  under the last-importer rule after wiring the table reader / participant; `run/split.ts` consumes `nodeRunRowPresence` and keeps
  the presence facts of `prompt_text` / `prompt_path` when an external prompt is missing; shard-grained writes use
  `recordNodeRunInputsInTx`.
- M-b: task / workflow builders on the target model with generation 0; NodeRun builder and V2 share `nodeRunRowPresence`; migrate
  grouped-writes, checkpoint, runtime freeze / lease, merge supersession, hosted recovery and event-archive tests.
- A: collect probes `task-execution:run-selection-integrity` and `task-execution:run-input-integrity` with T's contribution; update
  dormancy / source guards at activation.
- Q: unknown-history evidence / display projection; shared source locks, reviewed consumers, table ownership and counts.
- Ledger entries for T18: four tests (three both-provider); table reader / selection participant / nodeRunWriteProtocol access
  boundaries; two probe ids; zero runtime oracle imports from N-a.

## T (done 2026-10-24 ~20:45; 153 files; T's own code 0 diagnostics; 4 diagnostics left in three T → N-b shared files' Run sections; full tsc exit 2, 182 total, 178 in 48 other paths)

- A: bind the target set; collect `infrastructure/migration/probes.ts` read-only probes; inject X `ContentStore.read` into
  `createEmployeeExecutionArtifactQueries` (`bootstrap/daemonModules/digitalEmployee.ts:248`); switch
  `modules/task-execution/composition/taskArchiveMaintenance.ts:36` and the required-ports archive collaboration callback to the W0 / C
  `TaskArchiveCollaborationSectionReader`; pass the same snapshot transaction to every owner section.
- Roster / history delta (A): three new indexes (`task_definitions_subject_task(subject_kind, task_id)`,
  `task_launch_contexts_origin_task(launch_origin, task_id)`, `task_workspaces_requested_cached_repo(<requested cachedRepoId
  expression>, task_id)`) and `task_execution_generations_operation UNIQUE(task_id, operation_ref)` NULLS DISTINCT; rule versions:
  task-execution/task 2 → 3, unsettled-workspace-preparation validator 2 → 3; the task rule consumes B's `boot/repository-urls@1`.
  Regenerate the target roster / head / canonical artifacts.
- N-b: continue the shared Run / selection sections, `public/*` and the N part of `targetSchema.ts`; first fix
  `nodeRunLifecyclePersistence.ts:23`, `nodeRunLifecycleTransition.ts:30-31` (removed `nodeRunLifecycleWriteColumns`) and
  `nodeRunMintParticipant.ts:10` (`consumedInputColumns`) by consuming N-a's write protocol / `recordNodeRunInputsInTx`; wire the
  generation participant and the real mount-key reader; the archive's 12-table NodeRun section; `services/execution/outcome.ts:26`,
  `:209` still use the removed `decodeTaskSubject`. **Also (from N-a): make `selectedRunId` nullable in the TE target schema
  (`targetSchema.ts:473`) with its validators, V2 run rule and conversion tests.**
- M-b: fixtures / builders consume `splitTaskCreation`, `taskMountAtCreation`, `initialTaskExecutionGeneration` (spec signatures
  unchanged; never write removed task mirror columns back to the root); the V2 task fixture harness assembles B's URL facts;
  `rfc395-a2-task-creation.test.ts:39` needs an explicit `definitionOrigin`; `rfc395-a2-task-domain.test.ts` epoch-1 decoding moves to
  `migration/task/subject`; `rfc396-execution-consumption.test.ts:71` injects `ContentStore.read`.
- C / A: `taskQuestions.ts:30`, `taskQuestionDispatch.ts:46` still import `decodeTaskSubject` (read the target definition subject).
- Unowned leftovers (assign in wave 2): `modules/task-execution/infrastructure/taskSubjectSql.ts` (retire the old subject
  discriminator helper; M-b syncs `helpers/model/taskSubject.ts`); `taskRepositoryCodec.ts` (old `taskRepositoryMountColumns` has no
  production consumer; carry `repoKey` or delete); `modules/source-control/application/workspaceMaterialization.ts` (retire the old
  `asMaterializedSpace` replay decoder).
- Q: v3 bytes / bigint wire, v2 history reader, version activation; DTO / WS bytes and real journeys.
- Ledger entries for T18: five T tests, the task aggregate probe, the archive reader / section table set; direct-table consumers and
  subordinate writer list; the requested-source expression-index dialect pair in `platform/persistence/taskRepositorySurface.ts`;
  W26 workgroup inverse-source lock `05b89c96…` → `393dac16…` (`/private/tmp/rfc395-wave1-t/source-lock-delta.json`).

## C (done 2026-10-24 ~20:55; own diagnostics 0; full tsc 160 diagnostics in 43 other paths)

- A: bind the target registry; update `bootstrap/target*.json` and schema history for the artifact table v3 and the two nullable
  reference columns (table count, schema symbols and conversion destinations unchanged; C's rules `collaboration/clarify-rounds@2`,
  `gate-operations@1`, `gate-open-drain@1` have no delta).
- A: inject `createContentHumanGateArtifactStore({ db, content })` from `public/participants.ts`; pass `HistoryRestrictionPort` to every
  journal / open participant (`collaboration/composition/commandContext.ts`, the taskLock branches of
  `infrastructure/humanGateOperationPersistence.ts`, `infrastructure/clarifyDecision.ts`, `infrastructure/taskQuestionDispatch.ts`,
  X's `infrastructure/review.ts`, `task-execution/infrastructure/humanGateTaskLifecyclePersistence.ts`); collect collaboration
  `readOnlyProbes`; inject the profile content reader into `createCommittedHumanInputQueries` (`bootstrap/daemonModules/
  digitalEmployee.ts:102`, `:227`).
- X: review / committed readers consume the target ContentRef; check C's logical `finalContentKey` and the `collaboration-review`
  publication owner; `platform/content/migration` keeps the artifact content conversion — check declared / cleanup history with
  missing references and staged / consumed / finalized coverage, decide whether the rule version changes.
- N-b: keep wave-1's v2 open manifests, content references and restriction calls when adding role / mint changes in the journal,
  open participant and `taskQuestionDispatch`.
- M-b: target fixtures for the three new tests and the clarify suites; real restriction provider and content adapter in gate journal
  / content-recovery tests; `rfc395-a4-clarify-journeys`, `rfc396-review-return-decision` pass a content reader to
  `createCommittedHumanInputQueries`; `rfc128-p5-bc-self-questioner-rerun`, `rfc359-t25-batch-insert-hot-paths` still use the old round
  / v1 / bodyPath inputs (move to target / v2; historical migration cases keep the old values without loosening decoders).
- M-c: `clarify-inline-isolated-parity`, `review-clarify-question-phase-stranded`, `rfc098-wrapper-revival-e2e`,
  `rfc122-clarify-directive-dispatch`, `rfc372-task-engine` old factories.
- Q: the 13-table collaboration section reader in the archive coordinator; V3 archive version / section roster.
- Ledger entries for T18: `rfc395-clarify-answer-boundary` content digest; `tests/architecture/rfc359-w6-t28-read-modify-write.test.ts:91`
  (`clarifyAnswerWrite.saveDraft` no longer a Task-lock whole-map RMW); reviewed-consumer / public exit entries for
  `public/queries.ts → createTaskArchiveCollaborationSectionReader` and `public/participants.ts → createContentHumanGateArtifactStore`.

## F (done 2026-10-24 ~20:55; 59 files; own diagnostics 0)

- A: activate root / transaction target tables and unify the accessor (T-2); register F's two `readOnlyProbes`; wire
  `SkillCatalogBootParticipant.recoverOperations()` in boot and remove the ordinary-boot identity / version upgrade calls (U-4);
  compose B's `createSkillBootConversion(X converter)` and add `skillBootEnvironment()` to the boot environment aggregation.
- B / X / A: F exports B's `SkillBootContentConverter`, factory and `skillBootEnvironment`; `platform/content/migration/skillContent.ts:45`
  `convertFrozenSkillContent` exists (X2 in progress). F's own roster / rule / destination delta: 0 (B's `skill_versions.sources` delta
  stands).
- X / P: F consumes `capturedSkillTreeColumns` / `skillRowPath`; P may continue `RC/infrastructure/migration/probes.ts` and
  `RC/infrastructure/persistence/targetSchema.ts` in wave 2, keeping F's two probes.
- M-b: Agent fixtures write the four relation tables and replay by ordinal; parent-row `createAgentPersistenceValues` fixtures keep the
  four reference kinds explicitly; workflow fixtures build the current revision's dependency index in the same transaction; malformed
  epoch-1 JSON belongs in conversion fixtures (no runtime JSON fallback).
- Unowned (assign in wave 2): `tests/helpers/legacyInjectionAgentLookup.ts`, `rfc359-w12-agent-codec-conformance`,
  `rfc359-w12-agent-write-values-conformance`, `rfc395-a5-reference-ports` (old Agent row / decoder contracts);
  `rfc345-skill-catalog-boot-participant` (old five-step boot assertions).
- M-c: `rfc165-agent-launch`, `rfc212-revalidation-behavior`, `rfc269-webhook-code-host-context-e2e`,
  `rfc359-w14-agent-commit-sequence` (keep the synchronous participant's immediate completion and rollback assertions),
  `rfc359-w9-catalog-legacy-sync-transaction-cutover`.
- Ledger entries for T18: two new tests, reference-boundary source lock, two probes; recount direct-table / source-lock / consumer
  ledgers on the final candidate.

## X2 (done 2026-10-24 ~21:10; 115 files; own diagnostics 0; full tsc 136 diagnostics outside X)

- A: bind the epoch-2 target set; inject the content policy / transport; route the old skill identity / backfill and fusion
  provenance boot steps to B's one-time conversion and wire `recoverOperations` separately; wire X1's two probes; the converted-skill
  reader must consume the database-bytes skill-tree bundle (local skills still need the right profile binding).
- **B (follow-up)**: consume `convertFrozenSkillContent`; close `skillBootFacts.ts:209` root ownership (a canonical row's display name
  is not a second physical ownership root; a canonical empty husk must not take or delete another canonical root); directory reads at
  `:85`, `:220` must accept a symlinked skills root as the old tests do; detect the exact `files.op-<ULID>.backup` residue. The
  `skill-identity-migration.test.ts` canonical-alias, husk-alias, symlink-skills-root, protocol-residue and similar-support-name cases
  stay (read-only finding, not run).
- F / A: keep the `recoverOperations` contract; converted skills use the bundle-aware reader.
- C / N-b / M-b / M-c: keep X's content codecs and publication lifetimes when editing shared files; non-local document keys
  (`doc-content:<id>`, `gate-stage:<op>:<key>`) go through the committed reader; M-b syncs `rfc345-skill-catalog-boot-participant`;
  M-c / A recheck `backup.test.ts:154`'s whole-database table count against the final roster.
- P / H: read archive / history through explicit content references; physical reclaim waits for all live / history / backup holders.
- Roster / destinations delta (A): remove X's `content/skills@3` and `content/skill_versions@3` claims, keep
  `content/skill_content_entries@2`; B's `resource-catalog/boot-skills@1` alone owns skills / skill_versions and produces content
  objects / bytes; initial skill_versions sources include skills.
- Ledger entries for T18: 14 adapters switched; `databaseContentColumnsInTx` / `hostedContentColumnsInTx` / `releaseContentRowsInTx`
  transaction relations; the frozen skill bundle and B helper; 95 test changes.

# Fix round (2026-10-24 21:50–22:17; reports `/private/tmp/rfc395-w1fix-<pkg>/report.md`; every package's own files 0 diagnostics)

## For N-b (wave 2)
- Target mint in `nodeRunMintParticipant.ts` with the explicit `inputsRecorded` flag (T-F14), consuming N-a's input / selection /
  checkpoint write protocol; keep NULL vs recorded-empty.
- Align `revision()` and `RunHistoryRef` / `TableShardSetView.history` with the application ports; after a clear, read the slot
  revision from the reader (never `current()?.revision ?? 0`); every owner path fences and locks the root before its first run write
  (L-1); `ConsumedInputsParticipantInTx.record` inherits the caller's locks (the review park-review → record path must hold the root
  before the run CAS); migrate the table factory parameters; adapt the old helpers / snapshot signatures in `nodeExecutionPersistence`,
  `nodeRunLifecyclePersistence`, `nodeRunLifecycleTransition`.
- `humanGateOperationJournal.ts:1339`: `ContentStore.release` must read the stored fence from the publication ledger (no constant
  epoch) now that object puts carry the current fence (X fix).
- Thread `historyRestrictions` through `modules/task-execution/composition/taskExecutionPersistence.ts:133`, `:154` and
  `composition/humanGate.ts:45`, `:69` (T fix request; the D0190 `node_run_outputs` content-column diagnostic in
  `taskExecutionPersistence.ts:155` is N-b's switch too).
- Unowned leftovers given to N-b: `modules/task-execution/infrastructure/taskSubjectSql.ts`, `taskRepositoryCodec.ts`,
  `modules/source-control/application/workspaceMaterialization.ts`, `modules/collaboration/infrastructure/taskQuestions.ts:30`,
  `services/execution/outcome.ts:26`, `:209`.

## For P (wave 2)
- Consume explicit live / snapshot reference kinds (`createSkillContentLocationQuery`; the current reader's commit → publish live
  fallback does not apply to the history snapshot reader); intent / package hosted publications carry `contentKind`; other
  compositions pass `skillContentKind` / `contentKind` explicitly.
- `modules/intent/infrastructure/intentApplyArtifactLifecycle.ts:61-94` still reads the removed `skills.managedPath` /
  `skillVersions.filesPath`.

## For M-b (wave 2)
- `tests/rfc395-v2-integration-mixed.test.ts:128`: compose B's rule, X's entry rule and frozen skill facts.
- `tests/rfc395-v3-contracts.test.ts:121`: add `bootUpgradeEffects`, `bootUpgradeEnvironmentDigest`, `bootUpgradeFactsDigest`; adjust
  assertions that depended on the old approval material / per-unit re-check (P-2).
- Agent fixtures / codecs: `tests/helpers/legacyInjectionAgentLookup.ts`, `rfc359-w12-agent-codec-conformance`,
  `rfc359-w12-agent-write-values-conformance`, `rfc395-a5-reference-ports`, `rfc345-skill-catalog-boot-participant`; client agent reads
  use the query callback or the same transaction as the loaded parent row; `rfc284-batchc-resource-dedup` remaining fixture migration.
- Keep unknown-history, NULL-tombstone and history-only-lineage target inputs as distinct rows (do not fabricate identities).

## Follow-ups job (wave 2, parallel; small, file-disjoint)
- Collaboration composition threading (C fix): `modules/collaboration/infrastructure/clarifyDecisionCommand.ts:21`,
  `questionDispatchCommand.ts:19`, `composition/crewstationHumanGateRecovery.ts:11` (patch `/private/tmp/rfc395-w1fix-c/composition-followup.patch`),
  `reviewDecisionCommand.ts:23`, `:34`, `:40` (ContentStore and `historyRestrictions`).
- X (C fix request): `platform/content/migration/specs.ts:197` — admitted legacy committed artifacts with a missing final file but a
  present staged file convert so C-F2's runtime fallback is reachable; `committedReviewArtifactReader.ts` `doc-content:` fallback
  covers old docs without metadata, artifacts with metadata, and the object-missing error mapping.
- B / X disagreement: `tests/rfc395-boot-rule-coverage.test.ts:58` boot-skills produces assertion includes `skill_content_entries`.
- F (X fix request): export `createFileSkillContentBinding` and `packageContent` from the resource-catalog composition exit.

## For A (collected, in addition to the wave-1 lists)
- Deltas D1–D7 from T fix (subject_kind `unknown`; lineage columns nullable ×2; `selected_run_id` nullable; `inputs_recorded` default
  false; index `idx_task_launch_contexts_webhook_fire`; task rule 3 → 4); B rules @1 → @2 with lookups @2; X `boot-skills` produces
  `skill_content_entries`; register B's five contributions and inject the boot environment; content binding / ContentStore / content
  maintenance (`createContentMaintenance` with holder queries, backup horizon, local owners, `objectPublicationEpoch =
  fence.current().epoch`); `platform/content:` probes; one `historyRestrictions` provider everywhere.

## Ledger entries for T18 (collected, fix round)
- T: three `taskListPage/query.ts` source-lock hashes (`/private/tmp/rfc395-w1fix-t/source-lock-delta.json`).
- C: content digests of `rfc395-clarify-answer-boundary`, `rfc128-p5-bc-self-questioner-rerun`, `rfc341-collaboration-source-locks`.
- F: `SYNC_TRANSACTION_DEBT` `modules/resource-catalog/infrastructure/legacy/agent.ts: 0 → 1` (`legacy/agent.ts:178`).
- N-a: re-point `rfc144-merge-state-blind-write-inventory` to `nodeRunWriteProtocol.ts:272` / `:295`.
- B: rule / lookup version bumps; approval / K-2 acceptance criteria (semantic effects + deciding facts; re-check after freeze and
  after conversion).
