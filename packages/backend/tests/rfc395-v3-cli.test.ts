import { expect, test } from 'bun:test'
import { epochMigrationCommand } from '@/cli/epochMigration'
import type { EpochSwitchApplication } from '@/modules/system-operations/public/commands'

test('all dormant CLI verbs dispatch their explicit options and retain JSON output', async () => {
  const calls: { method: string; input: unknown }[] = []
  const application = new Proxy({} as EpochSwitchApplication, {
    get(_object, method) {
      return async (input: unknown) => {
        calls.push({ method: String(method), input })
        return { result: 'ok', guidance: ['rollback before first write'] }
      }
    },
  })
  for (const [argv, method, expected] of [
    [
      [
        'plan',
        '--target',
        'postgresql',
        '--target-url-env',
        'TARGET_URL',
        '--scratch-url-env',
        'SCRATCH_URL',
        '--archive-empty-table',
        'empty=because',
        '--rehearse',
        '--chunk-rows',
        '12',
      ],
      'plan',
      {
        target: { provider: 'postgresql', urlEnv: 'TARGET_URL' },
        emptyTables: [{ table: 'empty', reason: 'because' }],
        chunkLimit: 12,
      },
    ],
    [
      [
        'acknowledge',
        'op',
        '--item',
        'a',
        '--item',
        'b',
        '--reason',
        'archive',
        '--by',
        'operator',
      ],
      'acknowledge',
      { items: ['a', 'b'], reason: 'archive', by: 'operator' },
    ],
    [
      ['run', 'op', '--approve', 'digest', '--new-run', '--drain-timeout-ms', '100'],
      'run',
      { operationId: 'op', approve: 'digest', newRun: true, drainTimeoutMs: 100 },
    ],
    [
      ['withdraw-acknowledgement', 'op', '--all'],
      'withdrawAcknowledgements',
      { operationId: 'op', decisions: 'all' },
    ],
    [
      ['withdraw-acknowledgement', 'op', '--decision', 'a', '--decision', 'b'],
      'withdrawAcknowledgements',
      { operationId: 'op', decisions: ['a', 'b'] },
    ],
    [['status'], 'status', {}],
    [
      [
        'trace',
        'op',
        'tasks',
        '[{"type":"text","value":"id"}]',
        '--phase',
        'pre-upgrade',
        '--replay',
      ],
      'trace',
      { table: 'tasks', key: [{ type: 'text', value: 'id' }], phase: 'pre-upgrade', replay: true },
    ],
    [['trace', 'op', '--task', 'task'], 'trace', { taskId: 'task' }],
    [['verify', 'op'], 'verify', { operationId: 'op' }],
    [['rollback', 'op'], 'rollback', { operationId: 'op' }],
    [['complete', 'op'], 'complete', { operationId: 'op' }],
    [['discard', 'op', '--confirm'], 'discard', { confirm: true }],
    [['receipt', 'op', 'activation'], 'receipt', { kind: 'activation' }],
    [
      [
        'restore-backup',
        'backup',
        '--target-url-env',
        'TARGET_URL',
        '--restore-config',
        '--content-root',
        '/content',
      ],
      'restoreBackup',
      { artifact: 'backup', restoreConfig: true, contentRoot: '/content' },
    ],
  ] as const) {
    const result = await epochMigrationCommand([...argv, '--json'], { application })
    expect(result.status).toBe('ok')
    expect(JSON.parse(result.output)).toMatchObject({ result: 'ok' })
    expect(calls.at(-1)).toMatchObject({ method, input: expected })
  }
  expect((await epochMigrationCommand(['status'], { application })).output).toContain(
    'rollback before first write',
  )
})

test('usage errors never dispatch, and application failures retain the CLI error exit category', async () => {
  let calls = 0
  const application = new Proxy({} as EpochSwitchApplication, {
    get() {
      return async () => {
        calls++
        throw new Error('v3-drain-timeout')
      }
    },
  })
  for (const argv of [
    [],
    ['unknown'],
    ['withdraw-acknowledgement', 'op'],
    ['withdraw-acknowledgement', 'op', '--all', '--decision', 'a'],
    ['run'],
    ['run', 'op', '--unknown'],
    ['discard', 'op'],
    ['plan', '--target', 'invalid'],
    ['plan', '--chunk-rows', '0'],
    ['plan', '--archive-empty-table', 'table'],
    ['trace', 'op', 'table', '{}'],
    ['trace', 'op', 'table', '[]'],
    ['trace', 'op', 'table', '["untagged"]'],
    ['acknowledge', 'op', '--item', 'a', '--all-unfinished-legacy-code-work', '--reason', 'x'],
    // RFC-395 design gate F2: the user ruled per-item confirmation, so there is no select-all.
    ['acknowledge', 'op', '--all-unfinished-legacy-code-work', '--reason', 'x'],
    ['acknowledge', 'op', '--reason', 'x'],
  ])
    expect((await epochMigrationCommand(argv, { application })).status).toBe('usage-error')
  expect(calls).toBe(0)
  expect(await epochMigrationCommand(['run', 'op'], { application })).toEqual({
    status: 'error',
    output: 'v3-drain-timeout',
  })
})
