// RFC-376 T1: independent target contracts copied from RFC-294; no inventory dependency.

export const TARGET_PUBLIC_CONTEXTS = [
  'collaboration',
  'development-automation',
  'digital-employee',
  'event-center',
  'execution-contract',
  'identity-access',
  'integration',
  'intent',
  'knowledge-evolution',
  'memory',
  'resource-catalog',
  'run-observability',
  'runtime-management',
  'source-control',
  'system-operations',
  'task-catalog',
  'task-execution',
  'workspace-insight',
] as const

export type TargetContext = (typeof TARGET_PUBLIC_CONTEXTS)[number]
export type TargetOwner = TargetContext | 'bootstrap' | 'frontend' | 'platform' | 'shared-contracts'

export type ContextEdgeRole =
  | 'authority-type-only'
  | 'offered-consumption'
  | 'required-implementation'

export interface TargetContextEdge {
  readonly id: string
  readonly fromContext: TargetContext
  readonly toContext: TargetContext
  readonly role: ContextEdgeRole
  readonly contract: string
}

export const OFFERED_CONTEXT_EDGES: ReadonlyArray<readonly [TargetContext, TargetContext]> = [
  ['task-execution', 'identity-access'],
  ['task-execution', 'resource-catalog'],
  ['task-execution', 'source-control'],
  ['task-execution', 'runtime-management'],
  ['task-execution', 'run-observability'],
  ['runtime-management', 'resource-catalog'],
  ['run-observability', 'runtime-management'],
  ['task-catalog', 'identity-access'],
  ['collaboration', 'task-execution'],
  ['memory', 'resource-catalog'],
  ['memory', 'source-control'],
  ['memory', 'collaboration'],
  ['memory', 'task-execution'],
  ['intent', 'resource-catalog'],
  ['integration', 'task-execution'],
  ['integration', 'resource-catalog'],
  ['knowledge-evolution', 'memory'],
  ['knowledge-evolution', 'resource-catalog'],
  ['knowledge-evolution', 'task-execution'],
  ['workspace-insight', 'source-control'],
  ['workspace-insight', 'task-execution'],
  ['workspace-insight', 'runtime-management'],
  ['development-automation', 'identity-access'],
  ['development-automation', 'resource-catalog'],
  ['development-automation', 'source-control'],
  ['development-automation', 'digital-employee'],
  ['development-automation', 'execution-contract'],
  ['digital-employee', 'event-center'],
  ['digital-employee', 'execution-contract'],
  ['resource-catalog', 'digital-employee'],
  ['task-execution', 'event-center'],
  ['event-center', 'identity-access'],
  ['task-execution', 'execution-contract'],
  ['integration', 'event-center'],
  ['integration', 'development-automation'],
]

export const OFFERED_CONTEXT_PAIRS = new Set(
  OFFERED_CONTEXT_EDGES.map(([fromContext, toContext]) => `${fromContext}->${toContext}`),
)

export const REQUIRED_CONTEXT_EDGES: ReadonlyArray<
  readonly [TargetContext, TargetContext, string]
> = [
  ['integration', 'source-control', 'RepositoryProviderEndpointDiscoveryPort'],
  ['integration', 'source-control', 'GlobalRepositoryTransportProjectionPort'],
  ['collaboration', 'task-execution', 'HumanGatePreparationPort/HumanGateOpenParticipantInTx'],
  ['memory', 'task-execution', 'TaskMemoryInjectionPort'],
  ['integration', 'task-execution', 'CodeHostExecutionPort'],
  ['task-execution', 'development-automation', 'AgentActionExecutionPort'],
  ['task-execution', 'digital-employee', 'ReactionExecutionPortV1'],
  ['task-execution', 'digital-employee', 'ReactionExecutionAdmissionParticipantV1'],
  ['integration', 'development-automation', 'development-effect-spi'],
  ['task-execution', 'task-catalog', 'TaskCatalogSource'],
  ['digital-employee', 'task-catalog', 'TaskCatalogSource'],
  ['task-execution', 'event-center', 'TaskAutomationWorkStartPort'],
  ['digital-employee', 'event-center', 'EmployeeAutomationWorkStartPort'],
  ['identity-access', 'event-center', 'EventAutomationDelegatedContextFactory'],
  ['integration', 'event-center', 'event-source-routing-spi'],
  ['resource-catalog', 'execution-contract', 'contract-resource-projection-spi'],
  ['task-execution', 'execution-contract', 'contract-fixture-spi'],
]

const AUTHORITY_CONTEXTS = TARGET_PUBLIC_CONTEXTS.filter((context) => context !== 'identity-access')

function edgeId(
  role: ContextEdgeRole,
  fromContext: TargetContext,
  toContext: TargetContext,
  contract: string,
): string {
  return `${role}:${fromContext}->${toContext}:${slug(contract)}`
}

export const TARGET_CONTEXT_EDGES: readonly TargetContextEdge[] = [
  ...OFFERED_CONTEXT_EDGES.map(([fromContext, toContext]) => ({
    id: edgeId('offered-consumption', fromContext, toContext, 'public'),
    fromContext,
    toContext,
    role: 'offered-consumption' as const,
    contract: 'exact-public-entrypoint',
  })),
  ...REQUIRED_CONTEXT_EDGES.map(([fromContext, toContext, contract]) => ({
    id: edgeId('required-implementation', fromContext, toContext, contract),
    fromContext,
    toContext,
    role: 'required-implementation' as const,
    contract,
  })),
  ...AUTHORITY_CONTEXTS.map((fromContext) => ({
    id: edgeId('authority-type-only', fromContext, 'identity-access', 'public-types'),
    fromContext,
    toContext: 'identity-access' as const,
    role: 'authority-type-only' as const,
    contract: 'identity-access/public/types:AuthorizationSubjectRef+opaque-authority',
  })),
].sort((left, right) => left.id.localeCompare(right.id))

function slug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}
