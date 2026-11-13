import { taskExecutionParticipants } from './taskExecutionParticipantBindings'
import { createNodeRunQueries, createNodeOutputQueries } from '@/modules/task-execution/composition'
import { join } from 'node:path'
import { composeNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
import { createFileReviewArtifactContent } from '@/modules/collaboration/infrastructure/local/fileReviewArtifactContent'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { composeRuntimeRegistryOperations } from './runtimeRegistryComposition'
import { distillRuntimeProfile } from '@/modules/memory/application/distill/distillRuntimeProfile'
import { DrizzleMemoryDistillWorkStore } from '@/modules/memory/infrastructure/memoryDistillWorkStore'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import { enqueueDistillJob } from '@/modules/memory/application/distill/schedule'
import { appHome } from '@/util/paths'
import {
  runDistill as runSelectedDistill,
  type RunDistillOptions as SelectedRunDistillOptions,
} from '@/modules/memory/application/distill/memoryDistiller'
import {
  distillTick as selectedDistillTick,
  type DistillTickOptions,
} from '@/modules/memory/application/distill/schedule'
import type { NativeMemoryDistillRuntimeResolver } from '@/modules/memory/application/ports/distillWorkStore'
import { composeLocalSystemAgentRunFamilySelection } from '@/bootstrap/runFamilyProviders'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import { createClarifyAnswerQueries } from '@/modules/collaboration/composition'

type NativeRunFixture = (options: SystemAgentRunOptions) => Promise<SystemAgentRunResult>

/** Complete native composition for tests that exercise only persistence/query capabilities. */
export function memorySystemAgentBindingForTest() {
  return composeLocalSystemAgentRunFamilySelection({ appHome })
}

/** Explicit native test projection; normal Memory callers require a complete family. */
export type RunDistillOptions = Omit<
  SelectedRunDistillOptions,
  'systemAgents' | 'runtimeBinding'
> & {
  readonly runFn?: NativeRunFixture
  readonly runtimeBinary?: string | null
}

/**
 * RFC-487: the distiller's runtime resolution as bootstrap binds it — runtime-management's internal-agent resolution
 * (`resolveInternalAgentRuntime`) over the same db. Memory no longer has a resolver of its own.
 */
export function runtimeManagementDistillRuntimes(
  db: PersistenceDb,
): NativeMemoryDistillRuntimeResolver {
  const registry = composeRuntimeRegistryOperations(db)
  return { resolve: (request) => registry.resolveInternalAgentRuntime(request) }
}

type NativeTickOptions = Omit<DistillTickOptions, 'systemAgents' | 'runtimeResolver'> & {
  readonly runFn?: NativeRunFixture
  readonly runtimeResolver: NativeMemoryDistillRuntimeResolver
}
function forwardOptions<T>(
  source: object,
  fields: readonly string[],
  selected: PropertyDescriptorMap,
): T {
  const descriptors: PropertyDescriptorMap = {}
  for (const field of fields) {
    descriptors[field] = { enumerable: true, get: () => (source as Record<string, unknown>)[field] }
  }
  return Object.defineProperties({}, { ...descriptors, ...selected }) as T
}

function nativeMemoryFixtureBinding(source: { readonly runFn?: NativeRunFixture }) {
  // Construction does not read appHome or profile data; capture stays at the caller's original point.
  const binding = composeLocalSystemAgentRunFamilySelection({ appHome })
  return {
    binding,
    family() {
      const runFn = source.runFn
      return runFn === undefined ? binding.family : binding.withFixture(runFn).family
    },
  }
}

export function runDistill(options: RunDistillOptions): ReturnType<typeof runSelectedDistill> {
  const { binding, family } = nativeMemoryFixtureBinding(options)
  return runSelectedDistill(
    forwardOptions<SelectedRunDistillOptions>(
      options,
      [
        'store',
        'reviewedArtifacts',
        'nodeRunPrompts',
        'job',
        'siblings',
        'timeoutMs',
        'protocol',
        'model',
        'isSandbox',
        'sourceContextBudget',
        'envelopeNonce',
      ],
      {
        systemAgents: { enumerable: true, get: family },
        runtimeBinding: {
          enumerable: true,
          get: () =>
            binding.bindRuntime({
              get binaryPath() {
                return options.runtimeBinary ?? null
              },
            }).runtimeBinding,
        },
      },
    ),
  )
}

function nativeScheduleOptions<T>(options: NativeTickOptions, fields: readonly string[]): T {
  const { binding, family } = nativeMemoryFixtureBinding(options)
  return forwardOptions<T>(options, fields, {
    systemAgents: { enumerable: true, get: family },
    runtimeResolver: {
      enumerable: true,
      get() {
        const native = options.runtimeResolver
        return {
          async resolve(input: Parameters<NativeMemoryDistillRuntimeResolver['resolve']>[0]) {
            // RFC-487: as the composition does — keep exactly the distiller's declared runtime fields.
            return binding.bindRuntime(distillRuntimeProfile(await native.resolve(input)))
          },
        }
      },
    },
  })
}

export function distillTick(options: NativeTickOptions): ReturnType<typeof selectedDistillTick> {
  return selectedDistillTick(
    nativeScheduleOptions<DistillTickOptions>(options, [
      'store',
      'reviewedArtifacts',
      'nodeRunPrompts',
      'runtimeName',
      'defaultRuntime',
      'model',
      'sourceContextBudget',
      'timeoutMs',
      'now',
    ]),
  )
}

export function createSqliteMemoryDistillTestContext(db: PersistenceDb, root = appHome()) {
  const reviewedArtifacts = new DatabaseCommittedReviewArtifactReader(
    db,
    createFileReviewArtifactContent(root),
  )
  return Object.freeze({
    store: new DrizzleMemoryDistillWorkStore(
      db,
      createClarifyAnswerQueries(db, taskExecutionParticipants),
      createNodeRunQueries(db),
      createNodeOutputQueries(db),
    ),
    runtimeResolver: runtimeManagementDistillRuntimes(db),
    nodeRunPrompts: composeNodeRunPromptOperations(undefined, join(root, 'runs')),
    reviewedArtifacts,
  })
}

/** Provider-real test participant for consumers that only enqueue work. */
export function createSqliteMemoryDistillEnqueuer(db: PersistenceDb): MemoryDistillEnqueuer {
  const store = new DrizzleMemoryDistillWorkStore(
    db,
    createClarifyAnswerQueries(db, taskExecutionParticipants),
    createNodeRunQueries(db),
    createNodeOutputQueries(db),
  )
  return Object.freeze({
    enqueue: async (input) => await enqueueDistillJob(store, input),
  })
}
