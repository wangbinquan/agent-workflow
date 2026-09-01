// Compatibility export. Physical database access is owned by System Operations
// infrastructure so callers consume a capability rather than a SQLite surface.

export * from '@/platform/persistence/sqlite/systemMaintenanceState'
