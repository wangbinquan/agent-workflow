import type { Config } from '@agent-workflow/shared'
import type { IntentContextManifest } from '../manifest'
import type { IntentTurnOutcome, SelectedIntentTurnConfig } from '../turnEngine'
import type { ReservedIntentTurnRecord } from './intentPersistence'
import type { IntentSystemAgentRunResult, IntentSystemExecutionReceipt } from './intentSystemAgent'

/** Intent's primary facts live with the original turn, independently of the
 * auxiliary session stream. Nothing here interprets a host process/reference. */
export interface IntentExecutionCheckpoint {
  readonly version: 1
  readonly revision: number
  readonly sessionId: string
  readonly reservation: ReservedIntentTurnRecord
  readonly configSnapshot: Config
  readonly phase: 'reserved' | 'prepared' | 'started' | 'terminal' | 'reaped' | 'closed'
  readonly snapshot?: {
    readonly config: SelectedIntentTurnConfig
    readonly manifest: IntentContextManifest
    readonly agentBranchPorts: Record<string, readonly string[]>
    readonly session: ReservedIntentTurnRecord['launchSession']
    readonly budget: ReservedIntentTurnRecord['budget']
  }
  readonly receipt?: IntentSystemExecutionReceipt
  readonly result?: Omit<IntentSystemAgentRunResult, 'executionRecovery'>
  readonly outcome?: IntentTurnOutcome
  readonly retiredUnissued?: readonly {
    readonly receipt: IntentSystemExecutionReceipt
    readonly result: Omit<IntentSystemAgentRunResult, 'executionRecovery'>
  }[]
}

export interface IntentExecutionPersistence {
  readExecutionCheckpoint(turnId: string): Promise<IntentExecutionCheckpoint | null>
  listExecutionCheckpoints(): Promise<readonly IntentExecutionCheckpoint[]>
  writeExecutionCheckpoint(input: {
    readonly checkpoint: IntentExecutionCheckpoint
    readonly expectedRevision: number | null
  }): Promise<void>
}

export interface IntentExecutionControl {
  current(): boolean
  /** A failed ACK suspends this exact continuation until an explicit retry. */
  checkpoint<T>(write: () => Promise<T>): Promise<T>
  /** Physical/capture/material recovery must ACK before this turn can settle. */
  holdOriginal(recover: () => Promise<boolean>): Promise<void>
}

export interface IntentExecutionAuthority {
  current(): boolean
  readonly canDispatch?: () => boolean
  readonly whenActive?: Promise<boolean>
  readonly reportFailure?: (error: unknown) => void
}

export interface IntentTurnExecutionLifecycle {
  configureRecovery(input: {
    load(): Promise<readonly IntentExecutionCheckpoint[]>
    recover(checkpoint: IntentExecutionCheckpoint, control: IntentExecutionControl): Promise<void>
  }): void
  prepare(): Promise<void>
  dispatch(turnId: string, work: (control: IntentExecutionControl) => Promise<void>): Promise<void>
  recoverOriginal(turnId: string): Promise<boolean>
  start(authority: IntentExecutionAuthority): {
    stop(): void
    drain(): Promise<void>
  }
}
