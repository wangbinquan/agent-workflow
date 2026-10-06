import { ulid } from 'ulid'
import type { AgentMaterialIntent } from '@/modules/runtime-management/public/participants'
import {
  createLocalSystemAgentRetainedContents,
  createLocalSystemAgentRuntimeBindings,
} from '@/modules/runtime-management/composition/systemAgentMaterial'
import { selectLocalAgentMaterialDefinition } from '@/modules/runtime-management/composition/localAgentMaterial'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import type {
  SystemAgentInvocationFamily,
  SystemAgentRunFamily,
  SystemAgentRunRequest,
} from '../application/ports/systemAgentRunFamily'
import type { PreparedSystemAgentRunResult } from '../application/ports/systemAgentRun'
import { createLocalAgentInvocationPreparation } from './localAgentInvocationPreparation'
import { composeSystemAgentRunFamily } from './systemAgentRunFamily'

/** Native facts and fake-run projection are selected only by an explicit root. */
export function composeLocalSystemAgentRunFamily(input: {
  appHome(): string
  readonly fixture?: {
    readonly runFn: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
  }
}) {
  const runtimes = createLocalSystemAgentRuntimeBindings()
  const contents = createLocalSystemAgentRetainedContents(input)
  const invocations: SystemAgentInvocationFamily = {
    open(request, log) {
      const definition = selectLocalAgentMaterialDefinition(request.protocol)
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
  const production = composeSystemAgentRunFamily({
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
