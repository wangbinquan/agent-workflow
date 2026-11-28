// RFC-626 §3.6 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md, last paragraph of
// "仍会以错误结束的情形"): the cause of a failed upgrade has to be readable.
//
// A database client throws values that are not `Error` instances. The wrappers on the source
// side used `String(error)` for those, so an upgrade that failed on PostgreSQL reported
// "[object Object]" as its cause (proposal §1.1 M5). They now read the message the value
// carries. This file locks the three wrappers: the reader-level `sourceFailure`, the source
// adapter (which also decides the failure category from that text) and the backup adapter.
import { describe, expect, test } from 'bun:test'
import { errorCode, errorText } from '@/platform/persistence/migration/errorText'
import { SourceBlockedError, sourceFailure } from '@/platform/persistence/migration/sourceTypes'
import { createEpochSourceAdapter } from '@/modules/system-operations/infrastructure/epochSwitch/sourceAdapter'
import { createEpochBackupAdapter } from '@/modules/system-operations/infrastructure/epochSwitch/backupAdapter'
import { EpochSwitchError } from '@/modules/system-operations/domain/epochSwitch/model'
import type { FrozenSourceHandle } from '@/platform/persistence/migration/run/types'

/** What a PostgreSQL client rejects with: a plain object carrying the server's message. */
const clientError = (message: string, code = '57P01') => ({ message, code, severity: 'FATAL' })

describe('RFC-626 readable failure causes on the source side', () => {
  test('errorText reads an Error, a value that carries a message, and only then stringifies', () => {
    expect(errorText(new Error('plain failure'))).toBe('plain failure')
    expect(errorText(clientError('terminating connection'))).toBe('terminating connection')
    expect(errorText('just text')).toBe('just text')
    expect(errorText(42)).toBe('42')
    expect(errorText(null)).toBe('null')
    expect(errorText(undefined)).toBe('undefined')
    // A message that is not text, or is empty, is no message.
    expect(errorText({ message: 7 })).toBe('[object Object]')
    expect(errorText({ message: '' })).toBe('[object Object]')
    expect(errorCode(clientError('x', '23505'))).toBe('23505')
    expect(errorCode(new Error('no code'))).toBeNull()
    expect(errorCode({ code: 5 })).toBeNull()
    expect(errorCode('text')).toBeNull()
  })

  test('sourceFailure keeps a source error as it is and reads the message of anything else', () => {
    const blocked = new SourceBlockedError('already a source error')
    expect(sourceFailure(blocked)).toBe(blocked)
    const wrapped = sourceFailure(clientError('relation "agent_workflow.tasks" does not exist'))
    expect(wrapped).toBeInstanceOf(SourceBlockedError)
    expect(wrapped.message).toBe('relation "agent_workflow.tasks" does not exist')
    expect(wrapped.message).not.toContain('[object Object]')
    expect(sourceFailure(new TypeError('not a database')).message).toBe('not a database')
    expect(sourceFailure('text').message).toBe('text')
    expect(sourceFailure(undefined).message).toBe('undefined')
  })

  const request = {
    location: { kind: 'postgresql-database' as const, profileRef: 'env:RFC626_SOURCE' },
    emptyTables: [],
    operationRoot: '/nonexistent/rfc626-operation',
  }
  const failing = (failure: unknown) =>
    createEpochSourceAdapter({
      async resolve() {
        throw failure
      },
    })

  test('the source adapter reports the message of a client error for both freeze and discover', async () => {
    for (const open of ['freeze', 'discover'] as const) {
      const adapter = failing(clientError('terminating connection due to administrator command'))
      const error = await adapter[open](request).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(EpochSwitchError)
      expect(error).toMatchObject({
        category: 'source-blocked',
        code: 'source-blocked',
        message: 'terminating connection due to administrator command',
      })
    }
  })

  test('the failure category is decided from that message, also for a value that is not an Error', async () => {
    for (const [message, category] of [
      ['source-changed: source differs from its frozen copy', 'source-changed'],
      ['Source changed since it was frozen; a new freeze/plan is required', 'source-changed'],
      ['postgresql-scratch-not-empty', 'scratch-required'],
      ['unknown source catalog', 'source-blocked'],
    ] as const) {
      // Thrown as an Error and thrown as a client object: the same category either way.
      for (const failure of [new Error(message), clientError(message)])
        await expect(failing(failure).freeze(request)).rejects.toMatchObject({ category, message })
    }
  })

  test('a failure of the upgrade itself passes through the adapter untouched', async () => {
    const failure = new EpochSwitchError('v3-scratch-required', { category: 'scratch-required' })
    await expect(failing(failure).freeze(request)).rejects.toBe(failure)
  })

  test('the backup adapter reports the message of whatever made the backup fail', async () => {
    // A handle the source access never issued: looking up its details is what fails here.
    const foreign = {} as FrozenSourceHandle
    const error = await createEpochBackupAdapter()
      .create({ operationId: 'dbm_rfc626_backup', source: foreign, destination: '/nonexistent' })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EpochSwitchError)
    expect(error).toMatchObject({
      category: 'backup-failed',
      code: 'backup-failed',
      message: 'frozen-source-handle-not-owned',
    })
    // A client object thrown while a backup of a real handle is written is covered next to the
    // backups themselves (rfc626-backup-and-artifact-links.test.ts).
  })
})
