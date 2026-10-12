// RFC-371: copying a complete sealed history must not issue a new query per
// namespace, cap the population, or copy the group declarations into raw facts.
import { expect, test } from 'bun:test'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { completeWorkingTraversal } from '@/modules/run-observability/application/completeWorkingTraversal'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-371 original TEMP population prefix operations', (harness) => {
  const run = () => {
    const binding = harness.applicationBinding
    return originalReportSnapshotSession(
      binding.provider === 'sqlite'
        ? { ...binding, generationId: 'workspace-prefix-original' }
        : { provider: 'postgresql', runtime: binding.runtime },
    )
  }
  test('one real statement copies all 1007 namespaces and 3021 rows, preserving documents, exclusions, and neighboring populations', async () => {
    await run().run(async (snapshot) => {
      const rows = snapshot.workspace
      if (!rows.copyNamespacePrefix || !rows.clearNamespacePrefix)
        throw new Error('Original TEMP prefix operations missing')
      for (let group = 0; group < 1007; group++) {
        const name = '/group-' + String(group).padStart(5, '0')
        await rows.insert(
          'prepared' + name,
          Array.from({ length: 3 }, (_, n) => ({
            key: String(n),
            document: {
              group,
              n,
              input: '9007199254740997',
              cacheRead: '13',
              cacheWrite: '17',
              output: '19',
            },
          })),
        )
      }
      await rows.insert('prepared/@groups', [{ key: '/group-00000', document: { rows: '3' } }])
      await rows.insert('prepared-neighbor/group', [{ key: 'neighbor', document: 'must remain' }])
      const recording = harness.recordStatements()
      try {
        await rows.copyNamespacePrefix('prepared', 'restored', ['/@groups'])
        const copies = recording.statements.filter(
          (row) => /INSERT INTO aw_report_workspace/i.test(row.sql) && /SELECT/i.test(row.sql),
        )
        expect(copies).toHaveLength(1)
      } finally {
        recording.stop()
      }
      let population = 0
      for (let group = 0; group < 1007; group++) {
        const name = '/group-' + String(group).padStart(5, '0')
        const source = [],
          restored = []
        for await (const row of completeWorkingTraversal(rows, 'prepared' + name)) source.push(row)
        for await (const row of completeWorkingTraversal(rows, 'restored' + name))
          restored.push(row)
        expect(restored).toEqual(source)
        population += restored.length
      }
      expect(population).toBe(3021)
      expect(await rows.get('restored/@groups', '/group-00000')).toBeUndefined()
      expect(await rows.get('restored-neighbor/group', 'neighbor')).toBeUndefined()
      await rows.clearNamespacePrefix('prepared')
      expect(await rows.get('prepared/@groups', '/group-00000')).toBeUndefined()
      expect(await rows.get('prepared/group-00000', '0')).toBeUndefined()
      expect(await rows.get('prepared-neighbor/group', 'neighbor')).toBe('must remain')
      expect(await rows.get('restored/group-01006', '2')).toEqual({
        group: 1006,
        n: 2,
        input: '9007199254740997',
        cacheRead: '13',
        cacheWrite: '17',
        output: '19',
      })
    })
  }, 60_000)
  test('prefix operations retain the original snapshot lifetime and reject calls after its release', async () => {
    const rows = await run().run(async (snapshot) => snapshot.workspace)
    expect(rows.copyNamespacePrefix!('from', 'to', [])).rejects.toThrow(
      'Report snapshot already closed',
    )
    expect(rows.clearNamespacePrefix!('from')).rejects.toThrow('Report snapshot already closed')
  })
})
