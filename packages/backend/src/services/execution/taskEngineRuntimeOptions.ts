import type { Language, ScriptLanguage } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { CodeHostConnectionsService } from '@/services/codeHost/connections'
import type { Logger } from '@/util/log'
import type { TaskExecutionContextRef } from '@/modules/task-execution/public/topology'

export interface RunTaskOptions {
  taskId: string
  db: DbClient
  appHome: string
  /**
   * RFC-328 exact durable claim, supplied only by the claim→attach handoff.
   * Optional solely for legacy unit fixtures that call runTask against an
   * ownerless in-memory database; a durable claimed owner always requires it.
   * It is intentionally absent from the child inheritance registry because a
   * child task obtains its own intent/epoch.
   */
  executionContext?: TaskExecutionContextRef
  /**
   * RFC-304: fences MR leases across a restart. A lease minted by a previous
   * daemon is void, so a machine that died holding leases does not lock every
   * MR it touched until each one expires. Defaults to `'dev'` when unset, which
   * is correct for tests and single-process runs.
   */
  daemonGeneration?: string
  /** TEST-ONLY runtime-neutral command-head override (mock binaries; its
   *  presence also keeps real credential bridges off — RFC-282 C1). */
  binaryOverride?: readonly string[]
  /** Daemon config path — config.opencodePath/claudeCodePath fold into the
   *  FROZEN binary at mint time (RFC-282 C1-2; RFC-111 D15 alignment). */
  configPath?: string
  log?: Logger
  /**
   * When aborted, any node currently running is SIGTERMed via runNode and the
   * task transitions to status=canceled. Subsequent nodes are not started.
   */
  signal?: AbortSignal
  /**
   * Default per-node timeout in ms (from settings). RFC-115: the per-node
   * `timeoutMs` override is removed — this global value applies to every node.
   */
  defaultPerNodeTimeoutMs?: number
  /**
   * RFC-115: global per-node retry budget (from config.defaultNodeRetries).
   * Replaces the per-node `retries` override; `?? 3` fallback for mock/unwired.
   */
  defaultNodeRetries?: number
  /**
   * RFC-313: 同会话追问链触顶后允许整体换几次干净会话（from config.sessionRestartBudget）。
   * 与 defaultNodeRetries 相乘决定 attempt 硬上限，见 platform contract
   * `retryAttemptCap`。
   */
  sessionRestartBudget?: number
  /**
   * RFC-253 — administrator interpreter overrides for script nodes. Absent
   * entries resolve from the daemon's PATH.
   */
  scriptInterpreters?: Partial<Record<ScriptLanguage, string>>
  /** RFC-253 — wall clock for one dependency-environment build. */
  scriptDepsInstallTimeoutMs?: number
  /**
   * Daemon-wide pool shared across tasks by AGENT-class process nodes — agent
   * nodes, workgroup host nodes, fan-out shards and aggregators. Default 4.
   * RFC-266: script nodes have their own pool below and no longer compete here.
   */
  maxConcurrentNodes?: number
  /** RFC-266: daemon-wide pool for script nodes, independent of the agent pool. Default 4. */
  maxConcurrentScriptNodes?: number
  /** RFC-269: independent pool for code-host call nodes (default 8). */
  maxConcurrentCodeHostCalls?: number
  /** RFC-269: per-request wall clock; node-level `timeoutMs` overrides it. */
  codeHostRequestTimeoutMs?: number
  /** RFC-269: cap on the `response` port value before explicit truncation. */
  codeHostResponseMaxBytes?: number
  /**
   * RFC-269: the credential service. Absent ⇒ code-host nodes fail with
   * `code-host-not-configured` (the same self-skip discipline the OIDC and
   * webhook surfaces use when `secretBox` is missing).
   */
  codeHostConnections?: CodeHostConnectionsService
  /** RFC-269: outbound fetch seam; production omits it, tests inject a stub. */
  codeHostFetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** RFC-321 exact publication transport; tests may inject, production resolves the daemon key. */
  repositoryPublicationTransport?: RepositoryPublicationTransport
  /** Concurrency cap for fan-out child subprocesses (P-3-02). Default 4. */
  multiProcessSubprocessConcurrency?: number
  /**
   * RFC-060 D.T6: runtime cartesian guard for wrapper-fanout. When a single
   * wrapper-fanout (possibly with nested wrapper-fanouts) would mint more
   * than this many total shards, the wrapper finalizes 'failed' with
   * `wrapper-fanout-cartesian-exceeds-max` rather than minting the shards.
   * Default 256.
   */
  fanoutMaxShardTotal?: number
  /** RFC-243 §3.2: daemon-wide active-child-task cap (default 8). */
  maxActiveChildTasks?: number
  /** RFC-243 §3.2: invocation-chain depth ceiling (default 3). */
  maxInvocationDepth?: number
  /**
   * RFC-048: forwarded verbatim to every `runNode` call so the runner spins
   * up its subagent live-capture poller with the operator-configured cadence.
   * Omitted → runner falls back to its compile-time defaults.
   */
  subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }
  /**
   * RFC-075: model for the built-in commit agent (commit message + push
   * repair). Omitted → opencode's installed default. Repair budget + diff
   * truncation use the DEFAULT_COMMIT_PUSH_* constants (Settings wiring is a
   * follow-up; the runtime reads sensible defaults today).
   */
  commitPushModel?: string
  /** RFC-117: runtime profile NAME for the built-in commit agent (config.commitPushRuntime); wins over commitPushModel. */
  commitPushRuntime?: string
  /** RFC-130 §6.1: deprecated model fallback for the built-in merge-conflict resolver agent (config.mergeAgentModel). */
  mergeAgentModel?: string
  /** RFC-130 §6.1: runtime profile NAME for the built-in merge agent (config.mergeAgentRuntime); wins over mergeAgentModel. */
  mergeAgentRuntime?: string
  /** RFC-075: repair-retry budget; falls back to DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES. */
  commitPushMaxRepairRetries?: number
  /** RFC-075: diff byte cap for the commit-message prompt; falls back to DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES. */
  commitPushDiffMaxBytes?: number
  /** RFC-308: immutable exclusion settings slice for this scheduler operation. */
  commitPushExcludePatterns?: readonly string[]
  /** RFC-308: resume/retry asks the scheduler to rebuild persisted worktree profiles. */
  ensureWorkspaceProfiles?: boolean
  /** RFC-157: commit-message output language (initial + repair); undefined ≡ en-US. */
  commitPushLang?: Language
  /**
   * RFC-111 D1/D15 + RFC-112: global default runtime NAME (from
   * config.defaultRuntime). At the agent-dispatch site each node's runtime is
   * resolved once from `agent.runtime ?? defaultRuntime` (name → protocol+binary
   * via the registry) and frozen onto node_runs. resume reads the frozen value.
   * Omitted → 'opencode'. Internal agents (commit&push) stay on opencode (D14).
   */
  defaultRuntime?: string
  // RFC-113 §5: the RFC-112 P2 `claudeCodePath` thread is GONE — the built-in
  // claude binary now lives on the claude runtime row's binary_path (config
  // migrated into it) and flows through the normal runtimeBinary freeze.
}
