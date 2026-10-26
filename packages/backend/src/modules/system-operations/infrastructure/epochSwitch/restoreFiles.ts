import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { EpochRestoreFiles } from '../../application/epochSwitch/session'
import { RestoreFileChangeSchema, type RestoreFileChange } from '../../domain/epochSwitch/documents'
import { EpochSwitchError, type EpochSwitchFaults } from '../../domain/epochSwitch/model'
import { syncEpochDirectory, writeEpochFile } from './fileJournal'

function flushTree(path: string): void {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) flushTree(join(path, name))
    syncEpochDirectory(path)
  } else {
    const fd = openSync(path, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

export function createEpochRestoreFiles(input: {
  appHome: string
  faults?: EpochSwitchFaults
}): EpochRestoreFiles {
  const move = (from: string, to: string) => {
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    syncEpochDirectory(dirname(from))
    syncEpochDirectory(dirname(to))
    input.faults?.('after-restore-file')
  }
  return {
    async plan({ operationRoot, sourceRoot, restoreConfig }) {
      const path = join(operationRoot, 'inputs/restore-files.json')
      if (existsSync(path))
        return RestoreFileChangeSchema.array().parse(JSON.parse(readFileSync(path, 'utf8')))
      const changes: RestoreFileChange[] = []
      const entries = [
        { kind: 'skills' as const, name: 'skills' },
        ...(restoreConfig ? [{ kind: 'config' as const, name: 'config.json' }] : []),
      ]
      for (const { kind, name } of entries) {
        const backup = join(sourceRoot, name)
        if (!existsSync(backup) && kind === 'config')
          throw new EpochSwitchError('v3-backup-config-missing', { category: 'restore-failed' })
        const sourcePath = join(operationRoot, 'inputs/restore-files', name)
        const destinationPath = join(input.appHome, name)
        if (!existsSync(sourcePath)) {
          mkdirSync(dirname(sourcePath), { recursive: true })
          const temporary = `${sourcePath}.${crypto.randomUUID()}.copying`
          if (existsSync(backup))
            cpSync(backup, temporary, { recursive: true, errorOnExist: true, force: false })
          else mkdirSync(temporary)
          flushTree(temporary)
          renameSync(temporary, sourcePath)
          syncEpochDirectory(dirname(sourcePath))
        }
        changes.push({
          kind,
          sourcePath,
          destinationPath,
          replacedPath: existsSync(destinationPath) ? join(operationRoot, 'replaced', name) : null,
        })
      }
      writeEpochFile(path, Buffer.from(JSON.stringify(changes)), true)
      return changes
    },
    async apply(changes) {
      for (const change of changes) {
        if (
          change.replacedPath &&
          !existsSync(change.replacedPath) &&
          existsSync(change.sourcePath)
        ) {
          if (!existsSync(change.destinationPath))
            throw new EpochSwitchError('v3-restore-original-file-missing', {
              category: 'restore-failed',
            })
          move(change.destinationPath, change.replacedPath)
        }
        if (existsSync(change.sourcePath)) {
          if (existsSync(change.destinationPath))
            throw new EpochSwitchError('v3-restore-destination-conflict', {
              category: 'restore-failed',
            })
          move(change.sourcePath, change.destinationPath)
        } else if (!existsSync(change.destinationPath))
          throw new EpochSwitchError('v3-restore-file-missing', { category: 'restore-failed' })
      }
    },
    async rollback(changes) {
      for (const change of [...changes].reverse()) {
        if (!existsSync(change.sourcePath) && existsSync(change.destinationPath))
          move(change.destinationPath, change.sourcePath)
        if (change.replacedPath && existsSync(change.replacedPath)) {
          if (existsSync(change.destinationPath))
            throw new EpochSwitchError('v3-restore-rollback-conflict', {
              category: 'rollback-incomplete',
            })
          move(change.replacedPath, change.destinationPath)
        }
      }
    },
  }
}
