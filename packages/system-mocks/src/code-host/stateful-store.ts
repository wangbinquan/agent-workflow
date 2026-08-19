import { createHmac, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

import { runChecked, runProcess } from '../core/process'
import { gitRemoteUrl } from '../git/http'
import type {
  MockCodeHostComment,
  MockCodeHostIssue,
  MockCodeHostIssueSeed,
  MockCodeHostMergeRequest,
  MockCodeHostMergeRequestState,
  MockCodeHostMutationInput,
  MockCodeHostPipeline,
  MockCodeHostPipelineSeed,
  MockCodeHostProject,
  MockCodeHostSeed,
  MockCodeHostUser,
  MockWebhookDeliveryInput,
} from '../types'
import { buildWebhook, gitlabEventHeader } from './webhook'

export const SYSTEM_MOCK_CODE_HOST_TOKEN = 'system-mock-token'

export const SYSTEM_USER: Required<MockCodeHostUser> = {
  id: 7,
  username: 'system-mock-user',
  name: 'System Mock User',
}
export const DEFAULT_AUTHOR: Required<MockCodeHostUser> = {
  id: 8,
  username: 'system-mock-author',
  name: 'System Mock Author',
}

export interface StoredComment extends MockCodeHostComment {
  author: Required<MockCodeHostUser>
}

export interface StoredMergeRequest {
  id: number
  number: number
  title: string
  description: string
  state: MockCodeHostMergeRequestState
  sourceProjectPath: string
  sourceBranch: string
  targetBranch: string
  baseSha: string
  headSha: string
  author: Required<MockCodeHostUser>
  drafts: StoredComment[]
  reviewComments: StoredComment[]
  issueComments: StoredComment[]
}

export interface StoredIssue {
  id: number
  number: number
  title: string
  body: string
  state: 'opened' | 'closed'
  labels: string[]
  author: Required<MockCodeHostUser>
  comments: StoredComment[]
}

export type StoredPipeline = MockCodeHostPipeline

export interface StoredProject {
  provider: 'gitlab' | 'github'
  projectId: string
  projectPath: string
  number: number
  title: string
  defaultBranch: string
  headBranch: string
  baseSha: string
  headSha: string
  repositoryPath: string
  repoHttpUrl: string
  gitTransportUrl: string
  webUrl: string
  diffOmissions: Record<string, 'binary' | 'too-large'>
  mergeRequests: Map<number, StoredMergeRequest>
  issues: Map<number, StoredIssue>
  pipelines: Map<number, StoredPipeline>
  nextObjectId: number
}

export interface WebhookMutation {
  comment?: StoredComment
  issue?: StoredIssue
  pipeline?: StoredPipeline
  previousLabels?: string[]
}

export class CodeHostStore {
  readonly #projects = new Map<string, StoredProject>()
  readonly #suiteRoot: string
  readonly #gitRoot: string
  readonly #baseUrl: () => string
  #nextId = 1000

  constructor(input: { suiteRoot: string; gitRoot: string; baseUrl: () => string }) {
    this.#suiteRoot = input.suiteRoot
    this.#gitRoot = input.gitRoot
    this.#baseUrl = input.baseUrl
  }

  list(): MockCodeHostProject[] {
    return [...this.#projects.values()].map(wireProject)
  }

  get(provider: 'gitlab' | 'github', locator: string): StoredProject | undefined {
    const decoded = decodeURIComponent(locator).replace(/\.git$/, '')
    return [...this.#projects.values()].find(
      (project) =>
        project.provider === provider &&
        (project.projectId === decoded || project.projectPath === decoded),
    )
  }

  /** Resolve a provider-shaped clone request to the isolated bare repository. */
  gitRequest(
    pathname: string,
  ): { readonly repositoryPath: string; readonly clonePath: string } | null {
    for (const project of this.#projects.values()) {
      const clonePath = new URL(project.repoHttpUrl).pathname
      if (pathname === clonePath || pathname.startsWith(`${clonePath}/`)) {
        return { repositoryPath: project.repositoryPath, clonePath }
      }
    }
    return null
  }

  mergeRequest(project: StoredProject, number: number): StoredMergeRequest | undefined {
    return project.mergeRequests.get(number)
  }

  issue(project: StoredProject, number: number): StoredIssue | undefined {
    return project.issues.get(number)
  }

  pipeline(project: StoredProject, id: number): StoredPipeline | undefined {
    return project.pipelines.get(id)
  }

  allocateId(project: StoredProject): string {
    const id = project.nextObjectId
    project.nextObjectId += 1
    return String(id)
  }

  async reset(): Promise<void> {
    this.#projects.clear()
    this.#nextId = 1000
    await rm(join(this.#suiteRoot, 'code-hosts'), { recursive: true, force: true })
  }

  async seed(seed: MockCodeHostSeed): Promise<MockCodeHostProject> {
    if (this.#projects.has(`${seed.provider}:${seed.projectPath}`)) {
      throw new Error(`${seed.provider} project '${seed.projectPath}' is already seeded`)
    }
    const projectId = String(this.#nextId++)
    const number = seed.number ?? 1
    const defaultBranch = seed.defaultBranch ?? 'main'
    const headBranch = seed.headBranch ?? 'system-mock-change'
    const title = seed.title ?? 'System mock change'
    const slug = seed.projectPath.replace(/[^A-Za-z0-9_.-]+/g, '-')
    const root = join(this.#suiteRoot, 'code-hosts', `${seed.provider}-${slug}-${projectId}`)
    const worktree = join(root, 'worktree')
    const repositoryPath = join(root, `${basename(seed.projectPath)}.git`)
    await mkdir(worktree, { recursive: true })
    await runChecked('git', ['init', '-q', '-b', defaultBranch], { cwd: worktree })
    await configureGitUser(worktree, DEFAULT_AUTHOR)
    await applyFiles(worktree, seed.baseFiles ?? { 'README.md': '# system mock\n' })
    await runChecked('git', ['add', '-A'], { cwd: worktree })
    await runChecked('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base'], {
      cwd: worktree,
    })
    const baseSha = await runChecked('git', ['rev-parse', 'HEAD'], { cwd: worktree })
    await runChecked('git', ['switch', '-q', '-c', headBranch], { cwd: worktree })
    await applyFiles(worktree, seed.headFiles ?? { 'README.md': '# system mock\n\nchanged\n' })
    await runChecked('git', ['add', '-A'], { cwd: worktree })
    if ((await runChecked('git', ['status', '--porcelain'], { cwd: worktree })) !== '') {
      await runChecked('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', title], {
        cwd: worktree,
      })
    }
    const headSha = await runChecked('git', ['rev-parse', 'HEAD'], { cwd: worktree })
    await runChecked('git', ['clone', '-q', '--bare', worktree, repositoryPath])
    await runChecked('git', ['update-ref', specialRef(seed.provider, number), headSha], {
      cwd: repositoryPath,
    })
    await runChecked('git', ['update-ref', `refs/heads/${defaultBranch}`, baseSha], {
      cwd: repositoryPath,
    })
    // A bare clone inherits the source worktree's currently checked-out HEAD
    // (the seeded example change branch). Real provider repositories advertise
    // their configured default branch instead; repository import relies on
    // this symref and must therefore see `defaultBranch`.
    await runChecked('git', ['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`], {
      cwd: repositoryPath,
    })

    const hostPrefix = seed.provider === 'gitlab' ? '/gitlab' : '/github'
    const mr: StoredMergeRequest = {
      id: Number(projectId) * 100 + number,
      number,
      title,
      description: '',
      state: 'opened',
      sourceProjectPath: seed.sourceProjectPath ?? seed.projectPath,
      sourceBranch: headBranch,
      targetBranch: defaultBranch,
      baseSha,
      headSha,
      author: normalizeUser(seed.mrAuthor, DEFAULT_AUTHOR),
      drafts: [],
      reviewComments: [],
      issueComments: [],
    }
    const providerRepoHttpUrl = `${this.#baseUrl()}/${seed.projectPath}.git`
    const project: StoredProject = {
      provider: seed.provider,
      projectId,
      projectPath: seed.projectPath,
      number,
      title,
      defaultBranch,
      headBranch,
      baseSha,
      headSha,
      repositoryPath,
      repoHttpUrl: providerRepoHttpUrl,
      gitTransportUrl: gitRemoteUrl(this.#baseUrl(), this.#gitRoot, repositoryPath),
      webUrl: `${this.#baseUrl()}${hostPrefix}/${seed.projectPath}`,
      diffOmissions: structuredClone(seed.diffOmissions ?? {}),
      mergeRequests: new Map([[number, mr]]),
      issues: new Map(),
      pipelines: new Map(),
      nextObjectId: Number(projectId) * 1000,
    }
    for (const issue of seed.issues ?? []) this.#seedIssue(project, issue)
    this.#projects.set(`${seed.provider}:${seed.projectPath}`, project)
    for (const pipeline of seed.pipelines ?? []) this.setPipeline(project, pipeline)
    return wireProject(project)
  }

  async syncRefsFromGit(): Promise<void> {
    for (const project of this.#projects.values()) {
      for (const mr of project.mergeRequests.values()) {
        const source = this.get(project.provider, mr.sourceProjectPath) ?? project
        const headSha = await readRef(source.repositoryPath, `refs/heads/${mr.sourceBranch}`)
        const baseSha = await readRef(project.repositoryPath, `refs/heads/${mr.targetBranch}`)
        if (headSha !== null) {
          await importCommit(project, source, mr.sourceBranch, headSha)
          mr.headSha = headSha
          await runChecked(
            'git',
            ['update-ref', specialRef(project.provider, mr.number), headSha],
            {
              cwd: project.repositoryPath,
            },
          )
        }
        if (baseSha !== null) mr.baseSha = baseSha
      }
      this.#refreshSummary(project)
    }
  }

  async mutate(input: MockCodeHostMutationInput): Promise<MockCodeHostProject> {
    const project = this.#requiredProject(input.provider, input.projectPath)
    switch (input.kind) {
      case 'advance-head':
        await this.#advanceHead(project, input)
        break
      case 'add-review-comment':
        this.addReviewComment(project, input.number ?? project.number, input)
        break
      case 'add-issue-comment':
        this.addIssueComment(project, input.number, input.body, input.actor)
        break
      case 'label-issue': {
        const issue = this.#requiredIssue(project, input.number)
        if (!issue.labels.includes(input.label)) issue.labels.push(input.label)
        break
      }
      case 'set-mr-state':
        this.#requiredMr(project, input.number ?? project.number).state = input.state
        break
      case 'set-pipeline':
        this.setPipeline(project, input.pipeline)
        break
    }
    this.#refreshSummary(project)
    return wireProject(project)
  }

  async createMergeRequest(
    project: StoredProject,
    input: {
      number?: number
      title: string
      description?: string
      sourceBranch: string
      targetBranch: string
      sourceProjectPath?: string
      author?: MockCodeHostUser
    },
  ): Promise<StoredMergeRequest> {
    await this.syncRefsFromGit()
    const number = input.number ?? nextNumber(project.mergeRequests.keys())
    if (project.mergeRequests.has(number)) throw new Error(`merge request ${number} already exists`)
    const sourceProjectPath = input.sourceProjectPath ?? project.projectPath
    const source = this.get(project.provider, sourceProjectPath) ?? project
    const headSha = await readRef(source.repositoryPath, `refs/heads/${input.sourceBranch}`)
    const baseSha = await readRef(project.repositoryPath, `refs/heads/${input.targetBranch}`)
    if (headSha === null) throw new Error(`source branch '${input.sourceBranch}' does not exist`)
    if (baseSha === null) throw new Error(`target branch '${input.targetBranch}' does not exist`)
    const mr: StoredMergeRequest = {
      id: Number(this.allocateId(project)),
      number,
      title: input.title,
      description: input.description ?? '',
      state: 'opened',
      sourceProjectPath,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      baseSha,
      headSha,
      author: normalizeUser(input.author, DEFAULT_AUTHOR),
      drafts: [],
      reviewComments: [],
      issueComments: [],
    }
    project.mergeRequests.set(number, mr)
    await importCommit(project, source, input.sourceBranch, headSha)
    await runChecked('git', ['update-ref', specialRef(project.provider, number), headSha], {
      cwd: project.repositoryPath,
    })
    return mr
  }

  addDraft(
    project: StoredProject,
    number: number,
    input: { body: string; position?: Record<string, unknown>; actor?: MockCodeHostUser },
  ): StoredComment {
    const mr = this.#requiredMr(project, number)
    const comment = this.#newComment(project, input)
    mr.drafts.push(comment)
    return comment
  }

  discardDraft(project: StoredProject, number: number, draftId: string): boolean {
    const mr = this.#requiredMr(project, number)
    const index = mr.drafts.findIndex((draft) => draft.id === draftId)
    if (index < 0) return false
    mr.drafts.splice(index, 1)
    return true
  }

  publishDrafts(project: StoredProject, number: number): StoredComment[] {
    const mr = this.#requiredMr(project, number)
    const published = mr.drafts.map((draft) =>
      this.addReviewComment(project, number, {
        body: draft.body,
        actor: draft.author,
        ...(draft.position === null ? {} : { position: draft.position }),
      }),
    )
    mr.drafts.length = 0
    return published
  }

  addReviewComment(
    project: StoredProject,
    number: number,
    input: {
      body: string
      actor?: MockCodeHostUser
      threadId?: string
      inReplyToId?: string
      position?: Record<string, unknown>
    },
  ): StoredComment {
    const mr = this.#requiredMr(project, number)
    const comment = this.#newComment(project, input)
    // threadId 是「归入哪个 discussion」的显式指定，优先于 inReplyToId（后者只是
    // 链内指针）：gitlab 的 `POST /discussions/:id/notes` 两者都带，此前 inReplyToId
    // （裸 comment id）优先会把回复挂成一个新 discussion（RFC-310 PR-7 实测）。
    const rootId = input.threadId ?? input.inReplyToId
    comment.threadId =
      rootId ?? (project.provider === 'gitlab' ? `discussion-${comment.id}` : comment.id)
    mr.reviewComments.push(comment)
    return comment
  }

  addMergeRequestComment(
    project: StoredProject,
    number: number,
    body: string,
    actor?: MockCodeHostUser,
  ): StoredComment {
    const mr = this.#requiredMr(project, number)
    const comment = this.#newComment(project, { body, actor })
    comment.threadId = project.provider === 'gitlab' ? `discussion-${comment.id}` : null
    mr.issueComments.push(comment)
    return comment
  }

  addIssueComment(
    project: StoredProject,
    number: number,
    body: string,
    actor?: MockCodeHostUser,
  ): StoredComment {
    const issue = this.#requiredIssue(project, number)
    const comment = this.#newComment(project, { body, actor })
    issue.comments.push(comment)
    return comment
  }

  resolveDiscussion(project: StoredProject, number: number, threadId: string): boolean {
    const mr = this.#requiredMr(project, number)
    const comments = mr.reviewComments.filter((comment) => comment.threadId === threadId)
    if (comments.length === 0) return false
    for (const comment of comments) comment.resolved = true
    return true
  }

  updateComment(project: StoredProject, commentId: string, body: string): StoredComment | null {
    for (const mr of project.mergeRequests.values()) {
      const found = [...mr.reviewComments, ...mr.issueComments].find(
        (comment) => comment.id === commentId,
      )
      if (found !== undefined) {
        found.body = body
        return found
      }
    }
    for (const issue of project.issues.values()) {
      const found = issue.comments.find((comment) => comment.id === commentId)
      if (found !== undefined) {
        found.body = body
        return found
      }
    }
    return null
  }

  setPipeline(project: StoredProject, seed: MockCodeHostPipelineSeed): StoredPipeline {
    const mrNumber = seed.mrNumber ?? project.number
    const mr = this.#requiredMr(project, mrNumber)
    const id = seed.id ?? nextNumber(project.pipelines.keys(), 501)
    const previous = project.pipelines.get(id)
    const state = seed.state ?? previous?.state ?? 'failed'
    const jobs = (
      seed.jobs ??
      previous?.jobs ?? [{ name: 'system-mock-job', state: 'failed', log: 'system mock job log\n' }]
    ).map((job, index) => ({
      id: job.id ?? previous?.jobs[index]?.id ?? Number(this.allocateId(project)),
      name: job.name,
      state: job.state ?? state,
      log: job.log ?? 'system mock job log\n',
    }))
    const pipeline: StoredPipeline = {
      id,
      mrNumber,
      state,
      runId: seed.runId ?? previous?.runId ?? String(id),
      headSha: seed.headSha ?? previous?.headSha ?? mr.headSha,
      jobs,
    }
    project.pipelines.set(id, pipeline)
    return pipeline
  }

  async readFile(project: StoredProject, ref: string, path: string): Promise<Buffer | null> {
    const result = await runProcess('git', ['show', `${ref}:${path}`], {
      cwd: project.repositoryPath,
    })
    return result.exitCode === 0 ? result.stdout : null
  }

  async deliverWebhook(input: MockWebhookDeliveryInput): Promise<{
    status: number
    body: string
    deliveryId: string
  }> {
    await this.syncRefsFromGit()
    const project = this.#requiredProject(input.provider, input.projectPath)
    const mutation = this.#applyWebhookMutation(project, input)
    const deliveryId = input.deliveryId ?? randomUUID()
    const built = buildWebhook(project, input, mutation)
    const body = JSON.stringify(built.payload)
    const headers: Record<string, string> = { 'content-type': 'application/json', ...built.headers }
    if (input.provider === 'gitlab') {
      headers['x-gitlab-token'] = input.secret
      headers['x-gitlab-event-uuid'] = deliveryId
      headers['x-gitlab-event'] = gitlabEventHeader(input.event)
    } else {
      headers['x-github-delivery'] = deliveryId
      headers['x-hub-signature-256'] =
        `sha256=${createHmac('sha256', input.secret).update(body).digest('hex')}`
    }
    const response = await fetch(input.callbackUrl, { method: 'POST', headers, body })
    return { status: response.status, body: await response.text(), deliveryId }
  }

  #applyWebhookMutation(project: StoredProject, input: MockWebhookDeliveryInput): WebhookMutation {
    const number = input.number ?? project.number
    const actor = normalizeUser(input.actor, SYSTEM_USER)
    switch (input.event) {
      case 'mr_closed':
      case 'mr_merged':
        this.#requiredMr(project, number).state = input.event === 'mr_merged' ? 'merged' : 'closed'
        return {}
      case 'comment_created':
        return {
          comment: this.addMergeRequestComment(
            project,
            number,
            input.body ?? 'system mock comment',
            actor,
          ),
        }
      case 'review_comment_created':
        return {
          comment: this.addReviewComment(project, number, {
            body: input.body ?? 'system mock review comment',
            actor,
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            ...(input.inReplyToId === undefined ? {} : { inReplyToId: input.inReplyToId }),
            ...(input.position === undefined ? {} : { position: input.position }),
          }),
        }
      case 'issue_labeled': {
        const issue = this.#requiredIssue(project, number)
        const previousLabels = [...issue.labels]
        issue.labels = [
          ...new Set(input.labels ?? [...issue.labels, input.label ?? 'agent-workflow']),
        ]
        return { issue, previousLabels }
      }
      case 'issue_comment':
        return {
          issue: this.#requiredIssue(project, number),
          comment: this.addIssueComment(
            project,
            number,
            input.body ?? 'system mock issue comment',
            actor,
          ),
        }
      case 'pipeline_succeeded':
      case 'pipeline_failed':
        return {
          pipeline: this.setPipeline(project, {
            ...(input.pipelineId === undefined ? {} : { id: input.pipelineId }),
            mrNumber: number,
            state: input.event === 'pipeline_succeeded' ? 'succeeded' : 'failed',
            ...(input.runId === undefined ? {} : { runId: input.runId }),
          }),
        }
      default:
        return {}
    }
  }

  #seedIssue(project: StoredProject, seed: MockCodeHostIssueSeed): StoredIssue {
    const number = seed.number ?? nextNumber(project.issues.keys(), 1)
    const issue: StoredIssue = {
      id: Number(this.allocateId(project)),
      number,
      title: seed.title ?? `System mock issue ${String(number)}`,
      body: seed.body ?? 'System mock requirement',
      state: seed.state ?? 'opened',
      labels: [...(seed.labels ?? [])],
      author: normalizeUser(seed.author, DEFAULT_AUTHOR),
      comments: [],
    }
    project.issues.set(number, issue)
    return issue
  }

  #newComment(
    project: StoredProject,
    input: {
      body: string
      actor?: MockCodeHostUser
      position?: Record<string, unknown>
      inReplyToId?: string
    },
  ): StoredComment {
    return {
      id: this.allocateId(project),
      threadId: null,
      body: input.body,
      author: normalizeUser(input.actor, SYSTEM_USER),
      createdAt: new Date().toISOString(),
      resolved: false,
      inReplyToId: input.inReplyToId ?? null,
      position: input.position === undefined ? null : structuredClone(input.position),
    }
  }

  async #advanceHead(
    project: StoredProject,
    input: Extract<MockCodeHostMutationInput, { kind: 'advance-head' }>,
  ): Promise<void> {
    const mr = this.#requiredMr(project, input.number ?? project.number)
    const source = this.get(project.provider, mr.sourceProjectPath) ?? project
    const clone = await mkdtemp(join(this.#suiteRoot, 'advance-head-'))
    try {
      await runChecked('git', ['clone', '-q', source.repositoryPath, clone])
      await configureGitUser(clone, normalizeUser(input.actor, SYSTEM_USER))
      await runChecked('git', ['switch', '-q', mr.sourceBranch], { cwd: clone })
      await applyFiles(clone, input.files)
      await runChecked('git', ['add', '-A'], { cwd: clone })
      if ((await runChecked('git', ['status', '--porcelain'], { cwd: clone })) === '') {
        throw new Error('advance-head mutation produced no Git change')
      }
      await runChecked(
        'git',
        [
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-q',
          '-m',
          input.message ?? 'system mock head update',
        ],
        { cwd: clone },
      )
      await runChecked('git', ['push', '-q', 'origin', `HEAD:refs/heads/${mr.sourceBranch}`], {
        cwd: clone,
      })
    } finally {
      await rm(clone, { recursive: true, force: true })
    }
    await this.syncRefsFromGit()
  }

  #requiredProject(provider: 'gitlab' | 'github', path: string): StoredProject {
    const project = this.get(provider, path)
    if (project === undefined) throw new Error(`unknown ${provider} project ${path}`)
    return project
  }

  #requiredMr(project: StoredProject, number: number): StoredMergeRequest {
    const mr = project.mergeRequests.get(number)
    if (mr === undefined) throw new Error(`unknown merge request ${number}`)
    return mr
  }

  #requiredIssue(project: StoredProject, number: number): StoredIssue {
    const issue = project.issues.get(number)
    if (issue === undefined) throw new Error(`unknown issue ${number}`)
    return issue
  }

  #refreshSummary(project: StoredProject): void {
    const primary =
      project.mergeRequests.get(project.number) ?? project.mergeRequests.values().next().value
    if (primary === undefined) return
    project.number = primary.number
    project.title = primary.title
    project.headBranch = primary.sourceBranch
    project.baseSha = primary.baseSha
    project.headSha = primary.headSha
  }
}

