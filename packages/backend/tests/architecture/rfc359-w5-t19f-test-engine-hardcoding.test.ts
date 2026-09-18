// RFC-359 W5-T19f —— 测试面「不得写死引擎」的高水位账本（只降不升）。
//
// **为什么单引擎测试是本 RFC 的核心风险。** `describeEachProvider`（`tests/helpers/eachProvider.ts`）
// 是 RFC-359 的双引擎 harness，而且**双引擎是缺省**：不设 `AW_TEST_PROVIDERS` 就两个引擎各跑一遍，
// PostgreSQL 侧没有 URL 是 **fail 而不是 skip**（`AW_TEST_PROVIDERS=sqlite` 只是本地的显式降级，
// Ubuntu CI 保持双引擎）。绕开它、直接在测试里建一个 SQLite 内存库，写出来的判据就**只验证 SQLite 一个引擎**——
// PostgreSQL 侧的同一段实现拿不到任何行为覆盖。这不是风格问题，是让 parity 缺陷一路穿过全部验收的
// **机制本身**：`design/dual-provider-parity-audit-2026-09-04.md` 里 12 条 P0 全是这么漏过去的，
// PG 侧实现长期零行为覆盖，直到两侧合一时才发现它比 SQLite 侧更弱（漏引用完整性复核、漏幂等回放）。
// 也就是说，只要还允许新写单引擎测试，本 RFC 收敛掉的实现分支就会从测试面再长回来。
//
// **为什么现在是高水位而不是 0。** 存量调用点散在几百个测试文件里，一次性迁移等于把整棵测试树重写一遍，
// 在本仓的并发工作树上必然撞车。所以本轮**只上守卫、不做迁移**：先把「还剩多少」变成可计数、可防守的量，
// 长期目标仍然是 0——每个后续波次顺手迁一批、把账本改小一格。
//
// **机制**同 RFC-317 T17 与 `rfc359-sync-transaction-highwater.test.ts`：逐文件列出调用点数、
// 与实测**逐字相等**。**增**了红——有人又写了一条只验证 SQLite 的判据；**减**了也红——收敛发生了，
// 把账本一起改小，让每一次迁移都留下一次有署名的提交记录。
//
// **一处豁免**：`helpers/eachProvider.ts` 是 harness 自己的家——SQLite 侧的库正是它用这个工厂造的。
// 除此之外整棵 `tests/` 树一视同仁：夹具（`helpers/*.ts`）与用例同等对待，夹具写死引擎同样让它的
// 全部下游只剩一个引擎的覆盖。**本文件不再自我豁免**——判据改成按 AST 数真调用点之后（见
// `countCallSites`），正文里成段提到这两个符号不再被记成债，自我豁免也就没有存在理由了。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const TESTS = resolve(import.meta.dir, '..')

/** harness 自己的家：它按定义就要建 SQLite 库。 */
const EXEMPT: ReadonlySet<string> = new Set(['helpers/eachProvider.ts'])

/** 整棵 `tests/` 树的 `.ts` 枚举——既是语料下限的分母，也是下面逐文件计数的唯一输入。 */
function enumerateTestSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(TESTS, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.ts')) out.push(rel)
    }
  }
  walk('')
  return out.sort()
}

/**
 * 模块级只枚举一次。**故意是个数组常量**：语料下限断言直接打在 `CORPUS_FILES.length` 上，
 * 「枚举 → 被数的量 → 断言」这条链一眼可追溯，`census.ts` 的 `measuredCorpusSize`
 * （`rfc317-guard-corpus-floor` 的判据）才认得出这是一条真语料下限。上一版把规模藏在
 * `scan().corpus` 这个数字属性里，两条判据（子树里要有 `.length`/`.size`、被数的东西要能
 * 追溯到枚举）双双落空，于是本守卫被点名「枚举文件却没有任何语料规模断言」。
 */
const CORPUS_FILES: readonly string[] = enumerateTestSources()

/**
 * `<相对 tests/ 的路径>: <直接建 SQLite 内存库的调用点数>`，按路径字典序。只降不升。
 * 迁移姿势：把 `describe(...)` 换成 `describeEachProvider(name, (harness) => ...)`，
 * 库从 `harness.db` 取（需要事务面就取 `harness.session`，需要按引擎分叉就看 `harness.capabilities`）。
 */
