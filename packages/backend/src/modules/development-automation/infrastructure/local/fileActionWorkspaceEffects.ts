import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import { runGit } from '@/util/git'
import type { ActionWorkspaceEffects } from '../../application/ports/actionWorkspaceEffects'
import { createFileAutomationWorkspaceEffectsFactory } from './fileAutomationWorkspaceEffects'

/** 业务树 digest：排除 .git 与 .agent-workflow 的稳定内容 hash。 */
export function businessTreeDigestOf(root: string): string {
  const hash = createHash('sha256')
  const files: string[] = []
  const walk = (rel: string): void => {
    const abs = rel === '' ? root : join(root, rel)
    const st = lstatSync(abs)
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        const childRel = rel === '' ? name : `${rel}/${name}`
        if (childRel === '.git' || childRel === PLATFORM_WORKSPACE_DIR) continue
        walk(childRel)
      }
      return
    }
    if (st.isFile()) files.push(rel)
  }
  walk('')
  for (const rel of files.sort()) {
    hash.update(`${rel}\n`)
    hash.update(
      createHash('sha256')
        .update(readFileSync(join(root, rel)))
        .digest('hex'),
    )
    hash.update('\n')
  }
  return hash.digest('hex')
}

/** 整树回退：废弃 workspace（含其父临时目录）。 */
export function discardWorkspace(workspacePath: string): void {
  rmSync(dirname(workspacePath), { recursive: true, force: true })
}

export function createFileActionWorkspaceEffects(): ActionWorkspaceEffects {
  return Object.freeze({
    contents: createFileAutomationWorkspaceEffectsFactory(),
    allocate(storageRootReference?: string) {
      let parent: string
      if (storageRootReference === undefined) {
        parent = mkdtempSync(join(tmpdir(), 'aw-action-ws-'))
      } else {
        mkdirSync(storageRootReference, { recursive: true })
        parent = mkdtempSync(join(storageRootReference, 'action-'))
      }
      return join(parent, 'ws')
    },
    cloneBaseline(workspaceReference, baselineReference) {
      return runGit(dirname(workspaceReference), [
        'clone',
        '--no-hardlinks',
        '--quiet',
        baselineReference,
        workspaceReference,
      ])
    },
    run(workspaceReference, args, options) {
      return runGit(workspaceReference, args as string[], options)
    },
    installPlatformExclude(workspaceReference) {
      mkdirSync(join(workspaceReference, '.git', 'info'), { recursive: true })
      writeFileSync(
        join(workspaceReference, '.git', 'info', 'exclude'),
        `${PLATFORM_WORKSPACE_DIR}/\n`,
      )
    },
    requireEntry(reference) {
      const facts = lstatSync(reference)
      return {
        kind: facts.isSymbolicLink()
          ? 'symlink'
          : facts.isDirectory()
            ? 'directory'
            : facts.isFile()
              ? 'file'
              : 'other',
        mode: facts.mode,
        size: facts.size,
        nlink: facts.nlink,
      }
    },
    discard: discardWorkspace,
  } satisfies ActionWorkspaceEffects)
}
