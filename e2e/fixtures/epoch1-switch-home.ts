// Bun child only: create frozen epoch-1 input for the shipped epoch-2 switch CLI.
// The subject (plan, activation, rollback and first-write fence) runs in the binary.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  openFrozenEpoch1Db,
  FROZEN_MIGRATIONS,
} from '../../packages/backend/tests/migration-freeze'

const home = process.argv[2]
if (!home) throw new Error('epoch1-switch-home requires an isolated home')
mkdirSync(home, { recursive: true })
const db = openFrozenEpoch1Db({
  path: join(home, 'db.sqlite'),
  migrationsFolder: FROZEN_MIGRATIONS,
})
db.$client.close()