// RFC-359 AC-1（第 9 刀）销账 4 行：`lifecycle-property` / `lifecycle-transitions-current` /
// `retry-node-guard-order` / `retry-node-no-review-cascade` 已迁到 `describeEachProvider`。
// 触发点是合并本身：这四份验的都是 `retry`，而 `retry` 原有两份实现——它们只喂 SQLite 那一份，
// 所以此前靠 `sqlite-execution-engine` 那条机械理由挂账（它们确实 import `services/task`）。
// 两份合一之后那条理由消失了，判据当场把它们推到「既无理由、也不在 open 名单」这一格——
// 这正是本守卫该做的事：**实现合一了，测试面不跟上就立刻现形**。
export const TEST_ENGINE_HARDCODING_DEBT: readonly string[] = [
  'architecture/rfc329-mcp-surface-guard.test.ts: 1',
  'architecture/rfc359-w5-t19g-schema-contract-reconciliation.test.ts: 2',
  'backup.test.ts: 2',
  'callgraph-multirepo-prefix.test.ts: 1',
  'clarify-inline-isolated-parity.test.ts: 1',
  'clarify-review-combination-scenarios.test.ts: 1',
  'cli.test.ts: 2',
  'contracts/harness.ts: 1',
  'createindb-snapshot-parity.test.ts: 6',
  'distill-session-capture.test.ts: 1',
  'e2e-sqlite-fixture-lock-contention.test.ts: 3',
  'fixtures/rfc322-cpu-probe.ts: 1',
  'fixtures/rfc338-blocking-maintenance-worker.ts: 1',
  'fixtures/rfc338-foreground-contention-worker.ts: 1',
  'fixtures/rfc349-postgresql-crash-worker.ts: 1',
  'fixtures/rfc351-write-contention-worker.ts: 1',
  'flag-audit-kind-canonicalization.test.ts: 1',
  'fusion-engine.test.ts: 1',
  'gettask-multi-repo.test.ts: 1',
  'git-repo-cache.test.ts: 1',
  // RFC-359 AC-6（收尾）**销账**：夹具的 `options.db ?? createInMemoryDb(...)` 回退整条删除
  //（`db` 改必填）。它是「这套夹具的消费者可以只跑 SQLite」的唯一出口；五个消费者
  //（t109 全旅程 / pr5 java 端到端 / pr4 工作区旅程 / pr7b 冲突收敛 / pr3 外部适配器）
  // 全部迁到 `describeEachProvider`，回退随之消失。
  'helpers/rfc349PostgresqlHostedEvidence.ts: 2',
  'input-port-contract.test.ts: 1',
  'integration-chaos/chaos-scenarios.integration.test.ts: 2',
  'memory-distiller-source-context.test.ts: 1',
  'migration-0002.test.ts: 1',
  'migration-0008-cached-repos.test.ts: 1',
  'migration-0010-opencode-session-id.test.ts: 1',
  'migration-0011-mcps.test.ts: 1',
  'migration-0012-node-run-events-session.test.ts: 1',
  'migration-0014-plugins.test.ts: 1',
  'migration-0015-inventory.test.ts: 1',
  'migration-0016-mcp-probes.test.ts: 1',
  'migration-0017-cached-repos-submodules.test.ts: 1',
  'migration-0021-task-name.test.ts: 1',
  'migration-0022-wrapper-progress.test.ts: 1',
  'migration-0023-rfc041.test.ts: 1',
  'migration-0024-distill-capture.test.ts: 1',
  'migration-0025-injected-memories.test.ts: 1',
  'migration-0026-port-validation-failures.test.ts: 1',
  'migration-0027-distill-output-lang.test.ts: 1',
  'migration-0028.test.ts: 3',
  'migration-0029-rfc056-cross-clarify.test.ts: 7',
  'migration-0030.test.ts: 5',
  'migration-0031-clarify-rounds.test.ts: 8',
  'migration-0032-rfc059-question-scopes.test.ts: 1',
  'migration-0033-task-git-identity.test.ts: 4',
  'migration-0034-task-repos.test.ts: 5',
  'migration-0037-output-kind.test.ts: 2',
  'migration-0038-backfill-review-kind.test.ts: 1',
  'migration-0039-rfc075.test.ts: 5',
  'migration-0040-rfc074-consumed-runs.test.ts: 4',
  'migration-0041-rfc074-drop-cci.test.ts: 3',
  'migration-0042-rfc079-doc-versions.test.ts: 1',
  'migration-0043-shard-value-hash.test.ts: 3',
  'migration-0044-rerun-cause.test.ts: 4',
  'migration-0057-rfc115-drop-agent-params.test.ts: 5',
  'migration-0058-rfc115-drop-agent-snapshot.test.ts: 5',
  'migration-0090-rfc170.test.ts: 2',
  'migration-0092-rfc178.test.ts: 2',
  'migration-0098-rfc204-repo-cred.test.ts: 1',
  'migration-0102-rfc210-submodule-isolation.test.ts: 1',
  'migration-0104-rfc211-drop-onboarding.test.ts: 1',
  'migration-0111-rfc223.test.ts: 5',
  'migration-0112-rfc223-pr2.test.ts: 2',
  'migration-0113-rfc223-pr3.test.ts: 2',
  'migration-0114-rfc225-workgroup-version.test.ts: 2',
  'migration-0115-rfc223-pr3a-terminal.test.ts: 2',
  'migration-0116-rfc223-skill-identity.test.ts: 2',
  'migration-0117-rfc223-fusion-provenance.test.ts: 3',
  'migration-0118-rfc223-owner-scoped-names.test.ts: 2',
  'migration-0119-rfc224-opencode-session-owners.test.ts: 2',
  'migration-0120-rfc224-runtime-probe-fence.test.ts: 1',
  'migration-0121-rfc227-opencode-provenance.test.ts: 1',
  'migration-0122-rfc229-workgroup-message-trigger.test.ts: 1',
  'migration-0124-rfc235-intent-turn-session.test.ts: 1',
  'migration-0125-rfc238-mcp-runtime-playground.test.ts: 1',
  'migration-0128-rfc244-task-list-indexes.test.ts: 3',
  'migration-0138-rfc257-webhook-triggers.test.ts: 1',
  'migration-0144-rfc276-runtime-hardening-deprecation.test.ts: 2',
  'migration-0150-rfc292-trigger-namespace.test.ts: 1',
  'migration-0151-rfc285-workflow-soft-link.test.ts: 1',
  'migration-0152-rfc293-intent-workbench.test.ts: 1',
  'migration-0155-rfc301-task-launch-origin.test.ts: 1',
  'migration-0156-rfc300-workspace-prune-cause.test.ts: 1',
  'migration-0157-rfc303-mr-terminal-control.test.ts: 1',
  'migration-0162-rfc305-user-permissions.test.ts: 1',
  'migration-0173-rfc308-workspace-profile.test.ts: 1',
  'migration-0188-rfc312-presence-grant.test.ts: 1',
  'migration-0193-rfc310-custom-event-sources.test.ts: 1',
  'migration-0194-rfc310-unified-event-delivery.test.ts: 2',
  'migration-0195-rfc310-work-start-lifecycle-events.test.ts: 1',
  'migration-0196-rfc310-task-event-delivery-link.test.ts: 1',
  'migration-0197-rfc310-event-response-rules.test.ts: 1',
  'migration-0198-rfc310-event-catalog-visibility.test.ts: 1',
  'migration-0202-rfc315-event-automation-permissions.test.ts: 1',
  'migration-0203-task-catalog-visibility.test.ts: 1',
  'migration-0205-rfc310-task-employee-case-link.test.ts: 1',
  'migration-0206-rfc310-employee-case-name.test.ts: 1',
  'migration-0208-rfc321-repository-transport-credentials.test.ts: 1',
  'migration-0218-rfc341-committed-events.test.ts: 1',
  'migration-0219-rfc341-task-cutover.test.ts: 1',
  'migration-0220-rfc341-committed-delivery-fk-repair.test.ts: 1',
  'migration-0221-rfc342-memory-scope-move-events.test.ts: 1',
  'migration-0222-rfc341-collaboration-cutover.test.ts: 2',
  'opencode-session-walk.test.ts: 1',
  'rerun-prior-output-e2e.test.ts: 1',
  'resume-multi-repo-rollback.test.ts: 1',
  'resume-task-idempotent.test.ts: 1',
  'review-cancel-concurrency.test.ts: 1',
  'review-clarify-question-phase-stranded.test.ts: 1',
  'review-iterate-comments-in-prompt.test.ts: 1',
  'review-iterate-drops-prior-clarify-history.test.ts: 1',
  'review-iterate-file-path-in-prompt.test.ts: 1',
  'review-iterate-sibling-cascade.test.ts: 1',
  'review-state-machine.test.ts: 1',
  'reviews-iterate-mints-new-run.test.ts: 1',
  'rfc074-prc-cci-retirement.test.ts: 1',
  'rfc092-followup-chain-rollback.test.ts: 1',
  'rfc092-leaked-pending-bounded.test.ts: 1',
  'rfc092-midrun-clarify-dispatch.test.ts: 1',
  'rfc092-midrun-review-iterate.test.ts: 1',
  'rfc093-db-tx-sync.test.ts: 1',
  'rfc095-wrapper-canceled-revival.test.ts: 1',
  'rfc096-retry-cascade-inherit.test.ts: 1',
  'rfc097-cancel-wins.test.ts: 1',
  'rfc097-pending-orphan-reap.test.ts: 1',
  // RFC-359 AC-1（第 8 刀）：`1 → 2`，同一刀里另有 `lifecycle-repair-harness.ts: 1` **清零**。
  // harness 那一条是真收敛：它托着的 12 个行为套件从「自己 `createInMemoryDb`」改成由
  // `describeEachProvider` 的 lane 交库，于是同一批断言落到两个真引擎上。
  // 这一条 +1 是那次改动的**代价面**：本文件的反面对照用例（「没有活调度器的 running 任务
  // 不该被门拦」）借的正是那个 harness，harness 不再自己建库之后，它得自己建一个——
  // 而这条用例本来就只跑 SQLite（真 `resumeTask` + 桩 opencode 二进制 + 进程内活跃度注册表），
  // 不是新的单引擎判据。
  'rfc097-repair-liveness.test.ts: 2',
  'rfc097-resume-mutex.test.ts: 1',
  // RFC-359 AC-6 销账：`rfc097-task-status-cas.test.ts` 迁到 `describeEachProvider`，
  // 唯一那处 `createInMemoryDb` 随之消失（36 例 → 两引擎各 36 例）。
  'rfc098-commitpush-nonblocking.test.ts: 1',
  'rfc098-fanout-consumed-gate.test.ts: 1',
  'rfc098-fanout-shard-hash-rerun.test.ts: 1',
  'rfc098-git-predirty-diff.test.ts: 1',
  'rfc098-git-wrapper-diff-fail.test.ts: 1',
  'rfc098-process-governance.test.ts: 1',
  'rfc098-wrapper-revival-e2e.test.ts: 1',
  'rfc098-wrapper-stale-redispatch.test.ts: 1',
  'rfc099-migration-0045.test.ts: 1',
  'rfc107-url-upload-multipart.test.ts: 3',
  'rfc108-resume-safety.test.ts: 1',
  // RFC-359 AC-1（第 13 刀下）**销账**：`syncWorkflow` 两个引擎合一之后，这套 RFC-109 的
  // 回归判据整套迁到 `describeEachProvider` + 生产装配，单引擎那一格随之消失。
  'rfc122-clarify-directive-dispatch.test.ts: 2',
  'rfc130-crash-replay.test.ts: 1',
  'rfc130-merge-agent-scheduler.test.ts: 1',
  'rfc130-shard-rerun-undo.test.ts: 4',
  'rfc130-wrapper-private-canonical.test.ts: 1',
  'rfc131-review-reject-aging-prior-output.test.ts: 1',
  'rfc142-review-rounds.test.ts: 2',
  'rfc144-migration-0076.test.ts: 1',
  'rfc144-stale-replay-regression.test.ts: 2',
  'rfc145-migration-0077.test.ts: 2',
  'rfc145-write-side.test.ts: 1',
  'rfc152-ws-channel-registry.test.ts: 2',
  'rfc162-migration-0081.test.ts: 1',
  'rfc165-agent-launch.test.ts: 5',
  'rfc165-migration-0085.test.ts: 1',
  'rfc165-scheduled-kinds.test.ts: 3',
  'rfc165-scratch-space.test.ts: 1',
  'rfc167-dw-e2e.test.ts: 2',
  'rfc167-dynamic-workflow-engine.test.ts: 3',
  'rfc186-workgroup-e2e.test.ts: 1',
  'rfc187-fanout-salvage-e2e.test.ts: 1',
  'rfc187-workgroup-e2e.test.ts: 1',
  'rfc189-wg-round.test.ts: 1',
  'rfc193-force-include.test.ts: 1',
  'rfc193-port-artifacts.test.ts: 1',
  'rfc193-wrapper-review.test.ts: 1',
  'rfc199-start-task-workflow-race.test.ts: 1',
  'rfc204-cached-repo-wire-and-reuse.test.ts: 3',
  'rfc204-cold-clone-seal.test.ts: 2',
  'rfc212-revalidation-behavior.test.ts: 13',
  'rfc213-pending-restore.test.ts: 1',
  'rfc213-restore.test.ts: 3',
  'rfc217-migration-0107.test.ts: 1',
  'rfc217-workgroup-task-state.test.ts: 1',
  'rfc218-agent-launch-ports.test.ts: 5',
  'rfc220-oauth2-provider-schema-service.test.ts: 1',
  'rfc220-presented-name-sync.test.ts: 3',
  'rfc221-auth-policy.test.ts: 10',
  'rfc222-task-delete.test.ts: 1',
  'rfc223-pr2-refs.test.ts: 2',
  'rfc223-pr3b-dynamic-token.test.ts: 2',
  'rfc223-pr5-boot-restore-wiring.test.ts: 3',
  'rfc223-pr9-cross-tenant-adversarial.test.ts: 5',
  'rfc228-agent-resource-integrity.test.ts: 1',
  'rfc230-wrapper-finalize-superseded.test.ts: 1',
  'rfc238-mcp-runtime-test-transitions.test.ts: 6',
  'rfc243-call-workflow.test.ts: 3',
  'rfc243-call-workgroup.test.ts: 1',
  'rfc243-list-child-count.test.ts: 2',
  'rfc243-parent-child-lifecycle.test.ts: 12',
  'rfc248-materialize-group.test.ts: 1',
  'rfc248-migration-repo-groups.test.ts: 3',
  'rfc248-readonly-dirty-visible.test.ts: 1',
  'rfc249-migration-repo-group-nodes.test.ts: 1',
  'rfc257-webhook-error-codes.test.ts: 1',
  'rfc261-webhook-delivery-pagination.test.ts: 2',
  'rfc266-script-pool-independence.test.ts: 1',
  'rfc268-webhook-scratch-launch.test.ts: 1',
  'rfc269-code-host-connections.test.ts: 4',
  'rfc269-webhook-code-host-context-e2e.test.ts: 2',
  'rfc269-webhook-trigger-context-atomicity.test.ts: 1',
  'rfc274-workgroup-output-messages.test.ts: 1',
  'rfc275-schema-admission.test.ts: 4',
  'rfc276-readonly-script-stall-regression.test.ts: 1',
  'rfc278-legacy-schema-reconciliation.test.ts: 2',
  'rfc279-database-redundancy-cleanup.test.ts: 1',
  'rfc282-d2-granted-ids-single-source.test.ts: 1',
  'rfc284-batchc-resource-dedup.test.ts: 5',
  'rfc287-t13-deferred-prep.test.ts: 27',
  // RFC-359 AC-6 销账：`rfc291-closure-call-edges.test.ts` 的最后一处 `createInMemoryDb` 随
  // `registerNativeCases` 一起删除——freeze/dump 同解两条上了双引擎（被
  // `freezeCallClosure(db: DbClient)` 那个残留品牌标注钉住，形参放宽即解），
  // 剩下的「复杂度与收口」是纯源码文本断言、一行库都不读。9 例 → 17 例（8×2 + 1）。
  'rfc291-unavailable-mount.test.ts: 1',
  'rfc294-task-execution-compat-oracles.test.ts: 1',
  'rfc295-downgrade-audit.test.ts: 2',
  'rfc300-webhook-workspace-cleanup-e2e.test.ts: 2',
  'rfc300-workspace-prune.test.ts: 1',
  'rfc301-task-launch-origin-inheritance.test.ts: 1',
  'rfc303-node-revival-fence.test.ts: 1',
  'rfc303-verified-ingress.test.ts: 1',
  'rfc305-architecture-lock.test.ts: 1',
  'rfc305-user-access-integration.test.ts: 1',
  'rfc306-scheduler-branch.test.ts: 1',
  'rfc309-template-merge-migration.test.ts: 1',
  'rfc310-digital-employee-human-review-system-mock-e2e.test.ts: 1',
  'rfc310-pr4-execution-host.test.ts: 1',
  'rfc310-pr4-profile-identity.test.ts: 1',
  'rfc311-backup-concurrency.test.ts: 1',
  'rfc311-backup-worker-fallback.test.ts: 5',
  'rfc311-branch-started-at-maintenance.test.ts: 2',
  'rfc311-perf-foundation.test.ts: 10',
  'rfc311-repos-page.test.ts: 1',
  'rfc311-retention-sweep.test.ts: 1',
  'rfc311-task-page-fastpath.test.ts: 1',
  'rfc312-default-grant.test.ts: 1',
  'rfc312-impl-gate-fixes.test.ts: 5',
  'rfc312-presence-channel.test.ts: 3',
  'rfc312-t0-upgrade-dedup.test.ts: 4',
  'rfc313-session-escalation.test.ts: 1',
  'rfc314-autokill-stall-window.test.ts: 1',
  'rfc314-session-view-window.test.ts: 1',
  'rfc317-cross-context-ports.test.ts: 3',
  'rfc319-fusion-manifest-merge-back.test.ts: 1',
  'rfc321-repository-transport-http.test.ts: 1',
  'rfc326-review-decision-transaction.test.ts: 1',
  'rfc326-tx-primitives-equivalence.test.ts: 2',
  'rfc330-migration-backfill.test.ts: 1',
  'rfc333-migration-human-gate-operations.test.ts: 4',
  'rfc335-oidc-git-name-migration.test.ts: 1',
  'rfc336-employee-case-advanced-migration.test.ts: 1',
  'rfc338-maintenance-slices.test.ts: 4',
  'rfc341-committed-event-store.test.ts: 1',
  'rfc347-identity-access-runtime.test.ts: 4',
  'rfc349-boolean-expression-parity.test.ts: 1',
  'rfc349-collaboration-runtime-mechanics.test.ts: 1',
  'rfc349-daemon-provider-core.test.ts: 1',
  'rfc349-database-migration-coordinator.integration.test.ts: 3',
  'rfc349-database-operational-adapter.test.ts: 1',
  'rfc349-digital-employee-platform-tools-wiring.test.ts: 1',
  'rfc349-dual-provider-behavior-oracle.test.ts: 3',
  'rfc349-identity-access-promise-contract.test.ts: 2',
  'rfc349-maintenance-disk-provider.test.ts: 1',
  'rfc349-maintenance-execution-fence.test.ts: 1',
  'rfc349-null-ordering-parity.test.ts: 1',
  'rfc349-postgresql-logical-migration.integration.test.ts: 1',
  'rfc349-provider-search-case-parity.test.ts: 1',
  'rfc349-safety-backup-off-thread-verify.test.ts: 1',
  'rfc349-source-control-provider-adapters.test.ts: 2',
  'rfc349-sqlite-logical-source.test.ts: 3',
  'rfc349-sqlite-migration-compatibility.test.ts: 2',
  'rfc349-task-execution-provider-adapters.test.ts: 3',
  // RFC-359 AC-6 销账：`rfc349-websocket-provider.test.ts` —— 那对「真 SQLite + 假池 PG」的
  // 手搓孪生合成一条双引擎。`DrizzleRealtimeStore` 的形参本来就是 `ProviderNeutralDatabase`
  // （一份实现），两条用例只是喂了两种库；合并后同一份真数据、同一组断言跑两个引擎，
  // `sqlRows` / `postgresqlFixture` 假池随之删除。5 例 → 7 例。
  'rfc351-sqlite-write-transaction-immediate.test.ts: 1',
  'rfc354-clarify-idle-skip.test.ts: 1',
  'rfc354-nested-depth3-frames.test.ts: 1',
  'rfc354-nested-failure-modes.test.ts: 1',
  'rfc354-nested-frames-closure.test.ts: 1',
  'rfc354-nested-loop-frames.test.ts: 1',
  'rfc357-provider-portability.test.ts: 1',
  'rfc359-database-transaction.test.ts: 1',
  'rfc359-engine-capabilities.test.ts: 1',
  'rfc359-execution-contract-resource-adapter.test.ts: 1',
  'rfc359-t19h-generation-upgrade.test.ts: 4',
  'rfc359-t19h-logical-backup-restore.test.ts: 1',
  'rfc359-t19h-postgresql-upgrade.integration.test.ts: 1',
  'rfc359-task-execution-read-models.test.ts: 1',
  'rfc359-w14-agent-commit-sequence.test.ts: 1',
  'rfc359-w16-task-lifecycle-write-sequence.test.ts: 1',
  'rfc359-w25-task-page-bounded-prefix.test.ts: 1',
  'rfc359-w36-skill-operation-state-query.test.ts: 1',
  'rfc359-w6-t26-postgresql-plan-audit.test.ts: 1',
  'rfc359-w7-catalog-composition-roots.test.ts: 1',
  'rfc359-w8-logical-source-conformance.test.ts: 1',
  'rfc359-w8-migrator-conformance.test.ts: 1',
  'runner-subagent-live-capture.test.ts: 6',
  'scheduler-audit-gap1-limits-resume-startedat.test.ts: 1',
  'scheduler-audit-gap4-loop-exit-out-of-scope-port.test.ts: 1',
  'scheduler-audit-s02-multirepo-retry-rollback-noop.test.ts: 1',
  'scheduler-audit-s07-s28-wrapper-consumed-status.test.ts: 1',
  'scheduler-audit-s08-runtask-no-cas-revival.test.ts: 1',
  'scheduler-audit-s10-async-transaction-decorative.test.ts: 1',
  'scheduler-audit-s21-fanout-aggregator-idempotency.test.ts: 1',
  'scheduler-audit-s22-canceled-retry-stall.test.ts: 2',
  'scheduler-boundary-canceled-fanout-status.test.ts: 1',
  'scheduler-boundary-resume-retryindex-vs-id.test.ts: 1',
  'scheduler-commit-push.test.ts: 1',
  'scheduler-default-retries.test.ts: 1',
  'scheduler.test.ts: 1',
  'session-capture-sqlite.test.ts: 4',
  'start-task-multi-repo-gates.test.ts: 1',
  'start-task-url.test.ts: 1',
  'structural-diff-callchain-multi-repo.test.ts: 1',
  'structural-diff-node-multi-repo.test.ts: 1',
  'subagent-live-capture.test.ts: 4',
  'task-diff-multi-repo-truncation.test.ts: 1',
  'task-diff-multi-repo.test.ts: 1',
  'task-start-git-identity.test.ts: 1',
  'task-start-pre-worktree.test.ts: 1',
  'task-start-working-branch.test.ts: 1',
  'upgrade-rolling.test.ts: 7',
]

