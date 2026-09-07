// RFC-036/RFC-349 — legacy SQLite fixture names. Production callers consume
// AuthRuntime; provider SQL is isolated in infrastructure.

export { assertMatrixGrantable, PatMatrixError } from '@/auth/application/patPolicy'
export * from './legacySqlitePatStore'
