import { runChecked, runProcess } from '../core/process'
import type { StoredMergeRequest, StoredProject } from './stateful-store'

export interface StoredDiffEntry {
  oldPath: string | null
  newPath: string | null
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  patch: string
  additions: number
  deletions: number
  omission: 'none' | 'binary' | 'too-large'
}

/** Build the provider diff from the same bare Git objects its smart-HTTP ref serves. */
export async function readStoredDiff(
  project: StoredProject,
  mr: StoredMergeRequest,
): Promise<StoredDiffEntry[]> {
  const names = await runProcess(
    'git',
    ['diff', '--name-status', '-z', '--find-renames', mr.baseSha, mr.headSha, '--'],
    { cwd: project.repositoryPath },
  )
  if (names.exitCode !== 0) {
    throw new Error(`could not compute mock merge-request diff: ${names.stderr.toString('utf8')}`)
  }

  const fields = names.stdout.toString('utf8').split('\0')
  const entries: StoredDiffEntry[] = []
  for (let index = 0; index < fields.length; ) {
    const marker = fields[index++]
    if (marker === undefined || marker === '') break
    const code = marker[0]
    const oldPath = fields[index++]
    if (oldPath === undefined || oldPath === '') break
    const renamed = code === 'R' || code === 'C'
    const newPath = renamed ? fields[index++] : oldPath
    if (newPath === undefined || newPath === '') break

    const paths = renamed ? [oldPath, newPath] : [newPath]
    const stats = await readStats(project.repositoryPath, mr, paths)
    const displayPath = code === 'D' ? oldPath : newPath
    const forced = project.diffOmissions[displayPath]
    const omission = forced ?? (stats.binary ? 'binary' : 'none')
    const patch = omission === 'none' ? await readPatch(project.repositoryPath, mr, paths) : ''

    entries.push({
      oldPath: code === 'A' ? null : oldPath,
      newPath: code === 'D' ? null : newPath,
      status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : renamed ? 'renamed' : 'modified',
      patch,
      additions: stats.binary ? 0 : stats.additions,
      deletions: stats.binary ? 0 : stats.deletions,
      omission,
    })
  }
  return entries
}

async function readStats(
  repositoryPath: string,
  mr: StoredMergeRequest,
  paths: string[],
): Promise<{ additions: number; deletions: number; binary: boolean }> {
  const text = await runChecked(
    'git',
    ['diff', '--numstat', mr.baseSha, mr.headSha, '--', ...paths],
    { cwd: repositoryPath },
  )
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? ''
  const [added = '0', removed = '0'] = line.split('\t')
  const binary = added === '-' || removed === '-'
  return {
    additions: binary ? 0 : Number.parseInt(added, 10) || 0,
    deletions: binary ? 0 : Number.parseInt(removed, 10) || 0,
    binary,
  }
}

async function readPatch(
  repositoryPath: string,
  mr: StoredMergeRequest,
  paths: string[],
): Promise<string> {
  const complete = await runChecked(
    'git',
    ['diff', '--no-ext-diff', '--no-color', '--unified=3', mr.baseSha, mr.headSha, '--', ...paths],
    { cwd: repositoryPath },
  )
  const firstHunk = complete.indexOf('@@ ')
  return firstHunk < 0 ? '' : `${complete.slice(firstHunk).trimEnd()}\n`
}
