import type { CustomEventSourceDraft } from '../../domain/customEventSource'
import type { EventSubject } from '../../domain/model'

type MaybePromise<T> = T | Promise<T>

export interface CustomObserverProgramInput {
  readonly sourceRef: { readonly id: string; readonly revision: number }
  readonly draft: CustomEventSourceDraft
  readonly subjects: readonly EventSubject[]
  readonly cursorJson: string | null
  readonly now: number
}

export type CustomObserverProgramRef = object
export type CustomObserverWorkspaceRef = object

/** Only the original observer policy's logical settlement/output fields. */
export interface CustomObserverProgramResult {
  readonly outcome: 'exited' | 'timeout' | 'aborted' | 'spawn-failed' | 'child-unkillable'
  readonly exitCode: number | null
  readonly stderrTail: string
  readonly rawStdout: string
  readonly truncated: { readonly stdout: boolean }
}

export interface CustomObserverProgramEffects {
  resolveProgram(): MaybePromise<CustomObserverProgramRef | null>
  allocateWorkspace(): MaybePromise<CustomObserverWorkspaceRef>
  prepareWorkspace(workspace: CustomObserverWorkspaceRef): MaybePromise<void>
  writeInput(workspace: CustomObserverWorkspaceRef, envelopeJson: string): MaybePromise<void>
  writeProgram(workspace: CustomObserverWorkspaceRef): MaybePromise<void>
  run(
    workspace: CustomObserverWorkspaceRef,
    program: CustomObserverProgramRef,
  ): MaybePromise<CustomObserverProgramResult>
  disposeWorkspace(workspace: CustomObserverWorkspaceRef): MaybePromise<void>
}

/** Construction does not interpret physical fields or choose another provider. */
export interface CustomObserverProgramFactory {
  create(input: CustomObserverProgramInput): CustomObserverProgramEffects
}
