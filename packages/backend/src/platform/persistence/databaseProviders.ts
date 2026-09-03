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
