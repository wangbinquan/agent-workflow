// RFC-422 — the local system agent run family's opener, moved from composition/localSystemAgentRunFamily.ts: the
// native invocation (material contents with their reference checks, the local preparation, observation and intent),
// the fixture family's result projection and the native fixture request. The runtime-management providers arrive
// from the composition through the native provider ports.
import { ulid } from 'ulid'
import type { AgentMaterialIntent } from '@/modules/runtime-management/public/participants'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import type {
  SystemAgentInvocationFamily,
  SystemAgentRunFamily,
  SystemAgentRunRequest,
} from '../../application/ports/systemAgentRunFamily'
import type { PreparedSystemAgentRunResult } from '../../application/ports/systemAgentRun'
import type { SystemAgentObservationFactory } from '../../application/ports/systemAgentObservation'
import { createSystemAgentRunFamily } from '../../application/systemAgentRun'
import { createLocalAgentInvocationPreparation } from './agentInvocationPreparation'
import type {
  NativeMaterialDefinitions,
  NativeRuntimeContents,
  NativeSystemAgentContents,
} from './nativeRunFamilyProviders'

/** The explicit root's selection: native facts, optional observations and the fake-run fixture. */
export interface LocalSystemAgentRunFamilyInput {
  appHome(): string
  readonly observations?: () => SystemAgentObservationFactory
  readonly fixture?: {
    readonly runFn: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
  }
}

/** The system agent runtime bindings: the binary reader and the runtime binding the family hands back. */
export interface LocalSystemAgentRuntimes<Bind> extends NativeRuntimeContents {
  readonly bindRuntime: Bind
}

