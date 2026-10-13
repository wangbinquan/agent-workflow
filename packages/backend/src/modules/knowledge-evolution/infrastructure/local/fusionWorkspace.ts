import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_FUSION_MANIFEST, PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import { gitDiffSnapshot, runGit } from '@/util/git'
import type { FusionWorkspaceFactory, FusionSeedGit } from '../../application/ports/fusionWorkspace'

export interface LocalFusionWorkspaceMetadata {
  ensureExcludes(input: { readonly workspaceRef: string; readonly appHome: string }): Promise<void>
  ensurePlatformDirectory(workspaceRef: string): void
}

function copyContent(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source)) {
    if (entry === '.git' || entry === PLATFORM_WORKSPACE_DIR) continue
    cpSync(join(source, entry), join(destination, entry), { recursive: true })
  }
}

async function seedBaseline(
  reference: string,
  appHome: string,
  git: FusionSeedGit,
  metadata: LocalFusionWorkspaceMetadata,
): Promise<string> {
  const checkedGit = async (stage: string, args: string[]) => {
    const result = await git(reference, args)
    if (result.exitCode !== 0) {
      const reason = result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`
      throw new Error(`failed to ${stage} fusion worktree: ${reason}`)
    }
    return result
  }
  await checkedGit('initialize', ['init', '-b', 'fusion'])
  await metadata.ensureExcludes({ workspaceRef: reference, appHome })
  metadata.ensurePlatformDirectory(reference)
  await checkedGit('stage baseline for', [
    '-c',
    'user.name=agent-workflow',
    '-c',
    'user.email=agent-workflow@local',
    'add',
    '-A',
  ])
  await checkedGit('commit baseline for', [
    '-c',
    'user.name=agent-workflow',
    '-c',
    'user.email=agent-workflow@local',
    'commit',
    '--allow-empty',
    '-m',
    'fusion baseline',
  ])
  const head = await checkedGit('resolve baseline for', ['rev-list', '--max-parents=0', 'HEAD'])
  const baseCommit = head.stdout.trim()
  if (baseCommit === '')
    throw new Error('failed to resolve baseline for fusion worktree: empty SHA')
  return baseCommit
}

export function createLocalFusionWorkspaceFactory(
  metadata: LocalFusionWorkspaceMetadata,
): FusionWorkspaceFactory {
  const capturedMetadata: LocalFusionWorkspaceMetadata = Object.freeze({
    ensureExcludes: metadata.ensureExcludes.bind(metadata),
    ensurePlatformDirectory: metadata.ensurePlatformDirectory.bind(metadata),
  })
  return Object.freeze({
    create({ appHome, seedGit = runGit }) {
      return Object.freeze({
        directory: (fusionId: string, iteration: number) =>
          join(appHome, 'fusions', fusionId, `iter${iteration}`, 'work'),
        versionFiles: (skillId: string, contentVersion: number) =>
          join(appHome, 'skills', skillId, 'versions', `v${contentVersion}`, 'files'),
        async ensure(reference: string) {
          mkdirSync(reference, { recursive: true })
        },
        async exists(reference: string) {
          return existsSync(reference)
        },
        async copyContent(source: string, destination: string) {
          copyContent(source, destination)
        },
        seedBaseline: (reference: string) =>
          seedBaseline(reference, appHome, seedGit, capturedMetadata),
        async captureResult(reference: string) {
          const rootSha = (
            await runGit(reference, ['rev-list', '--max-parents=0', 'HEAD'])
          ).stdout.trim()
          const diff = await gitDiffSnapshot(reference, rootSha)
          capturedMetadata.ensurePlatformDirectory(reference)
          const manifestPath = join(reference, PLATFORM_FUSION_MANIFEST)
          if (!existsSync(manifestPath)) return { diff, manifest: { kind: 'missing' as const } }
          const manifestStat = lstatSync(manifestPath)
          if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
            return { diff, manifest: { kind: 'not-plain-file' as const } }
          return {
            diff,
            manifest: { kind: 'found' as const, text: readFileSync(manifestPath, 'utf-8') },
          }
        },
        async overlayProposal(source: string, destination: string) {
          for (const entry of readdirSync(destination)) {
            if (entry === '.git') continue
            rmSync(join(destination, entry), { recursive: true, force: true })
          }
          copyContent(source, destination)
        },
        async remove(reference: string) {
          rmSync(reference, { recursive: true, force: true })
        },
      })
    },
  } satisfies FusionWorkspaceFactory)
}
