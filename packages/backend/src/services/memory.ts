// RFC-349 compatibility surface. Database mechanics live in the provider
// infrastructure adapters; existing SQLite callers retain their source-level
// import until composition-root injection is complete.
export * from '@/modules/memory/infrastructure/sqliteMemoryCatalog'