/** Native facts and fake-run projection are selected only by an explicit root. */
export function createLocalSystemAgentRunFamily<Bind>(
  input: LocalSystemAgentRunFamilyInput,
  providers: {
    readonly runtimes: LocalSystemAgentRuntimes<Bind>
    readonly contents: NativeSystemAgentContents
    readonly materialDefinitions: NativeMaterialDefinitions
  },
) {
  const runtimes = providers.runtimes
  const contents = providers.contents
  const invocations: SystemAgentInvocationFamily = {
    open(request, log) {
      const definition = providers.materialDefinitions(request.protocol)
      const selected = contents.open({
        scope: request.workspaceScope,
        feature: () => request.feature,
        seedFiles: () => request.seedFiles,
      })
      const material = definition.createCompiler({
        workspace(reference) {
          if (reference !== selected.workspace.workspace)
            throw new Error('system-working-content-reference-unavailable')
          return selected.locations.workingDirectory
        },
        runContent(reference) {
          if (reference !== selected.workspace.runContent)
            throw new Error('system-run-content-reference-unavailable')
          return selected.locations.runDirectory
        },
        runtimeBinary: (reference) => runtimes.contents.runtimeBinary(reference),
        skill() {
          throw new Error('system-persona-skill-content-unavailable')
        },
        plugin() {
          throw new Error('system-persona-plugin-content-unavailable')
        },
      })
      const preparation = createLocalAgentInvocationPreparation({
        material,
        binding: {
          protocol: definition.protocol,
          workspace: selected.workspace,
          workingDirectory: () => selected.locations.workingDirectory,
          requireSpawnReceipt: true,
          cleanupReceiver: 'material',
          evidenceHooks: definition.evidenceHooks,
        },
        evidenceScope: {
          runContent: () => selected.locations.runDirectory,
          sessionLocation: () => ({ worktreePath: selected.locations.workingDirectory }),
        },
      })
      return {
        workspace: selected.workspace,
        ...(input.observations
          ? {
              observe: (startedAt: number) =>
                input.observations!().open({
                  feature: request.feature,
                  agentName: request.agentName,
                  protocol: request.protocol,
                  startedAt,
                  ...(request.observationDemand ? { demand: request.observationDemand } : {}),
                  ...(request.runtimeObservationIdentity
                    ? { runtimeObservationIdentity: request.runtimeObservationIdentity }
                    : {}),
                  ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
                }),
            }
          : {}),
        acknowledgeStart: () => true,
        prepareWorkspace: () => selected.workspace.prepare(),
        compile() {
          const intent: AgentMaterialIntent = {
            protocol: request.protocol,
            injection: { mcps: [] },
            prompt: request.prompt,
            agentName: request.agentName,
            systemPrompt: request.systemPrompt,
            resolvedProfiles: [
              [
                request.agentName,
                {
                  model: request.model != null && request.model !== '' ? request.model : null,
                  variant: null,
                  temperature: null,
                  steps: null,
                  maxSteps: null,
                  isSandbox: request.isSandbox === true,
                },
              ],
            ],
            workspace: selected.workspace.workspace,
            runContent: selected.workspace.runContent,
            ...(request.configDirEnv != null &&
            request.configDirEnv !== '' &&
            request.configDirName != null &&
            request.configDirName !== ''
              ? { configDir: { env: request.configDirEnv, name: request.configDirName } }
              : {}),
            freshAgentRun: false,
            ...(request.resumeSessionId != null && request.resumeSessionId !== ''
              ? { resumeSessionId: request.resumeSessionId }
              : {}),
            ...(request.runtimeBinding != null &&
            runtimes.contents.runtimeBinary(request.runtimeBinding) !== ''
              ? { runtimeBinding: request.runtimeBinding }
              : {}),
            nodeRunId: `${request.feature}-system`,
            log,
          }
          return preparation.compile(intent)
        },
      }
    },
  }
  const production = createSystemAgentRunFamily({
    invocations,
    workspaces: contents.workspaces,
    retainedContents: contents.contents,
  })
  const fixture = input.fixture
  function fixtureFamily(
    runFn: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>,
  ): SystemAgentRunFamily {
    return Object.freeze<SystemAgentRunFamily>({
      workspaces: contents.workspaces,
      retainedContents: contents.contents,
      async run(request) {
        const native = nativeFixtureRequest(request)
        const result = await runFn(native)
        const retainedRef = `aw-system-fixture:${ulid()}`
        let registered = false
        const fields = new Set([
          ...Object.keys(result),
          ...[
            'status',
            'exitCode',
            'eventText',
            'stderrTail',
            'durationMs',
            'resultError',
            'capturedSessionId',
            'nativeSessionIntegrityFailed',
            'scratchRetained',
            'scratchDir',
            'outputEvidence',
            'startupInventory',
            'declared',
          ].filter((field) => field in result),
        ])
        const descriptors: PropertyDescriptorMap = {}
        for (const field of fields) {
          if (field === 'scratchDir') {
            descriptors.retainedRef = {
              enumerable: true,
              get() {
                const scratchDir = result.scratchDir
                if (!registered) {
                  contents.bindFixtureRetainedResult(retainedRef, scratchDir)
                  registered = true
                }
                return retainedRef
              },
            }
          } else {
            descriptors[field] = {
              enumerable: true,
              get: () => Reflect.get(result, field, result),
            }
          }
        }
        return Object.defineProperties({}, descriptors) as PreparedSystemAgentRunResult
      },
    })
  }
  const family = fixture === undefined ? production : fixtureFamily(fixture.runFn)
  function nativeFixtureRequest(request: SystemAgentRunRequest): SystemAgentRunOptions {
    const fields = new Set([
      ...Object.keys(request),
      ...[
        'feature',
        'abortSignal',
        'eventSink',
        'nativeIdentityAuthoritative',
        'retainScratchOnSuccess',
        'agentName',
        'systemPrompt',
        'prompt',
        'protocol',
        'configDirEnv',
        'configDirName',
        'model',
        'isSandbox',
        'seedFiles',
        'timeoutMs',
        'maxEventTextBytes',
        'log',
        'resumeSessionId',
      ].filter((field) => field in request),
    ])
    const descriptors: PropertyDescriptorMap = {}
    for (const field of fields) {
      if (field === 'runtimeBinding' || field === 'workspaceScope') continue
      descriptors[field] = {
        enumerable: true,
        get: () => Reflect.get(request, field, request),
      }
    }
    if ('runtimeBinding' in request) {
      const reference = request.runtimeBinding
      const runtimeBinary =
        reference == null ? reference : runtimes.contents.runtimeBinary(reference)
      descriptors.runtimeBinary = { enumerable: true, value: runtimeBinary }
    }
    descriptors.scratchParent = {
      enumerable: true,
      get: () => contents.parent(request.workspaceScope),
    }
    if (request.workspaceScope.name !== undefined)
      descriptors.scratchName = {
        enumerable: true,
        get: () => request.workspaceScope.name,
      }
    return Object.defineProperties({}, descriptors) as SystemAgentRunOptions
  }
  return Object.freeze({
    family,
    bindRuntime: runtimes.bindRuntime,
    withFixture(runFn: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>) {
      return Object.freeze({ family: fixtureFamily(runFn), bindRuntime: runtimes.bindRuntime })
    },
  })
}
