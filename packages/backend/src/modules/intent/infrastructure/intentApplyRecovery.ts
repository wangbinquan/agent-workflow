import type { AtomicApplyRecoveryScene } from '@/platform/contracts/atomicApply'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { Logger } from '@/util/log'
import {
  INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
  INTENT_APPLY_DIAGNOSTICS,
} from '../application/journalConvergence'
import { createIntentApplyJournal } from './intentApplyJournal'
import { intentApplyArtifactCodecs } from './intentApplyArtifactCodec'
import type { IntentApplyArtifactLifecycle } from './intentApplyEngine'

export class IntentApplyArtifactDecodeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'IntentApplyArtifactDecodeError'
  }
}

interface IntentApplyRecoveryInput {
  readonly db: PersistenceDb
  readonly artifacts: IntentApplyArtifactLifecycle
  readonly log: Logger
  readonly now?: () => number
}

export function createIntentApplyRecoveryScene(
  input: IntentApplyRecoveryInput,
): AtomicApplyRecoveryScene<'intent'> {
  const journal = createIntentApplyJournal(input.db)
  return {
    key: 'intent',
    ...(input.now === undefined ? {} : { now: input.now }),
    list: journal.list,
    compareAndSet: (row, patch) =>
      journal.transaction((tx) => journal.compareAndSet(tx, row.id, row.state, patch)),
    async recover(row, action) {
      let artifacts
      try {
        artifacts = intentApplyArtifactCodecs.decode(row.preparedArtifactsJson)
      } catch (cause) {
        throw new IntentApplyArtifactDecodeError(cause)
      }
      if (action === 'roll-forward') return input.artifacts.rollForward(artifacts, input.log)
      let complete = true
      for (const artifact of [...artifacts].reverse()) {
        try {
          await input.artifacts.compensate(artifact)
        } catch (error) {
          complete = false
          input.log.warn(INTENT_APPLY_DIAGNOSTICS.convergeCompensationFailed, {
            journalId: row.id,
            kind: artifact.kind,
            err: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return complete
    },
    errors: {
      abandoned: 'daemon-restart before commit',
      committedIncomplete: INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
      retryable: (error, action) =>
        error instanceof IntentApplyArtifactDecodeError
          ? `retryable: artifact decode failed: ${error.message}`
          : action === 'roll-forward'
            ? INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE
            : 'retryable: compensation incomplete',
    },
    warnScene(error) {
      input.log.warn(INTENT_APPLY_DIAGNOSTICS.convergeLeftRetryable, {
        err: error instanceof Error ? error.message : String(error),
      })
    },
    warn(error, row, action) {
      input.log.warn(
        error instanceof IntentApplyArtifactDecodeError
          ? INTENT_APPLY_DIAGNOSTICS.journalArtifactCorrupt
          : action === 'compensate'
            ? INTENT_APPLY_DIAGNOSTICS.convergeLeftRetryable
            : INTENT_APPLY_DIAGNOSTICS.artifactRollForwardRetryable,
        {
          journalId: row.id,
          state: row.state,
          err: error instanceof Error ? error.message : String(error),
        },
      )
    },
  }
}
