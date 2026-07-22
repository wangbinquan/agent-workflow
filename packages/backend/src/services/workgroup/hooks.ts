// RFC-217 T3 — the engine↔scheduler contract types, extracted to a LEAF so
// turnExecution / strategies / dynamicWorkflowRunner can import them without
// touching the engine module (no-circular guard). buildWorkgroupHooks (the
// scheduler-side implementation) migrates here in a later T3 slice.

import type { Agent } from '@agent-workflow/shared'
import type { FailureCode } from '@agent-workflow/shared'

export interface WorkgroupHostRunRequest {
  nodeRunId: string
  nodeId: string
  agent: Agent
  /** Fully-composed prompt text (charter/roster/brief/slices). */
  promptTemplate: string
  /** Replaces the agent-outputs protocol block (design §5). Workgroup turns
   *  always pass one; the RFC-167 orchestrator run omits it so the STANDARD
   *  <workflow-output> protocol for its declared ports applies. */
  workgroupProtocolBlock?: string
  /** RFC-167 (Codex impl-gate P1): drop the run's iso-worktree delta instead
   *  of merging it back — the orchestrator GENERATION run only produces an
   *  envelope; its worktree writes must never reach canonical (validation +
   *  the human confirm gate happen after the run). Workgroup turns leave this
   *  unset (their writes are the work product). */
  discardWrites?: boolean
  /** RFC-181 C — resolveClarifyEnabled(config.autonomous) at dispatch time.
   *  false ⇒ the hook runs the node with the 'stopped' clarify directive, so a
   *  voluntary <workflow-clarify> is REJECTED inside runNode (persisted
   *  failed + clarify-forbidden, no session, no park) and the runner branches
   *  below re-prompt / drop-and-continue. Undefined (dynamic orchestrator)
   *  keeps the legacy no-channel behavior. The hook additionally re-reads the
   *  task's CURRENT autonomous right before opening a session (mid-run toggle
   *  race — design-gate P1-①). */
  clarifyEnabled?: boolean
  /** RFC-184: the wg protocol output ports this host role may emit
   *  ({@link wgHostRolePorts}). When set, the hook projects the member agent's
   *  `outputs` to this list and clears `outputKinds` before runNode, so the
   *  runner parses/returns the wg_* ports and NEVER validates the member's own
   *  business output kinds (root cause of the F42SE port-validation-path-empty
   *  failure). Also gates `persistDeclaredOutputs:false` so host runs keep the
   *  "zero node_run_outputs rows" invariant (design.md §2.4). Undefined
   *  (dynamic orchestrator) ⇒ no projection, agent's declared outputs apply. */
  hostOutputPorts?: string[]
}

export interface WorkgroupHostRunResult {
  status: 'done' | 'failed' | 'canceled' | 'awaiting'
  /** Envelope port map (present when status='done'). */
  outputs: Record<string, string>
  /** Set when the agent voluntarily asked back (status='awaiting'). */
  clarifyQuestionCount?: number
  errorMessage?: string
  /** RFC-185 e2e hardening — runNode's structured failure code (RFC-145: the
   *  ONLY machine routing key; errorMessage is human breadcrumbs). Lets the
   *  turn drivers treat envelope-missing as a retryable protocol slip. */
  failureCode?: FailureCode
}

export interface WorkgroupEngineHooks {
  /**
   * Drive ONE host-node run end to end: frozen runtime + iso worktree +
   * runNode + merge-back + node_run status. `status:'awaiting'` means the
   * agent emitted <workflow-clarify> and the hook already created the clarify
   * session (parked awaiting_human).
   */
  runHostNode: (req: WorkgroupHostRunRequest) => Promise<WorkgroupHostRunResult>
  /** node.status WS broadcast (optional in tests). */
  broadcastNodeStatus?: (nodeRunId: string, nodeId: string, status: string) => void
  /** RFC-187 §4 — files changed in the canonical worktree vs its base commit
   *  (incl. untracked). Provided by scheduler (git); absent in pure-engine tests
   *  (the zero-delta warn is then skipped). */
  getCanonicalFilesChanged?: () => Promise<number>
}
