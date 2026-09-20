import type {
  RepositoryPreparationEffectCapability,
  RepositoryPreparationParticipant,
} from '../public/participants'
import type {
  FrozenRepositoryPreparationRef,
  RepositoryPreparationOperationRef,
  WorkspacePreparationExecutionOutcome,
} from '../public/types'
import type { RepositoryPreparationJournal } from '../application/ports/repositoryPreparationJournal'
import type { RepositoryPreparationEffects } from '../application/ports/repositoryPreparationEffects'
import { prepareRepositoryWorkspace } from '../application/repositoryPreparation'

interface EffectBinding {
  readonly operation: RepositoryPreparationOperationRef
  readonly source: FrozenRepositoryPreparationRef
  readonly effects: RepositoryPreparationEffects
}

/** Root-owned instance. The registry is only a live capability check; all results are durable. */
export function composeRepositoryPreparationParticipant(input: {
  readonly journal: RepositoryPreparationJournal
  readonly now?: () => number
}) {
  const live = new WeakSet<RepositoryPreparationEffectCapability>()
  const bindings = new WeakMap<RepositoryPreparationEffectCapability, EffectBinding>()
  const running = new Map<
    RepositoryPreparationOperationRef,
    Promise<WorkspacePreparationExecutionOutcome>
  >()
  function createRepositoryPreparationEffectCapability(
    binding: EffectBinding,
  ): RepositoryPreparationEffectCapability {
    const capability = Object.freeze({}) as RepositoryPreparationEffectCapability
    live.add(capability)
    bindings.set(capability, binding)
    return capability
  }
  function requireBinding(
    capability: RepositoryPreparationEffectCapability,
    operation: RepositoryPreparationOperationRef,
    source: FrozenRepositoryPreparationRef,
  ): EffectBinding {
    const binding = bindings.get(capability)
    if (!live.has(capability) || binding === undefined)
      throw new Error('repository-preparation-effect-scope-ended')
    if (binding.operation !== operation || binding.source !== source)
      throw new Error('repository-preparation-effect-scope-mismatch')
    return binding
  }
  const participant = Object.freeze<RepositoryPreparationParticipant>({
    async prepare(capability, operation, source) {
      const binding = requireBinding(capability, operation, source)
      const assertCurrent = async () => {
        requireBinding(capability, operation, source)
        await binding.effects.assertCurrent()
        requireBinding(capability, operation, source)
      }
      await assertCurrent()
      // Do not race two same-process calls into the same worktree. A restarted
      // process still relies on the existing Task fence and the durable journal.
      const pending = running.get(operation)
      if (pending !== undefined) {
        try {
          await pending
        } catch {
          /* A new current Task attempt may recover its predecessor. */
        }
        await assertCurrent()
        return participant.prepare(capability, operation, source)
      }
      const execution = prepareRepositoryWorkspace({
        journal: input.journal,
        effects: { ...binding.effects, assertCurrent },
        operation,
        source,
        now: input.now ?? Date.now,
      })
      running.set(operation, execution)
      try {
        return await execution
      } finally {
        if (running.get(operation) === execution) running.delete(operation)
      }
    },
  })
  return Object.freeze({
    participant,
    bindEffect(binding: EffectBinding) {
      const capability = createRepositoryPreparationEffectCapability(binding)
      return Object.freeze({
        capability,
        close() {
          live.delete(capability)
          bindings.delete(capability)
        },
      })
    },
  })
}
