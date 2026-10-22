import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { holdsExplicitTransaction } from '@/db/transactionScope'
import { KeyedSerialQueue } from '@/util/keyedSerialQueue'

const queues = new WeakMap<object, KeyedSerialQueue<string>>()

/** Serialize only short host-ledger commits, including their transaction ACK. */
export function runWorkgroupCommit<T>(
  db: PersistenceDb,
  taskId: string,
  commit: () => Promise<T>,
): Promise<T> {
  // DatabaseSession already owns nested transaction reuse. Waiting for an
  // external queue turn here would make its holder wait for itself (or its
  // SQLite writer lease). This branch never releases another caller's turn.
  if (holdsExplicitTransaction(db)) return commit()
  let queue = queues.get(db)
  if (queue === undefined) {
    queue = new KeyedSerialQueue<string>()
    queues.set(db, queue)
  }
  return queue.run(taskId, commit)
}