function wireProject(project: StoredProject): MockCodeHostProject {
  return {
    provider: project.provider,
    projectId: project.projectId,
    projectPath: project.projectPath,
    number: project.number,
    title: project.title,
    defaultBranch: project.defaultBranch,
    headBranch: project.headBranch,
    baseSha: project.baseSha,
    headSha: project.headSha,
    repoHttpUrl: project.repoHttpUrl,
    gitTransportUrl: project.gitTransportUrl,
    webUrl: project.webUrl,
    mergeRequests: [...project.mergeRequests.values()].map(wireMergeRequest),
    issues: [...project.issues.values()].map(wireIssue),
    pipelines: [...project.pipelines.values()].map((pipeline) => structuredClone(pipeline)),
  }
}

function wireMergeRequest(mr: StoredMergeRequest): MockCodeHostMergeRequest {
  return structuredClone(mr)
}

function wireIssue(issue: StoredIssue): MockCodeHostIssue {
  return structuredClone(issue)
}

export function normalizeUser(
  user: MockCodeHostUser | undefined,
  fallback: Required<MockCodeHostUser>,
): Required<MockCodeHostUser> {
  return {
    id: user?.id ?? fallback.id,
    username: user?.username ?? fallback.username,
    name: user?.name ?? user?.username ?? fallback.name,
  }
}

