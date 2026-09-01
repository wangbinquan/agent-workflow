// RFC-349 — legacy SQLite compatibility surface.
// The provider-specific journal/transaction mechanics live below
// platform/persistence and are selected only by SQLite composition.

export * from '@/platform/persistence/sqlite/legacyResourcePackageCommit'
