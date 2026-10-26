import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  SourceRetentionPort,
  EpochSwitchJournalPort,
} from '../../application/ports/epochSwitch'
import { EpochSwitchError, type EpochSwitchFaults } from '../../domain/epochSwitch/model'
import { syncEpochDirectory } from './fileJournal'

export function createEpochSourceRetention(input: {
  journal: EpochSwitchJournalPort
  faults?: EpochSwitchFaults
}): SourceRetentionPort {
  return {
    async retain({ operationId, source }) {
      if (source.kind === 'postgresql-database') return [source.profileRef]
      if (source.kind === 'backup') return [source.artifact, source.root]
      const destination = join(input.journal.operationRoot(operationId), 'source')
      mkdirSync(destination, { recursive: true })
      const retained: string[] = []
      for (const suffix of ['', '-wal', '-shm']) {
        const from = `${source.path}${suffix}`
        const to = join(destination, `db.sqlite${suffix}`)
        if (existsSync(from)) {
          if (existsSync(to))
            throw new EpochSwitchError('v3-retained-source-conflict', {
              category: 'receipt-conflict',
            })
          renameSync(from, to)
          syncEpochDirectory(dirname(from))
          syncEpochDirectory(destination)
          input.faults?.('after-retained-source-file')
        }
        if (existsSync(to)) retained.push(to)
      }
      if (!retained.includes(join(destination, 'db.sqlite')))
        throw new EpochSwitchError('v3-retained-source-missing')
      return retained
    },
  }
}
