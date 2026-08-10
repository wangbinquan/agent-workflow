// Claude managed-skill attachments for the natural runtime path.
//
// Selected managed skills are copied as ordinary run artifacts (using the same
// whole-tree copier and .claude-plugin exclusion as OpenCode), then described in
// the appended system prompt. They are also projected into the worktree's
// project config path so Claude-compatible forks can discover them natively
// without relocating the user config/auth root.

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Logger } from '@/util/log'
import { assertWriteAncestorInside, safeJoin } from '@/util/safePath'
import { stringify as stringifyYaml } from 'yaml'
import { stageSkills, type StagedSkill } from '../stageSkills'
import type { ClaudeAgentEntry } from './inject'

export type ClaudeSkillInjection = StagedSkill

interface DirectoryIdentity {
  dev: number
  ino: number
}

interface ProjectedSkillDirectory {
  path: string
  identity: DirectoryIdentity
}

interface ProjectedAgentFile {
  path: string
  identity: DirectoryIdentity
}

export interface ClaudeWorktreeSkillProjection {
  /** Project-local config root (`<worktree>/<configDirName>`). */
  configPath: string
  skillNames: readonly string[]
  /** Idempotently removes only the directories this projection created. */
  cleanup: () => void
}

export interface ClaudeWorktreeAgentProjection {
  /** Project-local config root (`<worktree>/<configDirName>`). */
  configPath: string
  agentNames: readonly string[]
  /** Idempotently removes only the files this projection created. */
  cleanup: () => void
}

function assertSafeLeaf(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`invalid ${label}: ${value}`)
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path) ?? null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function directoryIdentity(path: string, label: string): DirectoryIdentity {
  const metadata = lstatSync(path)
  if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`)
  }
  return { dev: metadata.dev, ino: metadata.ino }
}

function sameDirectory(path: string, identity: DirectoryIdentity): boolean {
  const metadata = lstatOrNull(path)
  return (
    metadata !== null &&
    metadata.isDirectory() &&
    !metadata.isSymbolicLink() &&
    metadata.dev === identity.dev &&
    metadata.ino === identity.ino
  )
}

function fileIdentity(path: string, label: string): DirectoryIdentity {
  const metadata = lstatSync(path)
  if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real file: ${path}`)
  }
  return { dev: metadata.dev, ino: metadata.ino }
}

function sameFile(path: string, identity: DirectoryIdentity): boolean {
  const metadata = lstatOrNull(path)
  return (
    metadata !== null &&
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.dev === identity.dev &&
    metadata.ino === identity.ino
  )
}

function attachmentConfigRoot(runRoot: string): string {
  return join(runRoot, 'claude-managed-skill-attachments')
}

function listAttachmentFiles(root: string, log: Logger, skillName: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      const metadata = lstatSync(absolute)
      if (metadata.isSymbolicLink()) {
        log.warn('claude managed skill attachment skipped symlink', {
          skill: skillName,
          path: relative(root, absolute),
        })
        continue
      }
      if (metadata.isDirectory()) visit(absolute)
      else if (metadata.isFile()) files.push(relative(root, absolute).split(sep).join('/'))
    }
  }
  visit(root)
  return files.sort()
}

export function renderClaudeManagedSkillAttachments(
  runRoot: string,
  skills: readonly ClaudeSkillInjection[],
  log: Logger,
): string {
  const managed = skills.filter((skill) => skill.sourceKind === 'managed')
  if (managed.length === 0) return ''

  for (const skill of managed) assertSafeLeaf(skill.name, 'managed skill attachment name')

  const attachmentRoot = attachmentConfigRoot(runRoot)
  stageSkills(attachmentRoot, managed, log)
  const sections: string[] = []
  for (const skill of managed) {
    const skillRoot = join(attachmentRoot, 'skills', skill.name)
    const files = listAttachmentFiles(skillRoot, log, skill.name)
    const skillMdPath = join(skillRoot, 'SKILL.md')
    if (!files.includes('SKILL.md')) {
      throw new Error(`managed skill '${skill.name}' is missing SKILL.md`)
    }
    const body = readFileSync(skillMdPath, 'utf8')
    sections.push(
      [
        `### ${skill.name}`,
        `Attachment root: ${skillRoot}`,
        'Files:',
        ...files.map((file) => `- ${file}`),
        '',
        'SKILL.md:',
        body,
      ].join('\n'),
    )
  }

  return [
    '<aw-managed-skills>',
    'The platform selected these managed skill attachments for this run.',
    'Use each attachment root for sibling-file reads; machine and project skills remain available normally.',
    ...sections,
    '</aw-managed-skills>',
  ].join('\n\n')
}