async function configureGitUser(path: string, user: Required<MockCodeHostUser>): Promise<void> {
  await runChecked('git', ['config', 'user.email', `${user.username}@system-mock.test`], {
    cwd: path,
  })
  await runChecked('git', ['config', 'user.name', user.name], { cwd: path })
}

async function applyFiles(root: string, files: Record<string, string | null>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    if (relative(root, absolute).startsWith('..'))
      throw new Error(`mock file '${path}' escapes root`)
    if (content === null) {
      await rm(absolute, { force: true })
      continue
    }
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, content)
  }
}

async function readRef(repositoryPath: string, ref: string): Promise<string | null> {
  const result = await runProcess('git', ['rev-parse', '--verify', ref], { cwd: repositoryPath })
  return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : null
}

async function importCommit(
  target: StoredProject,
  source: StoredProject,
  sourceBranch: string,
  sha: string,
): Promise<void> {
  if (target.repositoryPath === source.repositoryPath) return
  const present = await runProcess('git', ['cat-file', '-e', `${sha}^{commit}`], {
    cwd: target.repositoryPath,
  })
  if (present.exitCode === 0) return
  await runChecked('git', ['fetch', '-q', source.repositoryPath, `refs/heads/${sourceBranch}`], {
    cwd: target.repositoryPath,
  })
}

function specialRef(provider: 'gitlab' | 'github', number: number): string {
  return provider === 'gitlab' ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`
}

function nextNumber(values: Iterable<number>, minimum = 1): number {
  let next = minimum
  for (const value of values) next = Math.max(next, value + 1)
  return next
}
