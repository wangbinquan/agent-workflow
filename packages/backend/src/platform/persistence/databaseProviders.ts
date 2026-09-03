// RFC-349 — the canonical database-provider list.
//
// A leaf module on purpose: the traits table, the schema contract and every
// config/generation enum derive from this tuple, so none of them may import
// each other in a cycle just to learn the provider names.
//
// Adding a provider here is the ONLY place it gets declared. That makes the
// `satisfies Record<DatabaseProvider, …>` tables downstream fail to compile
// until the new provider answers every per-provider decision — see
// `providerTraits.ts` and `packages/backend/tests/rfc349-provider-completeness.test.ts`.

export const DATABASE_PROVIDERS = ['sqlite', 'postgresql'] as const

export type DatabaseProvider = (typeof DATABASE_PROVIDERS)[number]

/**
 * Compile-time exhaustiveness sink for provider dispatch.
 *
 * Put it in the residual branch of every provider fork. While the union is
 * fully handled the argument narrows to `never` and this is unreachable; the
 * moment a provider is added to `DATABASE_PROVIDERS`, the residual widens to
 * that provider and the call **fails to compile** — which is the whole point.
 * It throws rather than returning so a hand-written cast cannot make it silent.
 */
export function unhandledDatabaseProvider(value: never): never {
  const shown =
    typeof value === 'string' ? value : ((value as { provider?: unknown })?.provider ?? value)
  throw new Error(`unhandled database provider: ${String(shown)}`)
}