/**
 * Project selected managed skills into Claude's project config directory while
 * leaving the inherited user config directory untouched. This is the native
 * discovery bridge for Claude-compatible forks that do not understand the
 * platform's system-prompt attachment block.
 *
 * The projection never overwrites a project-owned path. A same-name project
 * skill fails assembly explicitly, and cleanup verifies directory identities
 * before deleting so a runtime cannot redirect cleanup through a swapped
 * symlink. Real task nodes run in disposable per-node worktrees; the cleanup is
 * still required so the projection is absent from the node snapshot/merge.
 */
export function stageClaudeWorktreeSkills(
  worktreePath: string,
  configDirName: string,
  runRoot: string,
  skills: readonly ClaudeSkillInjection[],
  log: Logger,
): ClaudeWorktreeSkillProjection {
  assertSafeLeaf(configDirName, 'Claude project config directory name')
  const configPath = safeJoin(worktreePath, configDirName)
  const managed = skills.filter((skill) => skill.sourceKind === 'managed')
  const skillNames = managed.map((skill) => skill.name)
  for (const name of skillNames) assertSafeLeaf(name, 'managed skill projection name')

  if (managed.length === 0) return { configPath, skillNames, cleanup: () => {} }

  const skillsPath = safeJoin(configPath, 'skills')
  const targets = skillNames.map((name) => safeJoin(skillsPath, name))
  assertWriteAncestorInside(worktreePath, join(skillsPath, '.agent-workflow-write-probe'))

  const existingConfig = lstatOrNull(configPath)
  if (
    existingConfig !== null &&
    (!existingConfig.isDirectory() || existingConfig.isSymbolicLink())
  ) {
    throw new Error(`Claude project config path must be a real directory: ${configPath}`)
  }
  const existingSkills = lstatOrNull(skillsPath)
  if (
    existingSkills !== null &&
    (!existingSkills.isDirectory() || existingSkills.isSymbolicLink())
  ) {
    throw new Error(`Claude project skills path must be a real directory: ${skillsPath}`)
  }
  for (const target of targets) {
    if (lstatOrNull(target) !== null) {
      throw new Error(`claude-worktree-skill-conflict: refusing to overwrite ${target}`)
    }
  }

  let createdConfigPath = false
  let createdSkillsPath = false
  let configIdentity: DirectoryIdentity | null = null
  let skillsIdentity: DirectoryIdentity | null = null
  const projected: ProjectedSkillDirectory[] = []
  let cleaned = false

  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    if (
      configIdentity === null ||
      skillsIdentity === null ||
      !sameDirectory(configPath, configIdentity) ||
      !sameDirectory(skillsPath, skillsIdentity)
    ) {
      log.warn('claude worktree skill cleanup skipped after parent path changed', { configPath })
      return
    }
    for (const target of projected.reverse()) {
      const current = lstatOrNull(target.path)
      if (current === null) continue
      if (!sameDirectory(target.path, target.identity)) {
        log.warn('claude worktree skill cleanup skipped after target path changed', {
          path: target.path,
        })
        continue
      }
      try {
        rmSync(target.path, { recursive: true, force: true })
      } catch (error) {
        log.warn('claude worktree skill cleanup failed', {
          path: target.path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (createdSkillsPath && sameDirectory(skillsPath, skillsIdentity)) {
      try {
        rmdirSync(skillsPath)
      } catch {
        // Project/runtime content now exists beside the projection; preserve it.
      }
    }
    if (createdConfigPath && sameDirectory(configPath, configIdentity)) {
      try {
        rmdirSync(configPath)
      } catch {
        // Project/runtime content now exists beside the projection; preserve it.
      }
    }
  }

  try {
    if (existingConfig === null) {
      mkdirSync(configPath)
      createdConfigPath = true
    }
    configIdentity = directoryIdentity(configPath, 'Claude project config path')
    if (existingSkills === null) {
      mkdirSync(skillsPath)
      createdSkillsPath = true
    }
    skillsIdentity = directoryIdentity(skillsPath, 'Claude project skills path')

    for (const target of targets) {
      mkdirSync(target)
      projected.push({ path: target, identity: directoryIdentity(target, 'projected skill path') })
    }

    const sanitizedAttachmentRoot = join(attachmentConfigRoot(runRoot), 'skills')
    stageSkills(
      configPath,
      managed.map((skill) => ({
        ...skill,
        sourcePath: join(sanitizedAttachmentRoot, skill.name),
      })),
      log,
    )
    return { configPath, skillNames, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

function renderClaudeProjectAgent(name: string, entry: ClaudeAgentEntry): string {
  const frontmatter: Record<string, unknown> = {
    name,
    description: entry.description,
  }
  if (entry.tools !== undefined) frontmatter.tools = entry.tools
  if (entry.model !== undefined) frontmatter.model = entry.model
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 })
  const prompt = entry.prompt.endsWith('\n') ? entry.prompt : `${entry.prompt}\n`
  return `---\n${yaml}---\n\n${prompt}`
}

/**
 * Mirror each selected dependent into its own project subagent file. The single
 * `--agents` argument remains the authoritative standard-Claude transport; this
 * projection is a native-discovery bridge for compatible forks that scan the
 * worktree config path instead. One registry entry always becomes one file and
 * one prompt body — prompts are never concatenated.
 *
 * Existing project files are never overwritten. Cleanup uses parent and file
 * identities so a runtime cannot redirect deletion by swapping in a symlink.
 */
export function stageClaudeWorktreeAgents(
  worktreePath: string,
  configDirName: string,
  agents: Readonly<Record<string, ClaudeAgentEntry>>,
  log: Logger,
): ClaudeWorktreeAgentProjection {
  assertSafeLeaf(configDirName, 'Claude project config directory name')
  const configPath = safeJoin(worktreePath, configDirName)
  const entries = Object.entries(agents)
  const agentNames = entries.map(([name]) => name)
  for (const name of agentNames) assertSafeLeaf(name, 'Claude project agent name')
  if (entries.length === 0) return { configPath, agentNames, cleanup: () => {} }

  const agentsPath = safeJoin(configPath, 'agents')
  const targets = entries.map(([name, entry]) => ({
    entry,
    name,
    path: safeJoin(agentsPath, `${name}.md`),
  }))
  assertWriteAncestorInside(worktreePath, join(agentsPath, '.agent-workflow-write-probe'))

  const existingConfig = lstatOrNull(configPath)
  if (
    existingConfig !== null &&
    (!existingConfig.isDirectory() || existingConfig.isSymbolicLink())
  ) {
    throw new Error(`Claude project config path must be a real directory: ${configPath}`)
  }
  const existingAgents = lstatOrNull(agentsPath)
  if (
    existingAgents !== null &&
    (!existingAgents.isDirectory() || existingAgents.isSymbolicLink())
  ) {
    throw new Error(`Claude project agents path must be a real directory: ${agentsPath}`)
  }
  for (const target of targets) {
    if (lstatOrNull(target.path) !== null) {
      throw new Error(`claude-worktree-agent-conflict: refusing to overwrite ${target.path}`)
    }
  }

  let createdConfigPath = false
  let createdAgentsPath = false
  let configIdentity: DirectoryIdentity | null = null
  let agentsIdentity: DirectoryIdentity | null = null
  const projected: ProjectedAgentFile[] = []
  let cleaned = false

  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    if (
      configIdentity === null ||
      agentsIdentity === null ||
      !sameDirectory(configPath, configIdentity) ||
      !sameDirectory(agentsPath, agentsIdentity)
    ) {
      log.warn('claude worktree agent cleanup skipped after parent path changed', { configPath })
      return
    }
    for (const target of projected.reverse()) {
      const current = lstatOrNull(target.path)
      if (current === null) continue
      if (!sameFile(target.path, target.identity)) {
        log.warn('claude worktree agent cleanup skipped after target path changed', {
          path: target.path,
        })
        continue
      }
      try {
        rmSync(target.path, { force: true })
      } catch (error) {
        log.warn('claude worktree agent cleanup failed', {
          path: target.path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (createdAgentsPath && sameDirectory(agentsPath, agentsIdentity)) {
      try {
        rmdirSync(agentsPath)
      } catch {
        // Project/runtime content now exists beside the projection; preserve it.
      }
    }
    if (createdConfigPath && sameDirectory(configPath, configIdentity)) {
      try {
        rmdirSync(configPath)
      } catch {
        // Project/runtime content now exists beside the projection; preserve it.
      }
    }
  }

  try {
    if (existingConfig === null) {
      mkdirSync(configPath)
      createdConfigPath = true
    }
    configIdentity = directoryIdentity(configPath, 'Claude project config path')
    if (existingAgents === null) {
      mkdirSync(agentsPath)
      createdAgentsPath = true
    }
    agentsIdentity = directoryIdentity(agentsPath, 'Claude project agents path')

    for (const target of targets) {
      writeFileSync(target.path, renderClaudeProjectAgent(target.name, target.entry), {
        encoding: 'utf8',
        flag: 'wx',
      })
      projected.push({
        path: target.path,
        identity: fileIdentity(target.path, 'projected agent path'),
      })
    }
    return { configPath, agentNames, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
