import type { SQLWrapper } from 'drizzle-orm'
import type {
  IntentContextResourceAuthorization,
  IntentContextResourceAuthorityPair,
} from '../application/ports/intentPersistence'
import type {
  IntentContextResourceIdentity,
  IntentContextResourceReference,
} from '@/modules/resource-catalog/public/participants'

export type IntentSqlStatement =
  | { readonly kind: 'all'; readonly query: SQLWrapper }
  | { readonly kind: 'get'; readonly query: SQLWrapper }
  | { readonly kind: 'run'; readonly query: SQLWrapper }
  | {
      readonly kind: 'authorize-resource'
      readonly currentAuthority: IntentContextResourceAuthorityPair
      readonly reference: IntentContextResourceReference
    }

export type IntentSqlProgram<T> = Generator<IntentSqlStatement, T, unknown>

export function* allRows<T extends object>(query: SQLWrapper): IntentSqlProgram<readonly T[]> {
  return (yield { kind: 'all', query }) as readonly T[]
}

export function* firstRow<T extends object>(query: SQLWrapper): IntentSqlProgram<T | null> {
  return ((yield { kind: 'get', query }) as T | undefined) ?? null
}

export function* mutation(query: SQLWrapper): IntentSqlProgram<number> {
  return (yield { kind: 'run', query }) as number
}

/**
 * Revalidate a context reference through the provider transaction-bound
 * Resource Catalog participant. Runners resolve this instruction against the
 * exact transaction that is driving the surrounding Intent program.
 */
export function* authorizeIntentContextResource(
  authorization: IntentContextResourceAuthorization,
  reference: IntentContextResourceReference,
): IntentSqlProgram<IntentContextResourceIdentity | null> {
  return (yield {
    kind: 'authorize-resource',
    currentAuthority: authorization.currentAuthority,
    reference,
  }) as IntentContextResourceIdentity | null
}

export interface IntentSqlProgramRunner {
  read<T>(program: () => IntentSqlProgram<T>): Promise<T>
  transaction<T>(program: () => IntentSqlProgram<T>): Promise<T>
}

export function driveSyncProgram<T>(
  program: IntentSqlProgram<T>,
  execute: (statement: IntentSqlStatement) => unknown,
): T {
  let state = program.next()
  while (!state.done) state = program.next(execute(state.value))
  return state.value
}

export async function driveAsyncProgram<T>(
  program: IntentSqlProgram<T>,
  execute: (statement: IntentSqlStatement) => Promise<unknown>,
): Promise<T> {
  let state = program.next()
  while (!state.done) state = program.next(await execute(state.value))
  return state.value
}
