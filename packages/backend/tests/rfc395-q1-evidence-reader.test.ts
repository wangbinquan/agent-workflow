import { expect, test } from 'bun:test'
import { readNodeRunLegacyEvidence } from '@/modules/task-execution/infrastructure/nodeRunLegacyEvidence'
import { projectNodeRunDisplayValues } from '@/modules/task-execution/domain/nodeRunDisplayProjection'
import { contentRefColumns } from '@/platform/content/contentStore'
import { canonicalValue } from '@/platform/persistence/migration/conversion/migrationKey'

const row = {
  id: 'n',
  taskId: 't',
  recordMode: 'history-only',
  role: null,
  slotKey: null,
  attemptIndex: null,
  scopePath: null,
}
const bytes = (values: Record<string, string | number | null>) =>
  new TextEncoder().encode(
    JSON.stringify({
      format: 'node-run-evidence@2',
      sourceRef: { table: 'node_runs', key: 'fixture', phase: 'current' },
      sourceValues: Object.fromEntries(
        Object.entries({ id: 'n', task_id: 't', ...values }).map(([k, v]) => [
          k,
          canonicalValue(v),
        ]),
      ),
    }),
  )
function inline(data: Uint8Array) {
  const ref = contentRefColumns.encode({
    version: 1,
    kind: 'inline',
    bytes: data,
    location: { codec: 'evidence', value: 'n' },
    contentId: null,
    contentVersion: null,
    sha256: null,
    size: data.length,
    mediaType: 'application/json',
  })
  return { contentRefJson: ref.json, contentInlineBytes: ref.inlineBytes }
}
const noRead = {
  read: async () => {
    throw new Error('unexpected content read')
  },
}

test('one evidence decoder restores only absent columns and preserves target seq', async () => {
  const source = await readNodeRunLegacyEvidence(
    row,
    inline(
      bytes({
        retry_index: 4,
        scope_path: 'old',
        seq: 3,
        failure_code: 'old-failure',
        error_message: 'old-message',
      }),
    ),
    noRead,
  )
  expect(
    projectNodeRunDisplayValues(
      {
        retryIndex: null,
        scopePath: null,
        seq: 101,
        failureCode: null as string | null,
        errorMessage: 'current',
      },
      source,
      'n',
    ),
  ).toEqual({
    retryIndex: 4,
    scopePath: 'old',
    seq: 101,
    failureCode: 'old-failure',
    errorMessage: 'current',
  })
})

test('missing, malformed and mismatched evidence never becomes a default attempt', async () => {
  await expect(readNodeRunLegacyEvidence(row, null, noRead)).rejects.toThrow(
    'node-run-display-evidence-missing:n',
  )
  await expect(
    readNodeRunLegacyEvidence(row, inline(bytes({ id: 'other' })), noRead),
  ).rejects.toThrow('node-run-display-evidence-identity-mismatch:n')
  await expect(
    readNodeRunLegacyEvidence(row, inline(new TextEncoder().encode('{}')), noRead),
  ).rejects.toThrow()
  expect(() => projectNodeRunDisplayValues({ retryIndex: null, scopePath: null }, {}, 'n')).toThrow(
    'retry_index',
  )
  expect(() =>
    projectNodeRunDisplayValues({ retryIndex: null, scopePath: null }, { retry_index: 0 }, 'n'),
  ).toThrow('scope_path')
})

test('external evidence uses the content reader and executable facts do not demand evidence', async () => {
  const data = bytes({ retry_index: 2, scope_path: '' })
  const ref = contentRefColumns.encode({
    version: 1,
    kind: 'local-file',
    location: { codec: 'evidence', value: 'n' },
    contentId: null,
    contentVersion: null,
    sha256: null,
    size: data.length,
    mediaType: 'application/json',
  })
  let reads = 0
  const source = await readNodeRunLegacyEvidence(
    row,
    { contentRefJson: ref.json, contentInlineBytes: null },
    {
      read: async () => {
        reads++
        return data
      },
    },
  )
  expect(source).toMatchObject({ retry_index: 2, scope_path: '' })
  expect(reads).toBe(1)
  expect(
    await readNodeRunLegacyEvidence(
      {
        ...row,
        recordMode: 'executable',
        role: 'node-attempt',
        slotKey: 'slot',
        attemptIndex: 0,
        scopePath: '',
      },
      null,
      noRead,
    ),
  ).toBeNull()
})
