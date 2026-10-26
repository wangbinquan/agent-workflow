import type { WorkspaceExcludeProfileFactory } from '@/modules/source-control/public/participants'
// Runtime task fixtures need a real bound mount before profile refresh or checkpoints.
import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export function initializeTaskWorkspace(path: string): void {
  mkdirSync(path, { recursive: true })
  for (const args of [
    ['init', '-q', '-b', 'main'],
    [
      '-c',
      'user.name=Task fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '--allow-empty',
      '-qm',
      'task workspace fixture',
    ],
  ]) {
    const result = spawnSync('git', args, { cwd: path, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`task workspace fixture: ${result.stderr}`)
  }
}

export const memoryTaskWorkspaceProfiles: WorkspaceExcludeProfileFactory = {
  bind({ workspaceRef }) {
    if (!workspaceRef.startsWith('memory:'))
      throw new Error(`unexpected-memory-workspace:${workspaceRef}`)
    return {
      async ensure(input) {
        return {
          version: 1,
          digest: `memory-profile:${workspaceRef}`,
          directChildMounts: input?.directChildMounts ?? [],
        }
      },
    }
  },
}
