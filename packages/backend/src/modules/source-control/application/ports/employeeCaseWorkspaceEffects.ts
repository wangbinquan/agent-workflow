import type {
  RepositoryCandidateFileFacts,
  RepositoryCandidateGitOutcome,
} from './repositoryCandidateEffects'

type Completion<T> = T | Promise<T>

/** Literal arguments retain their values; only explicit references are materialized. */
export type EmployeeCaseGitOperand =
  | Readonly<{ kind: 'literal'; value: string }>
  | Readonly<{ kind: 'reference'; reference: string }>

/** One complete content/Git scope. Layout and business decisions stay with the owner. */
export interface EmployeeCaseWorkspaceEffects {
  resolve(reference: string, ...relativeSegments: readonly string[]): string
  sibling(reference: string, suffix: string): string
  exists(reference: string): Completion<boolean>
  stat(reference: string): Completion<RepositoryCandidateFileFacts | null>
  list(reference: string): Completion<readonly string[]>
  createDirectory(reference: string): Completion<void>
  copyFile(source: string, target: string): Completion<void>
  setMode(reference: string, mode: number): Completion<void>
  readBytes(reference: string): Completion<Uint8Array>
  writeText(reference: string, text: string): Completion<void>
  remove(reference: string): Completion<void>
  move(source: string, target: string): Completion<void>
  runGit(
    cwdReference: string,
    operands: readonly EmployeeCaseGitOperand[],
  ): Completion<RepositoryCandidateGitOutcome>
  close(): Completion<void>
}

export interface EmployeeCaseWorkspaceEffectsFactory {
  acquire(): Completion<EmployeeCaseWorkspaceEffects>
}
