// RFC-349 — Promise adapter over the proven SQLite human-gate decision atom.

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import type {
  AcceptHumanGateDecisionInput,
  AcceptedHumanGateDecision,
  HumanGateDecisionPersistence,
} from '../application/acceptHumanGateDecision'
import { LegacyHumanGateTaskLifecycle } from './legacyHumanGateTaskLifecycle'
import { SqliteTaskDecisionParticipantInTx } from './sqliteTaskDecisionParticipant'
import { SqliteTaskExecutionEffectStore } from './sqliteTaskExecutionEffect'
import { SqliteTaskOwnershipStore } from './sqliteTaskOwnership'

export class SqliteTaskDecisionPersistence implements HumanGateDecisionPersistence {
  private readonly lifecycle = new LegacyHumanGateTaskLifecycle()
  private readonly effects = new SqliteTaskExecutionEffectStore(new SqliteTaskOwnershipStore())

  constructor(private readonly db: DbClient) {}

  async accept(input: AcceptHumanGateDecisionInput): Promise<AcceptedHumanGateDecision> {
    return dbTxSync(this.db, (tx) =>
      new SqliteTaskDecisionParticipantInTx(tx, this.lifecycle, this.effects).acceptGateDecisionTx(
        input,
      ),
    )
  }
}