/**
 * 「在测试里直接造一个 SQLite 库」的两种写法。**两种都要数**：
 *
 *   - `createInMemoryDb(` —— 仓内的测试夹具工厂，绝大多数单引擎判据走这条；
 *   - `new Database(` —— 直接用 `bun:sqlite`，**绕过夹具**。
 *
 * 判据初版只数前一条，于是后一条整类在网外：实测（RFC-359 W7，2026-09-07）非迁移测试里
 * 还有 95 处 / 55 个文件走 `new Database(`，它们写出来的判据同样只验证 SQLite，
 * 而守卫一声不吭。**只堵一个入口的守卫等于没堵**——想绕的人（或者只是不知道夹具存在的人）
 * 自然会落到另一个入口上。
 *
 * 迁移测试（`migration-*.test.ts`）**不豁免**，口径与既有账本保持一致：它们本来就有 46 条
 * `createInMemoryDb` 记在账上。迁移 DDL 确实只对 SQLite 有意义（PostgreSQL 的 schema 来自
 * drizzle 声明，见 `rfc359-w5-t19g-schema-contract-reconciliation.test.ts`），但那是「这条债
 * 为什么合理」的理由，不是「不必计数」的理由——高水位账本记的是存量，不是过错。
 */
const SINGLE_ENGINE_CONSTRUCTION = /\bcreateInMemoryDb\(|\bnew Database\(/g

/**
 * 一个文件里的真调用点数。**按 AST 数，不按文本数**——判据说的是「调用点」，那就只认
 * 真正会执行的调用：`createInMemoryDb(...)` 的调用表达式、`new Database(...)` 的构造表达式。
 *
 * 为什么换掉纯文本扫描：文本扫描认不出注释和字符串，于是**写字也算欠债**。实测踩到三处
 * （2026-09-13）：`backup.test.ts` 的一行注释里提到 `new Database()`；
 * `createindb-snapshot-parity.test.ts` 的文件头注释两次提到 `createInMemoryDb()`——它正是
 * 锁这个工厂的快照优化的用例，绕不开要写出名字；`subagent-live-capture-source.test.ts` 的
 * `expect(src).not.toContain('new Database(')`——一条**禁止**建库的源码断言，被记成了建库。
 * 这类误计不只是数字不准：它让「把账本改到 0」这件事**做不到**——除非去改那些本该这么写的
 * 注释与断言。本守卫自己之前也因此不得不自我豁免。这条坑在本 RFC 已经重复踩到第五次，
 * 所以改的是判据本身，不是那几个文件的措辞。
 *
 * **模板字面量仍然数**：worker 源码经常以模板串写在用例里再落盘执行
 * （`e2e-sqlite-fixture-lock-contention.test.ts` 的 `HOLDER_SOURCE` 就是），那是货真价实的
 * 单引擎构造，只是推迟到子进程。不数它等于给「把单引擎测试搬进字符串」开一个后门。
 */
function countCallSites(rel: string, text: string): number {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let hits = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createInMemoryDb'
    ) {
      hits += 1
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Database'
    ) {
      hits += 1
    } else if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      hits += (node.text.match(SINGLE_ENGINE_CONSTRUCTION) ?? []).length
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

let cachedRows: readonly string[] | undefined

/**
 * `<路径>: <调用点数>`，字典序。整棵树只读一遍并缓存——全树源码扫描类守卫不缓存的话，
 * 每个用例都重读一遍，CI 上按秒累加（`docs/dev-gotchas.md` 记过这条）。
 * 2103 个文件全解析一遍实测 ~1.5s，落在下面那条 30s 预算里还有充足余量。
 */
function callSiteRows(): readonly string[] {
  if (cachedRows !== undefined) return cachedRows
  const rows: string[] = []
  for (const rel of CORPUS_FILES) {
    if (EXEMPT.has(rel)) continue
    const hits = countCallSites(rel, readFileSync(join(TESTS, rel), 'utf8'))
    if (hits > 0) rows.push(`${rel}: ${hits}`)
  }
  cachedRows = rows.sort()
  return cachedRows
}

/**
 * **为什么光有一条「还剩多少」的总账不够。**
 *
 * 上面那本账把「还没迁」和「按裁决就该单引擎」混在同一个数字里，于是它只能回答「有多少行」，
 * 回答不了接手的人真正要问的那句：**这一行是债，还是本来就这样？** 一个读到 400 多行的人，
 * 要么以为还有 400 多个待办（士气税），要么反过来把所有行都当成「反正都是历史包袱」（守卫失效）。
 *
 * 所以下面按**机械可判**的理由把总账切开。分类**故意不做人工标注**——人工标注会退化成
 * 「谁都能给自己新写的那条编一个理由」，守卫就白上了。判据全部落在文件内容上：
 *
 * · `migration-chain` —— 判的就是 **SQLite 迁移链本身**（`db/migrations/*.sql` 的逐条行为）。
 *   PostgreSQL 侧有自己的迁移序列（`postgresqlMigrationSequence.ts`）与对账守卫
 *   （`rfc359-w5-t19g`），两条链本来就不共用一份用例。
 * · `sqlite-execution-engine` —— 驱动 **SQLite 那台执行引擎**（`runTask` / 测试拓扑 /
 *   `services/task`）。`TaskRouteOperations` 这一对早已被本 RFC 判为「不该合」，PostgreSQL 生产
 *   走的是 `taskExecutionProvider.cancellation`，根本不经过这条路径。
 * · `real-file-database` —— `new Database(` 开的是**磁盘上的真库**（备份 / 还原 / `VACUUM INTO` /
 *   外部 store）。这类判据的被测物就是 SQLite 文件格式本身。
 * · `sqlite-only-primitive` —— 用了 bun:sqlite 独有的面：`$client` 仪器（语句计数、
 *   `EXPLAIN QUERY PLAN`）、`PRAGMA`、同步事务原语 `dbTxSync`。
 *
 * 剩下的就是 `OPEN_MIGRATION_DEBT`：**没有任何机械理由**留在单引擎上的文件。这才是待办量，
 * 也是唯一需要往下压的数字。它同样只降不升——新写一条没有正当理由的单引擎判据会让它变长。
 */
/**
 * 判据跑在**剥掉注释**的 token 流上，不是裸文本。`rfc305-architecture-lock` 的注释里就写着
 * `db.$client`（那段注释正是在解释「裸文本扫描会撞上自己」），裸扫会把它误判成用了裸驱动、
 * 于是把一条真待办悄悄挪进 sanctioned——**分类判据放松的方向恰好是让数字变好看的方向**，
 * 所以这里宁可多花一次解析。token 之间用空格拼回，因此下面所有判据都写成容忍空白的形式。
 */
function codeOnly(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text)
  const parts: string[] = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    parts.push(scanner.getTokenText())
  }
  return parts.join(' ')
}

