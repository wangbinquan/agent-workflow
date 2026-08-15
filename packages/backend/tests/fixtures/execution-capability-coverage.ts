export type EvidenceLayer = 'fast-contract' | 'deterministic-e2e' | 'live-release'

export interface CoverageEvidence {
  file: string
  anchor: string
  layer: EvidenceLayer
}

export interface CoverageItem {
  id: string
  evidence: readonly CoverageEvidence[]
}

const fast = (file: string, anchor: string): CoverageEvidence => ({
  file,
  anchor,
  layer: 'fast-contract',
})
const e2e = (file: string, anchor: string): CoverageEvidence => ({
  file,
  anchor,
  layer: 'deterministic-e2e',
})
const live = (file: string, anchor: string): CoverageEvidence => ({
  file,
  anchor,
  layer: 'live-release',
})

const workflowMatrix = (anchor: string): CoverageEvidence =>
  e2e('e2e/workflow-matrix.spec.ts', anchor)

export const RUNTIME_SCENARIOS = [
  'success',
  'process-crash-retry',
  'envelope-followup',
  'inline-clarify-resume',
  'inline-session-missing-fallback',
  'timeout',
  'cancel',
] as const

export const EXECUTION_CAPABILITY_COVERAGE = {
  nodeKinds: [
    {
      id: 'agent-single',
      evidence: [e2e('e2e/runtime-scenario-matrix.spec.ts', 'success: runtime parser')],
    },
    { id: 'input', evidence: [workflowMatrix('workflow launch input contract')] },
    { id: 'output', evidence: [workflowMatrix('output kinds: scalar')] },
    { id: 'wrapper-git', evidence: [workflowMatrix('wrapper-git: waits for its external input')] },
    {
      id: 'wrapper-loop',
      evidence: [workflowMatrix('wrapper-loop review: rejection injects reason')],
    },
    {
      id: 'wrapper-fanout',
      evidence: [workflowMatrix('wrapper-fanout: shards paths')],
    },
    { id: 'review', evidence: [workflowMatrix('mixed wrappers + humans:')] },
    { id: 'clarify', evidence: [workflowMatrix('clarify: agent asks,')] },
    {
      id: 'clarify-cross-agent',
      evidence: [workflowMatrix('clarify-cross-agent: only the asker reruns')],
    },
    {
      id: 'call-workflow',
      evidence: [
        fast('packages/backend/tests/rfc243-call-workflow.test.ts', 'D→L→W→F→M'),
        e2e('e2e/rfc243-call-nodes.spec.ts', 'palette Calls section creates a call-workflow'),
      ],
    },
    {
      id: 'call-workgroup',
      evidence: [
        fast('packages/backend/tests/rfc243-call-workgroup.test.ts', '冻结闭包起工作组子任务'),
      ],
    },
    {
      id: 'script',
      evidence: [e2e('e2e/rfc253-script-node.spec.ts', '拖入两个脚本节点')],
    },
    {
      id: 'code-host-call',
      evidence: [
        fast(
          'packages/backend/tests/rfc269-webhook-code-host-context-e2e.test.ts',
          'webhook trigger vars are visible to the first code-host scheduler read',
        ),
      ],
    },
    {
      // RFC-304. This is the one kind whose coverage is NOT "an author wired it
      // and it ran": it is synthesized, so the reachable contract right now is
      // that a submitted definition carrying it is refused. The execution
      // evidence lands with PR-0's second half (the `code-round` execution kind
      // + its runOneNode branch), and this entry gets a second, e2e line then —
      // it is listed with the weaker evidence rather than omitted, because
      // omission is what this catalog exists to catch.
      id: 'code-round',
      evidence: [
        fast(
          'packages/backend/tests/rfc304-synthesized-only-node-kinds.test.ts',
          'the list is non-empty and code-round is on it',
        ),
      ],
    },
  ] satisfies CoverageItem[],

  inputKinds: [
    { id: 'text', evidence: [workflowMatrix('all non-upload input kinds')] },
    { id: 'files', evidence: [workflowMatrix('all non-upload input kinds')] },
    { id: 'enum', evidence: [workflowMatrix('all non-upload input kinds')] },
    { id: 'git', evidence: [workflowMatrix('all non-upload input kinds')] },
    { id: 'upload', evidence: [workflowMatrix('upload input: multipart files land')] },
  ] satisfies CoverageItem[],

  outputShapes: ['string', 'markdown', 'signal', 'path', 'list'].map((id) => ({
    id,
    evidence: [workflowMatrix('output kinds: scalar')],
  })) satisfies CoverageItem[],

  workgroupModes: [
    {
      id: 'leader_worker',
      evidence: [e2e('e2e/workgroup-matrix.spec.ts', 'leader-worker: clarify')],
    },
    {
      id: 'free_collab',
      evidence: [e2e('e2e/workgroup-matrix.spec.ts', 'free-collab: parallel planning')],
    },
    {
      id: 'dynamic_workflow',
      evidence: [e2e('e2e/workgroup-matrix.spec.ts', 'dynamic-workflow: reject generated graph')],
    },
  ] satisfies CoverageItem[],

  workgroupRuntimePairs: (['opencode', 'claude-code'] as const).flatMap((runtime) =>
    (
      [
        ['leader_worker', 'leader-worker: clarify'],
        ['free_collab', 'free-collab: parallel planning'],
        ['dynamic_workflow', 'dynamic-workflow: reject generated graph'],
      ] as const
    ).map(([mode, anchor]) => ({
      id: `${runtime}::${mode}`,
      evidence: [e2e('e2e/workgroup-matrix.spec.ts', anchor)],
    })),
  ) satisfies CoverageItem[],

  runtimeKinds: [
    {
      id: 'opencode',
      evidence: [
        e2e('e2e/runtime-scenario-matrix.spec.ts', "['opencode', 'claude-code'] as const"),
      ],
    },
    {
      id: 'claude-code',
      evidence: [
        e2e('e2e/runtime-scenario-matrix.spec.ts', "['opencode', 'claude-code'] as const"),
      ],
    },
  ] satisfies CoverageItem[],

  runtimeScenarioPairs: (['opencode', 'claude-code'] as const).flatMap((runtime) =>
    RUNTIME_SCENARIOS.map((scenario) => ({
      id: `${runtime}::${scenario}`,
      evidence: [e2e('e2e/runtime-scenario-matrix.spec.ts', runtimeScenarioAnchor(scenario))],
    })),
  ) satisfies CoverageItem[],

  wrapperCompositions: [
    {
      id: 'wrapper-git::wrapper-git',
      classification: 'supported',
      evidence: [workflowMatrix('git inside git preserves')],
    },
    {
      id: 'wrapper-git::wrapper-loop',
      classification: 'supported',
      evidence: [workflowMatrix('loop inside git produces')],
    },
    {
      id: 'wrapper-git::wrapper-fanout',
      classification: 'supported',
      evidence: [workflowMatrix('git around fanout merges')],
    },
    {
      id: 'wrapper-loop::wrapper-git',
      classification: 'supported',
      evidence: [workflowMatrix('git inside loop exposes')],
    },
    {
      id: 'wrapper-loop::wrapper-loop',
      classification: 'static-rejected',
      evidence: [workflowMatrix('invalid loop-in-loop never starts')],
    },
    {
      id: 'wrapper-loop::wrapper-fanout',
      classification: 'supported',
      evidence: [workflowMatrix('loop around fanout uses')],
    },
    {
      id: 'wrapper-fanout::wrapper-git',
      classification: 'runtime-rejected',
      evidence: [workflowMatrix('current v1 limitation fails closed')],
    },
    {
      id: 'wrapper-fanout::wrapper-loop',
      classification: 'runtime-rejected',
      evidence: [
        fast(
          'packages/backend/tests/scheduler-wrapper-fanout-e2e.test.ts',
          'every nested wrapper kind fails closed',
        ),
      ],
    },
    {
      id: 'wrapper-fanout::wrapper-fanout',
      classification: 'runtime-rejected',
      evidence: [
        fast(
          'packages/backend/tests/scheduler-wrapper-fanout-e2e.test.ts',
          'every nested wrapper kind fails closed',
        ),
      ],
    },
  ] as const,

  liveRuntimeKinds: [
    {
      id: 'opencode',
      evidence: [live('e2e/release-runtime.spec.ts', 'pre-release real runtime:')],
    },
    {
      id: 'claude-code',
      evidence: [live('e2e/release-runtime.spec.ts', 'pre-release real runtime:')],
    },
  ] satisfies CoverageItem[],

  orchestrationSpines: [
    {
      id: 'memory-distill-approve-inject',
      evidence: [
        fast(
          'packages/backend/tests/memory-distiller.test.ts',
          'closed loop: distilled candidate stays out until approval',
        ),
        fast(
          'packages/backend/tests/memory-distiller.test.ts',
          'extracts candidates from claude-code stream-json',
        ),
        e2e(
          'e2e/runtime-scenario-matrix.spec.ts',
          'approved memory reaches the actual native runtime prompt',
        ),
      ],
    },
    {
      id: 'webhook-ingress-delivery-dedup',
      evidence: [
        fast('packages/backend/tests/rfc257-webhook-ingress.test.ts', '接收成功：200'),
        fast('packages/backend/tests/rfc257-webhook-ingress.test.ts', '同 UUID 重投'),
        fast(
          'packages/backend/tests/rfc259-webhook-github-e2e.test.ts',
          'workflow_run failure 落任务',
        ),
      ],
    },
    {
      id: 'webhook-to-agent-prompt',
      evidence: [
        fast(
          'packages/backend/tests/rfc269-webhook-code-host-context-e2e.test.ts',
          'reaches webhook agent prompt without root-input flattening',
        ),
      ],
    },
    {
      id: 'webhook-to-code-host-action',
      evidence: [
        fast(
          'packages/backend/tests/rfc269-webhook-code-host-context-e2e.test.ts',
          'webhook trigger vars are visible to the first code-host scheduler read',
        ),
      ],
    },
    {
      id: 'webhook-launch-workflow-agent-workgroup',
      evidence: [
        fast(
          'packages/backend/tests/rfc268-webhook-scratch-launch.test.ts',
          'workflow / agent / workgroup webhook fires',
        ),
      ],
    },
    {
      id: 'webhook-runtime-failure-lineage',
      evidence: [
        e2e(
          'e2e/rfc294-webhook-runtime-failures.spec.ts',
          'concurrent duplicate delivery launches one crashing task',
        ),
        e2e('e2e/rfc294-webhook-runtime-failures.spec.ts', 'runtime timeout kills every attempt'),
        e2e(
          'e2e/rfc294-webhook-runtime-failures.spec.ts',
          'well-formed output carrying the wrong nonce',
        ),
      ],
    },
    {
      id: 'webhook-mr-terminal-runtime-recovery',
      evidence: [
        e2e(
          'e2e/webhook-mr-runtime-races.spec.ts',
          'different-UUID close/update facts on one MR stream',
        ),
        e2e(
          'e2e/webhook-mr-runtime-races.spec.ts',
          'different-UUID launch-eligible facts serialize',
        ),
        e2e(
          'e2e/webhook-mr-runtime-races.spec.ts',
          'daemon crash while terminal control owns the runtime',
        ),
      ],
    },
    {
      id: 'intent-create-review-commit-provenance',
      evidence: [
        e2e(
          'e2e/intent-builder.spec.ts',
          'intent create → draft preview → commit → resource lands with provenance',
        ),
      ],
    },
    {
      id: 'human-gate-daemon-replacement',
      evidence: [
        e2e(
          'e2e/rfc294-human-gate-restart.spec.ts',
          'clarify and review keep their durable identities across separate daemon crashes',
        ),
      ],
    },
    {
      id: 'child-workflow-execution',
      evidence: [
        fast(
          'packages/backend/tests/rfc243-call-workflow.test.ts',
          '继承派生、子任务独立行、输出回填、合并回父',
        ),
        fast('packages/backend/tests/rfc243-call-workflow.test.ts', 'daemon 重启恢复'),
      ],
    },
    {
      id: 'child-workgroup-execution',
      evidence: [
        fast('packages/backend/tests/rfc243-call-workgroup.test.ts', '冻结闭包起工作组子任务'),
      ],
    },
  ] satisfies CoverageItem[],

  crossCuttingCapabilities: [
    { id: 'linear-and-fan-in', evidence: [workflowMatrix('linear DAG: parallel branches')] },
    { id: 'input-rejection', evidence: [workflowMatrix('rejects missing, unknown')] },
    { id: 'file-artifacts', evidence: [workflowMatrix('output kinds: scalar')] },
    { id: 'human-review-reject-approve', evidence: [workflowMatrix('review rejection')] },
    { id: 'self-and-cross-clarify', evidence: [workflowMatrix('clarify-cross-agent:')] },
    {
      id: 'daemon-crash-and-resume',
      evidence: [e2e('e2e/crash-recovery.spec.ts', 'SIGKILL daemon mid-task')],
    },
    {
      id: 'node-isolation-and-conflict',
      evidence: [
        fast('packages/backend/tests/rfc130-node-isolation.test.ts', 'two concurrent nodes'),
      ],
    },
    {
      id: 'retry-rollback',
      evidence: [
        fast(
          'packages/backend/tests/rfc092-followup-chain-rollback.test.ts',
          'fresh retry starts on X',
        ),
      ],
    },
    {
      id: 'fanout-concurrency',
      evidence: [
        fast(
          'packages/backend/tests/scheduler-boundary-fanout-concurrency.test.ts',
          'writer shards each run in their OWN iso worktree',
        ),
      ],
    },
    {
      id: 'runtime-resource-injection',
      evidence: [
        fast(
          'packages/backend/tests/rfc280-agent-injection.test.ts',
          'opencode hook declares skills/subagents/plugins faces',
        ),
        fast(
          'packages/backend/tests/rfc280-agent-injection.test.ts',
          'claude hook declares tools gate',
        ),
      ],
    },
    {
      id: 'claude-skill-and-dependent-files',
      evidence: [
        fast(
          'packages/backend/tests/claude-skill-injection-2026-08-09.test.ts',
          'copies the whole selected tree',
        ),
        fast(
          'packages/backend/tests/claude-dependency-injection-2026-08-09.test.ts',
          '逐成员取自己的 profile',
        ),
      ],
    },
    {
      id: 'session-token-event-inventory',
      evidence: [
        e2e('e2e/runtime-scenario-matrix.spec.ts', 'accounting, session'),
        fast(
          'packages/backend/tests/runner-inventory-integration.test.ts',
          'dump-plugin-written inventory is read and stored',
        ),
      ],
    },
    {
      id: 'business-success-failure-human-gate',
      evidence: [e2e('e2e/business-workflow-scenarios.spec.ts', '任一分片失败时不生成草稿')],
    },
  ] satisfies CoverageItem[],
}

function runtimeScenarioAnchor(scenario: (typeof RUNTIME_SCENARIOS)[number]): string {
  switch (scenario) {
    case 'success':
      return 'success: runtime parser'
    case 'process-crash-retry':
      return 'process crash retries'
    case 'envelope-followup':
      return 'missing envelope gets protocol feedback'
    case 'inline-clarify-resume':
      return 'inline clarify pauses'
    case 'inline-session-missing-fallback':
      return 'missing inline session warns'
    case 'timeout':
      return 'timeout applies to every retry'
    case 'cancel':
      return 'cancel terminates the in-flight runtime'
  }
}
