// RFC-349 compatibility facade. SQLite mechanics live in collaboration
// infrastructure; provider-neutral transports use collaboration public
// commands/queries. Pure clarify decision helpers remain available at their
// historical import path while callers are cut over.

export * from '@/modules/collaboration/infrastructure/legacySqliteClarifyRounds'
