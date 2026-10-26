import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
const cleanups = new WeakMap<PersistenceDb, Set<() => Promise<void>>>()
/** Application scopes end before their fixture connection, independently of Bun hook nesting. */
export function registerProviderFixtureCleanup(
  db: PersistenceDb,
  cleanup: () => Promise<void>,
): void {
  let entries = cleanups.get(db)
  if (!entries) {
    entries = new Set()
    cleanups.set(db, entries)
  }
  entries.add(cleanup)
}
export async function closeProviderFixtureApplications(db: PersistenceDb): Promise<void> {
  const entries = cleanups.get(db)
  cleanups.delete(db)
  if (!entries) return
  for (const cleanup of [...entries].reverse()) await cleanup()
}
