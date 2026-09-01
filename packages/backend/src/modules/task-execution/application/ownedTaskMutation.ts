// RFC-349 — provider-neutral owned mutation command. Each consumer supplies a
// bounded operation record; no transaction callback or provider handle escapes.

import type { OwnershipToken } from '../domain/ownership'

export interface OwnedTaskMutationCommand {
  readonly kind: string
  readonly payload: Readonly<Record<string, unknown>>
}

export interface OwnedTaskMutationPersistence {
  execute(input: {
    readonly token: OwnershipToken
    readonly command: OwnedTaskMutationCommand
    readonly now?: number
  }): Promise<void>
}

export async function executeOwnedTaskMutation(
  persistence: OwnedTaskMutationPersistence,
  input: {
    readonly token: OwnershipToken
    readonly command: OwnedTaskMutationCommand
    readonly now?: number
  },
): Promise<void> {
  await persistence.execute(input)
}
