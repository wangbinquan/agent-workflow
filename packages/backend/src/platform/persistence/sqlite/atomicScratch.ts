/** Atomic synchronous scratch/image edits; supports callers already in a transaction. */
export function atomicScratch<T>(database: { exec(sql: string): unknown }, body: () => T): T {
  database.exec('SAVEPOINT aw_scratch_edit')
  try {
    const result = body()
    if (result instanceof Promise) throw new Error('scratch-edit-must-be-synchronous')
    database.exec('RELEASE SAVEPOINT aw_scratch_edit')
    return result
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT aw_scratch_edit')
    database.exec('RELEASE SAVEPOINT aw_scratch_edit')
    throw error
  }
}
