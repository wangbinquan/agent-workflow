import { setDefaultTimeout, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { createLocalEpochArtifacts } from '@/modules/system-operations/infrastructure/epochSwitch/fileJournal'
import {
  createHostedEpochArtifactPort,
  type HostedEpochArtifacts,
} from '@/modules/system-operations/infrastructure/epochSwitch/metaJournal'
import { seedRequiredRows } from './helpers/rfc395V2/integrationFixtures'
import { resolvePostgresqlTestUrlEnv } from './helpers/eachProvider'
import {
  composeHostedEpochSwitch,
  parseHostedEpochJob,
  runHostedEpochSwitchJob,
  verifyHostedEpochSwitch,
  restoreHostedEpoch1Backup,
  type HostedEpochJobEntryDependencies,
} from '@/bootstrap/epochMigrationHosted'
import {
  createHostedEpochActivation,
  type HostedEpochSwitchControl,
} from '@/modules/system-operations/infrastructure/epochSwitch/hostedActivation'
import { createMetaEpochSwitchJournal } from '@/modules/system-operations/infrastructure/epochSwitch/metaJournal'
import { describeV3Providers } from './helpers/rfc395V3Harness'
import { takeOverEpochSwitch } from '@/modules/system-operations/domain/epochSwitch/transitions'
import { createEpochSwitchJournal } from '@/modules/system-operations/domain/epochSwitch/model'
import { plannedFixture } from './helpers/rfc395V3SwitchFixture'

// The hosted migration job and complete frozen backup take about 23 s per CI-scaled case; allow 70 s.
setDefaultTimeout(70000)

const env = {
  CS_DATABASE_MIGRATION_OPERATION_ID: 'dbm_e2_hosted_fixture',
  CS_DATABASE_MIGRATION_SOURCE_URL: 'postgresql://source.invalid/source',
  CS_DATABASE_MIGRATION_TARGET_URL: 'postgresql://target.invalid/target',
  CS_DATABASE_MIGRATION_SOURCE_GENERATION: 'dbg_hosted_source',
  CS_DATABASE_MIGRATION_FREEZE_REFERENCE: 'freeze-ack',
}

test('hosted env contract is explicit and bad configuration fails before composition', () => {
  expect(parseHostedEpochJob(env).action).toBe('plan')
  for (const name of [
    'CS_DATABASE_MIGRATION_OPERATION_ID',
    'CS_DATABASE_MIGRATION_TARGET_URL',
    'CS_DATABASE_MIGRATION_SOURCE_GENERATION',
  ] as const)
    expect(() => parseHostedEpochJob({ ...env, [name]: undefined })).toThrow()
  expect(() =>
    parseHostedEpochJob({
      ...env,
      CS_DATABASE_MIGRATION_ACTION: 'run',
      CS_DATABASE_MIGRATION_FREEZE_REFERENCE: undefined,
    }),
  ).toThrow('FREEZE_REFERENCE')
  expect(() => parseHostedEpochJob(env, 'restore')).toThrow('RESTORE_REFERENCE')
})

test('hosted entries emit plan and receipt lines and close the Job handle', async () => {
  const f = await plannedFixture()
  try {
    let closed = 0
    const app = f.app
    const deps: HostedEpochJobEntryDependencies = {
      async compose() {
        return {
          application: {
            ...app,
            async plan() {
              return f.plan
            },
            async restoreBackup() {
              return f.plan
            },
          },
          async close() {
            closed++
          },
        }
      },
    }
    expect(await runHostedEpochSwitchJob(env, deps)).toStartWith('CS_DATABASE_MIGRATION_PLAN=')
    expect(
      await restoreHostedEpoch1Backup(
        { ...env, CS_DATABASE_RESTORE_REFERENCE: 'epoch1-archive' },
        deps,
      ),
    ).toStartWith('CS_DATABASE_MIGRATION_PLAN=')
    const bound = {
      ...env,
      CS_DATABASE_MIGRATION_OPERATION_ID: f.operationId,
      CS_DATABASE_MIGRATION_ACTION: 'run',
      CS_DATABASE_MIGRATION_APPROVE: f.plan.plan.approvalDigest,
    }
    expect(await runHostedEpochSwitchJob(bound, deps)).toStartWith('CS_DATABASE_MIGRATION_RECEIPT=')
    expect(await verifyHostedEpochSwitch(bound, deps)).toStartWith('CS_DATABASE_MIGRATION_RECEIPT=')
    expect(closed).toBe(4)
  } finally {
    f.close()
  }
})

test('hosted preparation does not perform the platform switch; rollback follows retirement', async () => {
  const f = await plannedFixture()
  try {
    let prepared = 0
    let rolledBack = 0
    const control = {
      async prepared() {
        prepared++
      },
      async observe() {
        return { pointsAt: 'source' as const, pointerDigest: null }
      },
      async rollback() {
        expect(f.control.state).toBe('retired')
        rolledBack++
      },
    }
    const activation = createHostedEpochActivation(control)
    const journal = (await f.deps.journal.read(f.operationId))!
    await activation.activate({
      journal: createEpochSwitchJournal({ ...journal.payload, deployment: 'crewstation' }),
      receiptDigest: f.plan.plan.digest,
      pointer: null,
    })
    expect(prepared).toBe(1)
    expect((await activation.observe(f.operationId)).pointsAt).toBe('source')
    await f.target.retireIfUnwritten()
    await activation.restorePrevious({ previousBytes: null, firstLiveWriteAt: null })
    expect(rolledBack).toBe(1)
  } finally {
    f.close()
  }
})

describeV3Providers('hosted journal native meta CAS', (h) => {
  test('revision, digest, owner fence and artifacts persist independently of a Job', async () => {
    await h.installHead()
    const f = await plannedFixture()
    try {
      const original = (await f.deps.journal.read(f.operationId))!
      const initial = createEpochSwitchJournal({
        ...original.payload,
        deployment: 'crewstation',
        revision: 0,
        previousDigest: null,
      })
      const store = createMetaEpochSwitchJournal({
        connection: h.target,
        scratchRoot: h.appHome,
        artifacts: { writeOnce: f.deps.journal.writeOnce, read: f.deps.journal.readArtifact },
        async acquireOperationLock() {
          return { release() {} }
        },
      })
      await store.create(initial)
      const next = takeOverEpochSwitch(initial, 'new-job-owner', 124)
      const expected = {
        operationId: initial.payload.operationId,
        revision: 0,
        digest: initial.digest,
      }
      await store.compareAndSwap(expected, next)
      await expect(store.compareAndSwap(expected, next)).rejects.toThrow('stale-revision-or-owner')
      expect((await store.read(f.operationId))!.digest).toBe(next.digest)
      expect(await store.list()).toHaveLength(1)
      await store.writeOnce(f.operationId, 'proof.json', Buffer.from('{}'))
      await expect(
        store.writeOnce(f.operationId, 'proof.json', Buffer.from('{"changed":true}')),
      ).rejects.toThrow('write-once-conflict')
    } finally {
      f.close()
    }
  })
})

function durableArtifacts() {
  const files = new Map<string, Uint8Array>()
  const store: HostedEpochArtifacts = {
    async writeOnce(op, name, bytes) {
      const key = `${op}/${name}`
      if (files.has(key) && bytesDigest(files.get(key)!) !== bytesDigest(bytes))
        throw new Error('write-once-conflict')
      files.set(key, Uint8Array.from(bytes))
      return { path: null, digest: bytesDigest(bytes) }
    },
    async read(op, name) {
      return files.get(`${op}/${name}`) ?? null
    },
  }
  return { store, files }
}

test('artifact ports retain multiple streamed versions and rematerialize after Job scratch loss', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-artifacts-'))
  try {
    const durable = durableArtifacts()
    const firstRoot = join(root, 'first')
    const first = createHostedEpochArtifactPort({
      store: durable.store,
      operationId: env.CS_DATABASE_MIGRATION_OPERATION_ID,
      root: firstRoot,
    })
    const chunks = [Buffer.alloc(4 * 1024 * 1024, 7), Buffer.from('tail')]
    const original = await first.put(
      'source/upgrade.sqlite',
      (async function* () {
        yield* chunks
      })(),
    )
    const replacement = await first.put('source/upgrade.sqlite', Buffer.from('next version'))
    expect(original).not.toBe(replacement)
    rmSync(firstRoot, { recursive: true, force: true })
    const next = createHostedEpochArtifactPort({
      store: durable.store,
      operationId: env.CS_DATABASE_MIGRATION_OPERATION_ID,
      root: join(root, 'next'),
    })
    expect(readFileSync(await next.get('source/upgrade.sqlite', original))).toEqual(
      Buffer.concat(chunks),
    )
    expect(readFileSync(await next.get('source/upgrade.sqlite', replacement), 'utf8')).toBe(
      'next version',
    )
    const key = [...durable.files.keys()].find(
      (name) => name.includes(original.slice(7)) && name.endsWith('/0'),
    )!
    durable.files.set(key, Buffer.from('changed persisted chunk'))
    await expect(next.get('source/upgrade.sqlite', original)).rejects.toThrow(
      'artifact-digest-mismatch',
    )
    await expect(next.get('absent', original)).rejects.toThrow('artifact-missing')
    const local = createLocalEpochArtifacts(join(root, 'standalone'))
    const a = await local.put('evidence.bin', Buffer.from('a'))
    const b = await local.put('evidence.bin', Buffer.from('b'))
    expect(readFileSync(await local.get('evidence.bin', a), 'utf8')).toBe('a')
    expect(readFileSync(await local.get('evidence.bin', b), 'utf8')).toBe('b')
    writeFileSync(join(root, 'standalone', '.artifacts', a.slice(7), 'evidence.bin'), 'corrupt')
    await expect(local.get('evidence.bin', a)).rejects.toThrow('artifact-digest-mismatch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hosted parser exposes new-run, discard and complete with explicit discard confirmation', () => {
  expect(parseHostedEpochJob({ ...env, CS_DATABASE_MIGRATION_ACTION: 'new-run' }).action).toBe(
    'new-run',
  )
  expect(parseHostedEpochJob({ ...env, CS_DATABASE_MIGRATION_ACTION: 'complete' }).action).toBe(
    'complete',
  )
  expect(() => parseHostedEpochJob({ ...env, CS_DATABASE_MIGRATION_ACTION: 'discard' })).toThrow(
    'discard-confirm-required',
  )
  expect(
    parseHostedEpochJob({
      ...env,
      CS_DATABASE_MIGRATION_ACTION: 'discard',
      CS_DATABASE_MIGRATION_CONFIRM: 'discard',
    }).action,
  ).toBe('discard')
})

// RFC-395 design gate F1: the hosted Job had no way to make the per-item acknowledgement the user
// approved for stranded legacy code work, so a hosted plan holding such an item stayed blocked.
test('hosted acknowledge names every item, its operator and reason, and returns the replacement plan', async () => {
  const ack = {
    ...env,
    CS_DATABASE_MIGRATION_ACTION: 'acknowledge',
    CS_DATABASE_MIGRATION_ACKNOWLEDGE_ITEMS: 'item-a, item-b\nitem-c',
    CS_DATABASE_MIGRATION_ACKNOWLEDGE_BY: 'operator',
    CS_DATABASE_MIGRATION_ACKNOWLEDGE_REASON: 'archive retired work',
  }
  expect(parseHostedEpochJob(ack).acknowledgement).toEqual({
    items: ['item-a', 'item-b', 'item-c'],
    by: 'operator',
    reason: 'archive retired work',
  })
  expect(() =>
    parseHostedEpochJob({ ...ack, CS_DATABASE_MIGRATION_ACKNOWLEDGE_ITEMS: ' , ' }),
  ).toThrow('CS_DATABASE_MIGRATION_ACKNOWLEDGE_ITEMS')
  for (const name of [
    'CS_DATABASE_MIGRATION_ACKNOWLEDGE_BY',
    'CS_DATABASE_MIGRATION_ACKNOWLEDGE_REASON',
  ] as const)
    expect(() => parseHostedEpochJob({ ...ack, [name]: undefined })).toThrow(name)
  expect(parseHostedEpochJob(env).acknowledgement).toBeUndefined()
  // Round 2 N2: the replacement plan reads the source again, so the source is a required input;
  // an old-epoch backup operation reads it from the restore reference instead.
  expect(() =>
    parseHostedEpochJob({ ...ack, CS_DATABASE_MIGRATION_SOURCE_URL: undefined }),
  ).toThrow('v3-hosted-env-required:CS_DATABASE_MIGRATION_SOURCE_URL')
  expect(
    parseHostedEpochJob({
      ...ack,
      CS_DATABASE_MIGRATION_SOURCE_URL: undefined,
      CS_DATABASE_RESTORE_REFERENCE: 'epoch1-archive',
    }).action,
  ).toBe('acknowledge')

  const f = await plannedFixture()
  try {
    const calls: unknown[] = []
    let closed = 0
    const deps: HostedEpochJobEntryDependencies = {
      async compose() {
        return {
          application: {
            ...f.app,
            async acknowledge(input) {
              calls.push(input)
              return f.plan
            },
          },
          async close() {
            closed++
          },
        }
      },
    }
    expect(
      await runHostedEpochSwitchJob(
        { ...ack, CS_DATABASE_MIGRATION_OPERATION_ID: f.operationId },
        deps,
      ),
    ).toBe(`CS_DATABASE_MIGRATION_PLAN=${JSON.stringify(f.plan)}`)
    expect(calls).toEqual([
      {
        operationId: f.operationId,
        items: ['item-a', 'item-b', 'item-c'],
        by: 'operator',
        reason: 'archive retired work',
      },
    ])
    expect(closed).toBe(1)
  } finally {
    f.close()
  }
})

describeV3Providers('real hosted composition', (h) => {
  if (h.targetProvider !== 'postgresql') return
  const jobEnv = async () => {
    const url = new URL(process.env[resolvePostgresqlTestUrlEnv(process.env)!]!)
    const sourceUrl = new URL(url)
    sourceUrl.pathname = `/${(await h.source.sourceHarness.native.execute('SELECT current_database() AS name'))[0]!.name}`
    url.pathname = `/${(await h.target.execute('SELECT current_database() AS name'))[0]!.name}`
    return {
      ...env,
      CS_DATABASE_MIGRATION_SOURCE_URL: sourceUrl.toString(),
      CS_DATABASE_MIGRATION_TARGET_URL: url.toString(),
      CS_DATABASE_MIGRATION_SCRATCH_ROOT: join(h.appHome, 'job-one'),
    }
  }
  test('a nonempty target is rejected by the real composer before journal installation', async () => {
    await h.target.execute('CREATE TABLE public.v3_composition_existing (id integer)')
    try {
      const contract = parseHostedEpochJob(await jobEnv())
      await expect(
        composeHostedEpochSwitch(contract, {
          head: h.head,
          catalogArtifacts: [await h.catalog()],
          sourceManifest: () => h.source.sourceHarness.manifest(),
          artifacts: durableArtifacts().store,
          verifyFreeze: async () => true,
          control: {
            async prepared() {},
            async observe() {
              return { pointsAt: 'source', pointerDigest: null }
            },
            async rollback() {},
          },
        }),
      ).rejects.toThrow('target-not-empty')
      expect(
        (
          await h.target.execute(
            "SELECT to_regclass('agent_workflow_meta.migration_operations') AS name",
          )
        )[0]!.name,
      ).toBeNull()
    } finally {
      await h.target.execute('DROP TABLE public.v3_composition_existing')
    }
  })

  test('hosted new-run keeps its journal and retired target while selecting another empty database', async () => {
    await h.source.install()
    await seedRequiredRows(h.source)
    const sourceEnv = await jobEnv()
    const nextUrl = new URL(sourceEnv.CS_DATABASE_MIGRATION_TARGET_URL)
    const name = `v3_next_${crypto.randomUUID().replaceAll('-', '')}`
    const admin = new SQL(process.env[resolvePostgresqlTestUrlEnv(process.env)!]!, { max: 1 })
    await admin.unsafe(`CREATE DATABASE "${name}"`)
    nextUrl.pathname = `/${name}`
    try {
      let interrupt = true
      let prepared: Parameters<HostedEpochSwitchControl['prepared']>[0] | undefined
      const options = {
        head: h.head,
        catalogArtifacts: [await h.catalog()],
        sourceManifest: () => h.source.sourceHarness.manifest(),
        artifacts: durableArtifacts().store,
        sourceBornOnPostgresql: true,
        verifyFreeze: async () => true,
        control: {
          async prepared(input: Parameters<HostedEpochSwitchControl['prepared']>[0]) {
            prepared = input
          },
          async observe() {
            return { pointsAt: 'source' as const, pointerDigest: null }
          },
          async rollback() {},
        },
        faults(point: string) {
          if (interrupt && point === 'after-target-install') {
            interrupt = false
            throw new Error('stop on installed target')
          }
        },
      }
      const deps: HostedEpochJobEntryDependencies = {
        compose: (contract) => composeHostedEpochSwitch(contract, options),
      }
      const line = await runHostedEpochSwitchJob(sourceEnv, deps)
      const plan = JSON.parse(line.slice(line.indexOf('=') + 1)) as {
        plan: { approvalDigest: string }
      }
      await expect(
        runHostedEpochSwitchJob(
          {
            ...sourceEnv,
            CS_DATABASE_MIGRATION_ACTION: 'run',
            CS_DATABASE_MIGRATION_APPROVE: plan.plan.approvalDigest,
          },
          deps,
        ),
      ).rejects.toThrow('stop on installed target')
      await expect(
        runHostedEpochSwitchJob({ ...sourceEnv, CS_DATABASE_MIGRATION_ACTION: 'new-run' }, deps),
      ).rejects.toThrow('new-run-target-required')
      expect(
        (await h.target.execute('SELECT state FROM agent_workflow_meta.generations'))[0]!.state,
      ).toBe('prepared')
      const nextEnv = {
        ...sourceEnv,
        V3_NEXT_TARGET_URL: nextUrl.toString(),
        CS_DATABASE_MIGRATION_NEXT_TARGET_URL_ENV: 'V3_NEXT_TARGET_URL',
        CS_DATABASE_MIGRATION_ACTION: 'new-run',
      }
      const nextLine = await runHostedEpochSwitchJob(nextEnv, deps)
      const approval = JSON.parse(nextLine.slice(nextLine.indexOf('=') + 1)) as {
        operationId: string
        runId: string
        planDigest: string
        approvalDigest: string
        planPath: null
      }
      expect(approval.operationId).toBe(sourceEnv.CS_DATABASE_MIGRATION_OPERATION_ID)
      expect(approval.planPath).toBeNull()
      expect(approval.approvalDigest).not.toBe(plan.plan.approvalDigest)
      expect(
        (await h.target.execute('SELECT state FROM agent_workflow_meta.generations'))[0]!.state,
      ).toBe('retired')
      expect(
        await runHostedEpochSwitchJob(
          {
            ...nextEnv,
            CS_DATABASE_MIGRATION_ACTION: 'run',
            CS_DATABASE_MIGRATION_APPROVE: approval.approvalDigest,
          },
          deps,
        ),
      ).toStartWith('CS_DATABASE_MIGRATION_RECEIPT=')
      const saved = (
        await h.target.execute('SELECT payload_json FROM agent_workflow_meta.migration_operations')
      )[0]!
      const journal = JSON.parse(String(saved.payload_json))
      expect(journal.payload.run.ordinal).toBe(1)
      expect(journal.payload.target.location.profileRef).toBe('env:V3_NEXT_TARGET_URL')
      expect(journal.payload.phase).toBe('activated')
      expect(prepared!.location).toEqual({
        kind: 'postgresql-target',
        profileRef: 'env:V3_NEXT_TARGET_URL',
      })
    } finally {
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
      await admin.close()
    }
  })

  test('a new Job rematerializes frozen artifacts and completes the real provider journey', async () => {
    await h.source.install()
    await seedRequiredRows(h.source)
    const durable = durableArtifacts()
    const options = {
      head: h.head,
      catalogArtifacts: [await h.catalog()],
      sourceManifest: () => h.source.sourceHarness.manifest(),
      artifacts: durable.store,
      sourceBornOnPostgresql: true,
      verifyFreeze: async () => true,
      control: {
        async prepared() {},
        async observe() {
          return { pointsAt: pointsAt, pointerDigest: null }
        },
        async rollback() {
          pointsAt = 'source'
        },
      },
      faults(point: string) {
        if (interrupt && point === 'after-frozen-preflight') {
          interrupt = false
          throw new Error('Job interrupted after freeze')
        }
      },
    }
    let pointsAt: 'source' | 'target' = 'source'
    let interrupt = true
    const firstEnv = await jobEnv()
    const deps: HostedEpochJobEntryDependencies = {
      compose: (contract) => composeHostedEpochSwitch(contract, options),
    }
    const planLine = await runHostedEpochSwitchJob(firstEnv, deps)
    const plan = JSON.parse(planLine.slice(planLine.indexOf('=') + 1)) as {
      plan: { approvalDigest: string; payload: { blocks: unknown[] } }
    }
    expect(plan.plan.payload.blocks).toEqual([])
    const approved = {
      ...firstEnv,
      CS_DATABASE_MIGRATION_ACTION: 'run',
      CS_DATABASE_MIGRATION_APPROVE: plan.plan.approvalDigest,
    }
    await expect(runHostedEpochSwitchJob(approved, deps)).rejects.toThrow('Job interrupted')
    expect([...durable.files.keys()].some((name) => name.includes('/.artifacts/'))).toBe(true)
    rmSync(firstEnv.CS_DATABASE_MIGRATION_SCRATCH_ROOT, { recursive: true, force: true })
    expect(existsSync(firstEnv.CS_DATABASE_MIGRATION_SCRATCH_ROOT)).toBe(false)
    const resumed = { ...approved, CS_DATABASE_MIGRATION_SCRATCH_ROOT: join(h.appHome, 'job-two') }
    const receipt = await runHostedEpochSwitchJob(resumed, deps)
    expect(receipt).toStartWith('CS_DATABASE_MIGRATION_RECEIPT=')
    const generations = await h.target.execute(
      'SELECT state, activation_receipt_digest FROM agent_workflow_meta.generations',
    )
    expect(generations).toHaveLength(1)
    expect(generations[0]!.state).toBe('active')
    expect(generations[0]!.activation_receipt_digest).not.toBeNull()
    pointsAt = 'target'
    expect(await verifyHostedEpochSwitch(resumed, deps)).toStartWith(
      'CS_DATABASE_MIGRATION_RECEIPT=',
    )
    const completed = await runHostedEpochSwitchJob(
      { ...resumed, CS_DATABASE_MIGRATION_ACTION: 'complete' },
      deps,
    )
    expect(JSON.parse(completed.slice(completed.indexOf('=') + 1)).payload.kind).toBe('completed')
  })
})
