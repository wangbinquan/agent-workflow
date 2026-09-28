import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { realpathWriteInside, safeJoin } from '@/util/safePath'
import type {
  SkillVersionContentChange,
  SkillVersionContentStore,
  SkillVersionPublication,
} from '../../application/skills/versionContentStore'
import { assertRegularFileTree, hashRegularFileTree } from '../legacy/skillHash'
import { cleanupOpDirs, opStagedDir, swapInStaged } from '../legacy/skillFsPublish'
import {
  realDirectoryChainState,
  skillFilesAbs,
  skillRootAbs,
  skillVersionAbs,
} from '../legacy/skillIdentityPaths'

/** Original local pre-commit cleanup, also used by old serialized journal callers. */
export function abortFileSkillVersionPublication(publication: SkillVersionPublication): void {
  cleanupOpDirs(publication.liveRef, publication.publicationId)
  rmSync(publication.versionRef, { recursive: true, force: true })
}

/**
 * Filesystem effects from the existing four-phase version funnel. The optional
 * producer is only the old local API's compatibility seam; neutral callers use
 * the declarative change contract and never receive a physical directory.
 */
export function createFileSkillVersionContentStore(
  appHome: string,
  legacyProducer?: (stagingDirectory: string) => void,
): SkillVersionContentStore {
  return Object.freeze({
    plan(input) {
      const liveRef = skillFilesAbs(appHome, input.skillId)
      const stagingRef = opStagedDir(liveRef, input.publicationId)
      const versionRef = skillVersionAbs(appHome, input.skillId, input.version)
      return {
        ...input,
        liveRef,
        stagingRef,
        versionRef,
        stagingJournalRef: relative(appHome, stagingRef),
        versionJournalRef: relative(appHome, versionRef),
      }
    },
    stage(publication, change, compareLive) {
      const { stagingRef, liveRef } = publication
      rmSync(stagingRef, { recursive: true, force: true })
      mkdirSync(stagingRef, { recursive: true })
      if (existsSync(liveRef)) cpSync(liveRef, stagingRef, { recursive: true })
      if (legacyProducer) legacyProducer(stagingRef)
      else applyChange(appHome, publication, change)
      const contentHash = hashRegularFileTree(stagingRef)
      return {
        contentHash,
        matchesLive: compareLive && contentHash === hashRegularFileTree(liveRef),
      }
    },
    discardStage(publication) {
      rmSync(publication.stagingRef, { recursive: true, force: true })
    },
    captureVersion(publication) {
      rmSync(publication.versionRef, { recursive: true, force: true })
      mkdirSync(dirname(publication.versionRef), { recursive: true })
      cpSync(publication.stagingRef, publication.versionRef, { recursive: true })
      assertRegularFileTree(publication.versionRef)
    },
    publish(publication, contentHash) {
      const { liveRef, publicationId, skillId, version } = publication
      mkdirSync(dirname(liveRef), { recursive: true })
      swapInStaged(liveRef, publicationId)
      const root = skillRootAbs(appHome, skillId)
      if (realDirectoryChainState(root, liveRef) !== 'real-directory') {
        throw new Error(`skill version ${version} live publish is not a real directory`)
      }
      if (hashRegularFileTree(liveRef) !== contentHash) {
        throw new Error(
          `skill version ${version} live publish does not match committed content hash`,
        )
      }
      cleanupOpDirs(liveRef, publicationId)
    },
    abort: abortFileSkillVersionPublication,
  } satisfies SkillVersionContentStore)
}

function applyChange(
  appHome: string,
  publication: SkillVersionPublication,
  change: SkillVersionContentChange,
): void {
  const staging = publication.stagingRef
  switch (change.kind) {
    case 'retain':
      return
    case 'write-main': {
      const target = realpathWriteInside(staging, join(staging, 'SKILL.md'))
      writeFileSync(target, change.content, 'utf-8')
      return
    }
    case 'write-file': {
      const abs = safeJoin(staging, change.path)
      const target = realpathWriteInside(staging, abs)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, change.content, 'utf-8')
      return
    }
    case 'delete-file': {
      const abs = safeJoin(staging, change.path)
      if (!existsSync(abs)) return
      const target = realpathWriteInside(staging, abs)
      if (lstatSync(target).isSymbolicLink()) {
        unlinkSync(target)
        return
      }
      if (statSync(target).isDirectory()) rmSync(target, { recursive: true })
      else unlinkSync(target)
      return
    }
    case 'restore-version': {
      const targetDir = skillVersionAbs(appHome, publication.skillId, change.version)
      for (const entry of readdirSync(staging))
        rmSync(join(staging, entry), { recursive: true, force: true })
      if (existsSync(targetDir)) cpSync(targetDir, staging, { recursive: true })
      return
    }
    case 'replace-files': {
      for (const entry of readdirSync(staging))
        rmSync(join(staging, entry), { recursive: true, force: true })
      const safeRoot = resolve(staging) + sep
      mkdirSync(staging, { recursive: true })
      for (const file of change.files) {
        if (file.path === 'SKILL.md') continue
        const dst = resolve(join(staging, file.path))
        if (!(dst + (file.path.endsWith('/') ? sep : '')).startsWith(safeRoot)) {
          throw new Error(`unsafe path resolved outside skill dir: ${file.path}`)
        }
        mkdirSync(dirname(dst), { recursive: true })
        writeFileSync(dst, file.content)
      }
      writeFileSync(join(staging, 'SKILL.md'), change.mainContent, 'utf-8')
      if (!existsSync(join(staging, 'SKILL.md'))) throw new Error('SKILL.md was not written')
      return
    }
  }
}
