// RFC-411: the workgroup turn engine and its persistence adapter now both live in task-execution. These cases
// lock the assembly (the composition joins the task-execution adapter to the task-execution engine, with the
// host-ledger factory and the clarify gate the bootstrap hands in) and the one cross-context read the adapter
// keeps: member agents come through the resource catalog's public `AgentExecutionQueries.readMany` (one IN read,
// the bulk decoding the snapshot always used), which for well-formed rows equals the single-agent `read`, on both
// providers.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createAgentExecutionQueries } from '@/modules/resource-catalog/public/queries'
import { describeEachProvider } from './helpers/eachProvider'
import { agentFixture } from './helpers/model'

test('the composition joins the task-execution adapter to the task-execution turn engine', () => {
  const composition = readFileSync(
    resolve(import.meta.dir, '../src/modules/task-execution/composition/workgroupTurns.ts'),
    'utf8',
  )
  expect(composition).toContain(
    "import { createWorkgroupTurnsOperations } from '../engine/task/workgroup/workgroupTurns'",
  )
  expect(composition).toContain("} from '../infrastructure/workgroupTurnsPersistence'")
  expect(composition).toContain(
    'return createWorkgroupTurnsOperations(createWorkgroupTurnsPersistence(dependencies))',
  )
  expect(composition).toContain(
    'inTransaction: (transaction) => hostLedgerFactory.inTransaction(transaction),',
  )
  const adapter = readFileSync(
    resolve(
      import.meta.dir,
      '../src/modules/task-execution/infrastructure/workgroupTurnsPersistence.ts',
    ),
    'utf8',
  )
  expect(adapter).toContain('await createAgentExecutionQueries(transaction).readMany(agentIds)')
  expect(adapter).not.toContain('loadAgentPersistenceRows')
})

describeEachProvider('RFC-411 member agents through the public execution queries', (harness) => {
  test('readMany returns the stored agents (well-formed rows decode as read does); missing ids are absent', async () => {
    const db = harness.db
    const first = ulid()
    const second = ulid()
    await agentFixture(db, {
      id: first,
      name: `wg-member-${first}`,
      outputs: '["result"]',
      bodyMd: 'First member.',
    })
    await agentFixture(db, {
      id: second,
      name: `wg-member-${second}`,
      outputs: '["notes"]',
      bodyMd: 'Second member.',
    })
    const queries = createAgentExecutionQueries(db)
    expect(await queries.readMany([])).toEqual([])
    const many = await queries.readMany([second, first, ulid()])
    const byId = new Map(many.map((agent) => [agent.id, agent]))
    expect([...byId.keys()].sort()).toEqual([first, second].sort())
    expect(byId.get(first)).toEqual((await queries.read(first))!)
    expect(byId.get(second)).toEqual((await queries.read(second))!)
  })
})