const SANCTIONED_SINGLE_ENGINE: readonly {
  readonly id: string
  readonly holds: (rel: string, code: string) => boolean
}[] = [
  {
    id: 'migration-chain',
    holds: (rel) => /(^|\/)migration-\d/.test(rel) || /rfc\d+-migration-\d/.test(rel),
  },
  {
    /**
     * RFC-359 AC-1（第 11 刀下半）—— **补两条同义拼法**，理由与 `frozen-migration-revision`
     * 那条一样：判据认的是「这条测试驱动的是 SQLite 那台执行引擎」这个**概念**，
     * 而它此前只认三种拼法，于是同一个概念换个写法就看不见了。
     *
     * 触发点：cancel 合一把 `from 'services/task'` 这条拼法从四份判据上摘掉了
     *（它们 import 它就是为了取 `cancelTask`）。其中三份摘掉之后**确实**不再依赖那台引擎，
     * 已随本刀迁到 `describeEachProvider`；`rfc268-webhook-scratch-launch` 不然——
     * 它照生产装配跑的是 `composeTaskExecutionTestRuntime` +
     * `createSqliteTaskExecutionLaunchParticipant`（经 `createSqliteWebhookTaskExecutionParticipant`），
     * 那是 SQLite 的**启动参与者**，换 PG 要等启动面的 cutover。
     *
     * 补的两条都是「名字里就写着 SQLite 执行面」的直接证据，不是为某个文件量身定做：
     * `composeTaskExecutionTestRuntime` 与已认的 `createTaskExecutionTestTopology`
     * 出自**同一个 helper 模块**；`createSqlite*TaskExecutionParticipant` 是具名的
     * SQLite 启动装配。
     */
    id: 'sqlite-execution-engine',
    holds: (_rel, code) =>
      /(?<![A-Za-z0-9_.])runTask\s*\(/.test(code) ||
      code.includes('createTaskExecutionTestTopology') ||
      code.includes('composeTaskExecutionTestRuntime') ||
      /createSqlite[A-Za-z]*TaskExecution[A-Za-z]*Participant/.test(code) ||
      /from\s*'(@\/|(\.\.\/)+src\/)services\/task'/.test(code),
  },
  {
    /**
     * RFC-359 AC-6（2026-09-16，plan §5gd）—— **在某条迁移之前冻住的 schema** 上跑的判据。
     *
     * 为什么它该是 sanctioned 而不是债：这类用例测的是**迁移自己的回填口径**
     * （「0095 之前的行，回填之后应该长什么样」），所以它必须把库停在那一条迁移**之前**。
     * 迁移链是**两套各自落盘的工件**（§5fq ②，与 `util/migrationsFolder.ts` / `embed.ts`
     * 同一条理由），SQLite 那条链上的第 N 条回填，按定义只能在 SQLite 的链上验。
     *
     * 为什么原来的 `migration-chain` 判据漏了它：那一条按**文件名**匹配
     * （`migration-\d` / `rfc\d+-migration-\d`），而这个文件叫 `rfc189-wg-round.test.ts`
     * ——它**做的是**迁移回填对账，名字里却没有 `migration`。按文件名分类，
     * 分到的是「谁起的名字好」，不是「它在测什么」。这一条改按**call shape** 认：
     * 建库时喂的不是那份规范迁移目录，而是一份被截断 / 冻结过的副本。
     */
    id: 'frozen-migration-revision',
    holds: (_rel, code) =>
      /createInMemoryDb\s*\(\s*partial\b/.test(code) ||
      code.includes('partialMigrationsDir') ||
      /_journal\.json/.test(code) ||
      // RFC-359 AC-6 补一条同义拼法：冻结那段后来抽成了共享 helper
      // `tests/migration-freeze.ts#freezeAt(idx)`（逐字同一件事：截断 journal + 拷贝前缀
      // 到临时目录）。抽出去之后，消费它的文件里**不再出现** `partial` / `_journal.json`
      // 这些内联痕迹，于是上面三条拼法一条都咬不到——**判据认拼法不认概念**的老毛病，
      // 本 RFC 这一天里第三次撞（前两次见 `sqlite-execution-engine` 补 `composeTaskExecutionTestRuntime`、
      // 与 `implementsPort` 收紧那两段）。
      /(?<![A-Za-z0-9_.])freezeAt\s*\(/.test(code),
  },
  {
    /**
     * RFC-359 AC-6 —— 被测物是**某个 provider 自己的组合根 / 装配面**。
     *
     * `compose{Sqlite,Postgresql}<Name>` 这一族按定义只在一侧存在：SQLite 的
     * `AppDeps`（`createApp` 收 `DbClient`）、`composeSqliteDynamicWorkflowValidationContext`
     * （装的是 legacy 同步 loader）、`composeSqlitePostRestoreRecovery`（`recover` 签名点名
     * `DbClient`）……另一侧的同名能力有**它自己的**组合根用例（`rfc359-w7-*-composition-roots`
     * 两侧各一批）。把这种用例塞进 `describeEachProvider`，等于要求一侧去构造一个它按设计
     * 就没有的装配面。
     *
     * **这一类与「还没迁」的区别在被测物**：如果被测的是**实现**（投影 / 命令 / 持久化），
     * 那它该双引擎；只有当被测的就是「这一侧的装配长什么样」时才落这一类。
     * 判据因此认的是「**调用**了 provider 具名的组合根」，不是「提到过」。
     */
    id: 'provider-composition-root',
    holds: (_rel, code) =>
      /(?<![A-Za-z0-9_.])compose(?:Sqlite|Postgresql)[A-Za-z]*\s*\(/.test(code),
  },
  {
    /**
     * RFC-359 AC-6 —— **一个 transcript 里同时驱动两个引擎**的跨 provider 对拍。
     *
     * `describeEachProvider` 的形状是「同一段 body 各跑一遍」，而这一类要的恰恰相反：
     * 它在**同一条用例**里既建 SQLite 库、又建真 PostgreSQL 客户端，然后断言两侧对同一段
     * 剧本给出同一个答案（RFC-349 AC-12 的行为 transcript、以及 T5/C2 的 Promise 归属
     * 与 owner 元组围栏）。把它塞进双引擎 harness 等于把对拍拆成两半，判别力当场归零。
     *
     * 判据认「文件里**同时**出现 SQLite 建库与真 PG 客户端构造」——两者缺一都不算，
     * 所以它咬不到「只跑 SQLite、顺便 import 了个 PG 类型」的普通单引擎判据。
     */
    id: 'cross-provider-oracle',
    holds: (_rel, code) =>
      /(?<![A-Za-z0-9_.])createInMemoryDb\s*\(/.test(code) &&
      /(?<![A-Za-z0-9_.])createPostgresqlDatabaseClient\s*\(/.test(code),
  },
  {
    id: 'real-file-database',
    holds: (_rel, code) => /(?<![A-Za-z0-9_.])new\s+Database\s*\(/.test(code),
  },
  {
    // 能力矩阵里**同步**的那一格。`readAuthorityFence` 是 WS 发帧热路径上的同步读——帧要在
    // 当前 tick 内定夺，改 async 会让判定落到下一个微任务、而帧那时已经发出去了。它建在
    // `EngineCapabilities.readRowSync` 上，而那一格**只有 bun:sqlite 给得出**（PostgreSQL 的
    // 实现返回 undefined，围栏退回进程内的 `AuthorityFenceCache`——RFC-349 的单 daemon 世代
    // 前提下那份缓存**就是**围栏本身）。断言「直接改库之后同步读立刻看得见」按定义只在 SQLite
    // 上成立，拿双引擎 harness 跑它等于要求 PG 具备一个它按设计就没有的能力。
    id: 'sync-engine-capability',
    holds: (_rel, code) => /(?<![A-Za-z0-9_.])readAuthorityFence\s*\(/.test(code),
  },
  {
    /**
     * RFC-359 AC-6（2026-09-16，plan §5gk）—— **被测物是模块级路由注册表**的那一类。
     *
     * 这类用例装一个应用**只为了**拿到「路由 → 权限」那张声明表，然后审这张表
     * （`allRouteMeta()`）；库只是让应用能装起来的脚手架，一条断言都不落在库上。
     *
     * 为什么它该是 sanctioned：那张表**与引擎无关**——两个组合根都汇进同一个
     * `createComposedApp` → 同一个 `mountApiRoutes`。而这件事**不再只是读源码论证**：
     * `rfc359-w5-composition-root-route-surface` 把两个根都装出来逐字比过
     * （连 `tokenAccess` 与权限集合一起比），结论是相等。拿双引擎跑这类用例，
     * 量到的是同一张表两遍。
     *
     * 判据的边界：它只认「文件里出现 `allRouteMeta(`」。真正让分类站得住的是上面那条
     * 新守卫——**它红了，这条判据的前提就没了**，届时这一类要跟着重判，而不是接着豁免。
     */
    id: 'provider-independent-route-registry',
    // `codeOnly` 按 token 重拼、token 之间补空格，所以 `allRouteMeta()` 在这里是
    // `allRouteMeta ( )`——写成 `includes('allRouteMeta(')` 只会**碰巧**命中字符串字面量里的
    // 那一份（源码层断言的文本），调用点本身反而漏掉。一律用带 `\s*` 的正则。
    holds: (_rel, code) => /allRouteMeta\s*\(/.test(code),
  },
  {
    /**
     * RFC-359 AC-6（2026-09-16，plan §5gk）—— **一对 provider 组合根，两半都按名覆盖**。
     *
     * `rfc349-daemon-provider-core` 是这形状：一条用例叫「SQLite composes the same closed
     * surface…」驱动 `composeSqliteDaemonProviderCore`，紧挨着的另一条叫「PostgreSQL composes
     * without SQL/openDb…」驱动 `composePostgresqlDaemonProviderCore`。
     *
     * 这条判据认的是**那个直建 SQLite 库的调用点有正当理由**：它的被测物是
     * `composeSqliteX` 这个**只存在于 SQLite 的组合函数**，换个引擎根本没有这个东西可测，
     * 所以它不是「还没迁的债」。两半断言的也是**不同的事**（谁拥有客户端生命周期），
     * 塞进一个 `describeEachProvider` 反而要靠 `capabilities` 分叉回去。
     *
     * **它不保证另一半跑的是真 PostgreSQL。** 本判据只看「同一对的两半都被驱动了」；
     * 当前命中的这个文件，PG 那半走的是本地手搓的 `postgresqlFixture()`——一个记录 SQL 文本、
     * 回罐头行的**假池**。假池的覆盖力弱得多（列名写错、少个 schema 限定、类型不对、
     * 真约束冲突，它一律照单全收），那是**另一条要还的债**，按文件清点与处置见 plan §5gn。
     * 两件事分开记：这里记的是「SQLite 那个调用点该不该留」，§5gn 记的是「PG 那半够不够真」。
     *
     * 判据按**配对**认：同一个 X 上 `composeSqliteX(` 与 `composePostgresqlX(` 都出现。
     * 今天它只命中一个文件，但它认的是**结构**而不是某个文件的特征串——此后任何
     * 「一对 provider 组合根各验各的」都自动落进来。
     *
     * 特意**没有**放宽成「文件里出现任意 `composeSqlite*(`」：那样会一口气把 6 个债务文件
     * 划成豁免，而其中只有这一个真的两半都覆盖了。§5gi 刚纠正过同一个毛病——
     * 「共用一个语法形状」不等于「共用一个根因」。
     */
    id: 'provider-pair-covered-by-name',
    holds: (_rel, code) => {
      const sqlite = new Set(
        [...code.matchAll(/composeSqlite([A-Za-z]*)(?=\s*\()/g)].map((m) => m[1]),
      )
      return [...code.matchAll(/composePostgresql([A-Za-z]*)(?=\s*\()/g)].some((m) =>
        sqlite.has(m[1]),
      )
    },
  },
  {
    /**
     * RFC-359 AC-6（2026-09-16，plan §5gm）—— **判据文本是 SQLite 的计划词汇**。
     *
     * `EXPLAIN QUERY PLAN` 的 detail 列（`TEMP B-TREE` / 具体索引名）是 SQLite 独有的一套词汇；
     * PostgreSQL 的 `EXPLAIN` 输出是另一套，同一条断言换引擎后**锁的不是同一件事**。
     * 同一批用例还必须用 SQLite 的位置占位符 `?`（PG 是 `$1`）——实现门要求在**绑定参数**下看计划，
     * 字面量下看不出展开式的退化。这是 §5fq ③「驱动线上差异」的标准形态。
     *
     * 要给 PostgreSQL 补同类守卫，走 `harness.explain()`（它按引擎各自渲染计划、且带真实绑定参数），
     * 而**不是**把这些断言改成双引擎——两个引擎的计划守卫本来就该是两条各自的判据。
     */
    id: 'sqlite-plan-vocabulary',
    holds: (_rel, code) => code.includes('EXPLAIN QUERY PLAN'),
  },
  {
    /**
     * RFC-359 AC-6（2026-09-16，plan §5gm）—— **注入机制**依赖 bun:sqlite 的同步执行面。
     *
     * 与上面几条不同：这一类里**被测代码本身是中立的**（而且同文件的双引擎格已经在两个引擎上
     * 各跑过一遍），单引擎的是**故障注入的机制**——用 `Proxy` 包住 DB 客户端，在同步的 `select`
     * 拦截器里当场改库。PostgreSQL 上 `.run()` 只返回一个没人 await 的 Promise，
     * 改库与随后那次读之间**没有任何定序**，判据会退化成掷骰子；
     * 按「第 N 次 select」钉阶段的那种注入，换引擎后那个序数指向的也不再是同一个阶段。
     *
     * 认的是结构（`new Proxy(` 包住一个现建的库），不是某个文件的特征串。
     */
    id: 'sync-client-fault-injection',
    holds: (_rel, code) => /new\s+Proxy\s*\(/.test(code) && /createInMemoryDb\s*\(/.test(code),
  },
  {
    id: 'sqlite-only-primitive',
    holds: (_rel, code) =>
      // `.$client` 取的是裸 bun:sqlite 句柄。**只关它不算**（§5cm：`$client.close()` 只是收尾，
      // 不构成「用了裸驱动面」），其余取用——`serialize()`、语句录制、`EXPLAIN QUERY PLAN`——都算。
      /\.\s*\$client\b(?!\s*\.\s*close\b)/.test(code) ||
      code.includes('PRAGMA') ||
      // `pragma_table_info(...)` 是同一张面的**函数**形态（SQLite 独有的 schema 自省；
      // PostgreSQL 对应的是 `information_schema`，形状与列名都不同）。大写的 `PRAGMA` 语句
      // 与它是一回事，判据不该只认其中一种写法。
      code.includes('pragma_table_info') ||
      /(?<![A-Za-z0-9_.])dbTxSync\s*\(/.test(code),
  },
]

/**
 * **注册期读 harness 的那一类错**（2026-09-13 推红 main 实撞，4 个分片同时红）。
 *
 * `harness.db` / `harness.session` / `harness.capabilities` 都是**惰性 getter**：库要等
 * `beforeEach` 建好才有，提前读会抛 `ProviderHarness 只能在 test 体内读取`。而 `describe` 的
 * 函数体是在**注册期**执行的——写在那里的 `const db = harness.db` 会在任何用例开始之前就跑。
 *
 * 为什么必须上守卫而不是靠 review：**本地单文件跑可能是绿的**。惰性 getter 抛不抛，取决于
 * 同进程里前一个文件是否刚好把状态留成非空；单跑一个文件、和在 CI 的分片里跟几十个文件一起跑，
 * 结果不一样。实撞那次本地 25 pass 全绿、CI 上四个分片同时红。
 *
 * 判据只认**立即求值**的读取：`const db = () => harness.db` 这种把读取推迟到调用时的写法是对的，
 * `test(...)` / `beforeEach(...)` 里的读取也是对的（回调晚于注册期执行）。
 */
function eagerHarnessReads(rel: string, text: string): string[] {
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const HARNESS_MEMBER =
    /(?<![A-Za-z0-9_.])(harness|scope\.harness)\s*\.\s*(db|session|capabilities)\b/
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text.startsWith('describeEachProvider')
    ) {
      const body = node.arguments.find(ts.isArrowFunction)
      if (body !== undefined && ts.isBlock(body.body)) {
        for (const statement of body.body.statements) {
          if (!ts.isVariableStatement(statement)) continue
          for (const declaration of statement.declarationList.declarations) {
            const initializer = declaration.initializer
            if (initializer === undefined) continue
            // a function initializer defers the read to call time — that is the correct shape
            if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) continue
            if (!HARNESS_MEMBER.test(initializer.getText(src))) continue
            const line = src.getLineAndCharacterOfPosition(statement.getStart(src)).line + 1
            found.push(`${rel}:${line}`)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return found
}

/** 纯判据：只看路径与内容，不碰磁盘——负 fixture 直接喂它伪造输入。 */
function sanctionFor(rel: string, text: string): string | null {
  const code = codeOnly(text)
  return SANCTIONED_SINGLE_ENGINE.find((entry) => entry.holds(rel, code))?.id ?? null
}

function sanctionOf(rel: string): string | null {
  let text: string
  try {
    text = readFileSync(join(TESTS, rel), 'utf8')
  } catch {
    return null
  }
  return sanctionFor(rel, text)
}

/**
 * 账本里**没有任何机械正当理由**的文件——真正的「还没迁」。按路径字典序，只降不升。
 *
 * 想把某一行从这里拿掉，只有两条路：**真把它迁到 `describeEachProvider`**，
 * 或者证明它落进上面某一类 sanctioned 理由（那要改的是判据，不是这张名单）。
 * **不要**为了让数字好看而往 `SANCTIONED_SINGLE_ENGINE` 里加一条只为某个文件量身定做的判据。
 */
export const OPEN_MIGRATION_DEBT: readonly string[] = [
  // RFC-359 AC-6（命名债清完后的一刀）**销四条**：
  //   · `start-task-deps` —— **真迁**。它被卡住的唯一原因是 `StartTaskDeps.db` 钉着
  //     `LegacySqliteTaskDatabase`，而被测的 `buildStartTaskDeps` 只是把句柄原样透传
  //     （用例自己就断言 `expect(withCmd.db).toBe(db)`）。放宽那个字段后连带中立化了
  //     `loadFrozenSpaceLayout` 与启动前的 `file://` 预筛（两处同步 `.all()` 转 await）。
  //   · `rfc349-digital-employee-platform-tools-wiring` / `rfc359-w7-catalog-composition-roots`
  //     / `rfc359-execution-contract-resource-adapter` —— **落进新的 `provider-composition-root`
  //     机械理由**：被测物就是某一侧的**组合根 / 装配面**（`composeSqliteAppDeps` /
  //     `composeSqliteDynamicWorkflowValidationContext` / `composeSqlitePostRestoreRecovery`），
  //     那个面按定义只在一侧存在，另一侧的同名能力有它自己那批组合根用例。
  //   · `rfc359-t19h-logical-backup-restore` / `rfc359-t19h-postgresql-upgrade.integration`
  //     —— 落进 `frozen-migration-revision`：它们建库喂的是 `freezeAt(idx)` 截出来的
  //     **冻结迁移前缀**（验的就是「那条迁移之前的行，恢复/升级之后该长什么样」）。
  //     判据此前只认内联拼法，抽成共享 helper 之后咬不到，已补。
  //   · `rfc349-dual-provider-behavior-oracle` / `rfc349-task-execution-provider-adapters`
  //     —— 落进新的 `cross-provider-oracle`：它们在**同一条用例**里同时建 SQLite 库与真 PG
  //     客户端做对拍，`describeEachProvider`「各跑一遍」的形状会把对拍拆成两半。
  //   · `execution-contract-platform` —— **真迁**。它的旧注释写着「被测主体就是 SQLite 那一份
  //     composition，PG 的对等物是另一支」，**那个理由已经过期**：§5hl 的端口化把
  //     `DigitalEmployeeExecutionDependencies` 的 `db` 字段整个去掉了，库读收在中立的
  //     `composeDatabaseDigitalEmployeeExecutionPorts` 里——而那两条用例本来就在装它。
  //     **教训**：「为什么这条还是单引擎」的理由写进注释之后**会过期**，而过期的方向是把一条
  //     已经能迁的用例继续钉在单引擎上；清账时要按当下的依赖面重判，别只读注释。
  // RFC-359 AC-1（第 11 刀下半）：cancel 合一摘掉了四份判据的 `from 'services/task'` 这条机械理由
  //（它们 import 它就是为了取 `cancelTask`）。摘掉之后**三份确实不再依赖那台执行引擎**，
  // 已就地迁到 `describeEachProvider`（`retry-cascade-kind-matrix` /
  // `rfc202-lifecycle-exits` / `rfc350-idle-timeout-integration`，同批离开上面那本总账）；
  // 第四份 `rfc268-webhook-scratch-launch` 仍真的驱动 SQLite 启动参与者，改由
  // `sqlite-execution-engine` 新补的拼法认领。**这本名单一行没涨。**
  // RFC-359 AC-6（收尾）**销账**：`helpers/rfc310Pr3Fixture.ts` 的 SQLite 回退已删除，
  // 五个消费者全部迁到双引擎（见上面总账里那条注释）。这批迁移的通用配方记在这里，
  // 因为它不是「把 `createInMemoryDb` 换成 `harness.db`」那么简单：
  //   · **进程侧的世界要按泳道建**——一台自己的 system mock / 一个自己的 appHome /
  //     一个自己的 mock 项目路径。共用会让两条泳道在同一块盘上推同名分支、开同一个 MR；
  //     pr4 实撞过一次：共用 appHome 时第二条泳道的 `git init` 落在第一条建好的仓上，
  //     `commit -m base` 当场 "nothing to commit"。
  //   · **库侧夹具要按用例建**——`describeEachProvider` 每个用例前会把 PostgreSQL 整库快照
  //     回滚，放 `beforeAll` 的铺陈会被抹掉。注册顺序即执行顺序：harness 的 `beforeEach`
  //     在 body 之前就登记了，所以 body 里的 `beforeEach` 一定跑在回滚之后。
  'rfc257-webhook-error-codes.test.ts',
  // RFC-359 AC-1（plan §5hn 批次二 ⑦）：`rfc268-webhook-scratch-launch.test.ts` **转为
  // sanctioned**（`sqlite-execution-engine` 那一类），不是迁移发生了，而是**它一直就属于那一类、
  // 只是被一层门面挡住了**：它原本从 `services/execution/executor.ts` 取 `cancelExecution`，
  // 而那个门面只是 `cancelTask` 的一行转交。门面整份删除、改直接 import `services/task` 之后，
  // 判据才看见它真正驱动的是 SQLite 那台执行引擎。
  // **记一条判据教训**：转交式门面会让「这条测试依赖哪台引擎」这类源码判据失明。
  // RFC-359 AC-1（第 11 刀下半）同一课的第二遍：`rfc269-webhook-code-host-context-e2e` 与
  // `rfc359-task-execution-read-models` 也**一直就属于那一类**（前者与 rfc268 同款装配，
  // 后者直接建 `createSqliteTaskExecutionRuntimeParticipants`），只是判据认的三种拼法都对不上。
  // 补上拼法之后它们离开本名单——「还剩多少要迁」少了两条**假待办**。
]

describe('RFC-359 W5-T19f —— 测试不得写死引擎（高水位，只降不升）', () => {
  test('语料非空：确实扫到了整棵 backend 测试树（扫成 0 说明扫描根失效，此刻零预言力）', () => {
    expect(CORPUS_FILES.length).toBeGreaterThanOrEqual(1_500)
  }, 30_000)

  test('逐文件调用点数与账本逐字相等（增了是新的单引擎判据，减了是收敛，都要改账本）', () => {
    expect(
      [...callSiteRows()],
      '直接建 SQLite 库的测试调用点数与账本不符（`createInMemoryDb(` 与 `new Database(` 合计）。' +
        '**增**了说明有人又写了一条**只验证 SQLite** 的判据——PostgreSQL 侧的同一段实现因此零行为覆盖，' +
        '正是 dual-provider-parity-audit-2026-09-04 里 12 条 P0 穿过全部验收的那个机制。' +
        '改用双引擎 harness：`describeEachProvider(name, (harness) => ...)`，库取 `harness.db`' +
        '（事务面取 `harness.session`，要按引擎分叉就看 `harness.capabilities`）。' +
        '确有理由只跑单引擎，就把新增写进账本并在那一行旁写清为什么。' +
        '**减**了说明迁移发生了——把账本一起改小，让这次减少留下一次有署名的提交记录。',
    ).toEqual([...TEST_ENGINE_HARDCODING_DEBT])
  }, 30_000)

  test('分类把总账**完整切开**：每一行要么有机械理由，要么在 open 名单里（两者不重不漏）', () => {
    const ledgerPaths = TEST_ENGINE_HARDCODING_DEBT.map((row) => row.slice(0, row.lastIndexOf(':')))
    const openSet = new Set(OPEN_MIGRATION_DEBT)
    const both = ledgerPaths.filter((rel) => openSet.has(rel) && sanctionOf(rel) !== null)
    expect(
      both,
      '这些文件既被判成 sanctioned、又列在 open 名单里——两张名单必须互斥，否则「还剩多少要迁」没有唯一答案',
    ).toEqual([])
    const neither = ledgerPaths.filter((rel) => !openSet.has(rel) && sanctionOf(rel) === null)
    expect(
      neither,
      '这些文件既不在 open 名单里、也没有任何机械理由——新写的单引擎判据要么迁掉，要么把它加进 ' +
        '`OPEN_MIGRATION_DEBT`（然后在下一波迁掉）。不要为了让数字好看而给它量身定做一条 sanctioned 判据。',
    ).toEqual([])
  }, 30_000)

  test('open 待办量与实测逐字相等（这才是「还剩多少要迁」，不是总账那个数）', () => {
    const ledgerPaths = TEST_ENGINE_HARDCODING_DEBT.map((row) => row.slice(0, row.lastIndexOf(':')))
    const measured = ledgerPaths.filter((rel) => sanctionOf(rel) === null).sort()
    expect(
      measured,
      '没有正当理由的单引擎文件与 `OPEN_MIGRATION_DEBT` 不符。**增**了说明有人新写了一条只验证 ' +
        'SQLite 的判据，而且它不属于任何一类已裁决的单引擎场景——改用 ' +
        '`describeEachProvider(name, (harness) => ...)`。**减**了说明迁移发生了，把名单一起改小。',
    ).toEqual([...OPEN_MIGRATION_DEBT])
  }, 30_000)

  // 负 fixture：把**伪造**的文件内容喂给分类判据本身，证明它还在工作。不碰真实语料——
  // 碰了就是在断言现状（那是规则），而不是在证明「决定过程还活着」。判据静默失效时，
  // 上面两条「切开总账」的判据会全绿通过（一切都被归进 open 或都被 sanction），
  // 只有这一条会红。
  test('分类判据的负 fixture：四类理由各自能被认出来，没有理由的返回 null', () => {
    expect(sanctionFor('migration-0042-widget.test.ts', 'const noop = 1\n')).toBe('migration-chain')
    expect(sanctionFor('plain.test.ts', 'await runTask({ taskId, db, appHome })\n')).toBe(
      'sqlite-execution-engine',
    )
    expect(sanctionFor('plain.test.ts', "const raw = new Database(join(root, 'aw.db'))\n")).toBe(
      'real-file-database',
    )
    expect(sanctionFor('plain.test.ts', 'const rows = db.$client.query(sql).all()\n')).toBe(
      'sqlite-only-primitive',
    )
    expect(sanctionFor('plain.test.ts', "await db.insert(tasks).values({ id: 't1' })\n")).toBeNull()
    // 注释里提到某个符号**不算**用了它——否则一句解释性注释就能把一条真待办挪进 sanctioned。
    expect(sanctionFor('plain.test.ts', '// 这里解释 db.$client 与 PRAGMA 为什么危险\n')).toBeNull()
  }, 30_000)

  test('注册期读 harness 判据的负 fixture：立即读要抓到，推迟读与用例内读要放过', () => {
    const eager = "describeEachProvider('x', (harness) => { const db = harness.db })\n"
    expect(eagerHarnessReads('plain.test.ts', eager)).toEqual(['plain.test.ts:1'])
    const lazy = "describeEachProvider('x', (harness) => { const db = () => harness.db })\n"
    expect(eagerHarnessReads('plain.test.ts', lazy)).toEqual([])
    const inTest =
      "describeEachProvider('x', (harness) => { test('t', () => { const db = harness.db }) })\n"
    expect(eagerHarnessReads('plain.test.ts', inTest)).toEqual([])
  }, 30_000)

  test('没有人在 describe 体里（注册期）直接读 harness——本地可能绿，CI 必红', () => {
    const offenders: string[] = []
    for (const rel of CORPUS_FILES) {
      if (EXEMPT.has(rel)) continue
      const text = readFileSync(join(TESTS, rel), 'utf8')
      if (!text.includes('describeEachProvider')) continue
      offenders.push(...eagerHarnessReads(rel, text))
    }
    expect(
      offenders,
      '这些地方在 `describe` 体里立即读了 `harness.db` / `harness.session` / `harness.capabilities`。' +
        'describe 体在**注册期**执行，那时 `beforeEach` 还没建库，惰性 getter 会抛 ' +
        '`ProviderHarness 只能在 test 体内读取`。**本地单文件跑可能是绿的**（取决于同进程前一个文件' +
        '留下的状态），CI 分片里必红——2026-09-13 就这么把 main 推红过，四个分片同时挂。' +
        '改法：把读取挪进 `test` / `beforeEach`，或写成 `const db = () => harness.db` 这种调用时才读的形式。',
    ).toEqual([])
  }, 30_000)

  test('账本按路径字典序、无重复（清点稳定的前提）', () => {
    const paths = TEST_ENGINE_HARDCODING_DEBT.map((row) => row.slice(0, row.lastIndexOf(':')))
    expect(new Set(paths).size, '账本里有重复路径').toBe(paths.length)
    expect([...paths].sort(), '账本没有按路径字典序排列').toEqual(paths)
  }, 30_000)
})
