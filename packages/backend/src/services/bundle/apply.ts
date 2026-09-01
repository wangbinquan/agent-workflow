// RFC-349 — compatibility export for the legacy SQLite package engine.
// The implementation owns its database mechanism in platform/persistence;
// production bootstrap selects this or the PostgreSQL atomic engine explicitly.

export * from '@/platform/persistence/sqlite/legacyResourcePackageBundleApply'
