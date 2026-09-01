// RFC-349 — compatibility export for the legacy SQLite package engine.
// Provider mechanisms live under platform/persistence; transport callers only
// retain the historical pure lowering API while bootstrap selects the engine.

export * from '@/platform/persistence/sqlite/legacyResourcePackageBundleLower'
