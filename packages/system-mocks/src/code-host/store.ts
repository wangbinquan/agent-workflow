import { createHmac, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

import { gitRemoteUrl } from '../git/http'
import { runChecked } from '../core/process'
import type { MockCodeHostProject, MockCodeHostSeed, MockWebhookDeliveryInput } from '../types'

export const SYSTEM_MOCK_CODE_HOST_TOKEN = 'system-mock-token'

interface StoredProject extends MockCodeHostProject {
  repositoryPath: string
  baseFiles: Record<string, string>
  headFiles: Record<string, string>
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
    return [...this.#projects.values()].map(stripStoredProject)
  }

  get(provider: 'gitlab' | 'github', locator: string): StoredProject | undefined {
    const decoded = decodeURIComponent(locator).replace(/\.git$/, '')
    return [...this.#projects.values()].find(
      (project) =>
        project.provider === provider &&
        (project.projectId === decoded || project.projectPath === decoded),
    )
  }

  async reset(): Promise<void> {
    this.#projects.clear()
    this.#nextId = 1000
    await rm(join(this.#suiteRoot, 'code-hosts'), { recursive: true, force: true })
  }

  async seed(seed: MockCodeHostSeed): Promise<MockCodeHostProject> {
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
    await runChecked('git', ['config', 'user.email', 'system-mock@example.test'], { cwd: worktree })
    await runChecked('git', ['config', 'user.name', 'System Mock'], { cwd: worktree })
    const baseFiles = seed.baseFiles ?? { 'README.md': '# system mock\n' }
    await writeFiles(worktree, baseFiles)
    await runChecked('git', ['add', '.'], { cwd: worktree })
    await runChecked('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base'], {
      cwd: worktree,
    })
    const baseSha = await runChecked('git', ['rev-parse', 'HEAD'], { cwd: worktree })
    await runChecked('git', ['switch', '-q', '-c', headBranch], { cwd: worktree })
    const headFiles = seed.headFiles ?? { 'README.md': '# system mock\n\nchanged\n' }
    await writeFiles(worktree, headFiles)
    await runChecked('git', ['add', '.'], { cwd: worktree })
    await runChecked('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', title], {
      cwd: worktree,
    })
    const headSha = await runChecked('git', ['rev-parse', 'HEAD'], { cwd: worktree })
    await runChecked('git', ['clone', '-q', '--bare', worktree, repositoryPath])
    const specialRef =
      seed.provider === 'gitlab' ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`
    await runChecked('git', ['update-ref', specialRef, headSha], { cwd: repositoryPath })
    await runChecked('git', ['update-ref', `refs/heads/${defaultBranch}`, baseSha], {
      cwd: repositoryPath,
    })

    const hostPrefix = seed.provider === 'gitlab' ? '/gitlab' : '/github'
    const effectiveHeadFiles = structuredClone(baseFiles)
    for (const [path, content] of Object.entries(headFiles)) {
      if (content === null) delete effectiveHeadFiles[path]
      else effectiveHeadFiles[path] = content
    }
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
      repoHttpUrl: gitRemoteUrl(this.#baseUrl(), this.#gitRoot, repositoryPath),
      gitTransportUrl: gitRemoteUrl(this.#baseUrl(), this.#gitRoot, repositoryPath),
      webUrl: `${this.#baseUrl()}${hostPrefix}/${seed.projectPath}`,
      baseFiles: structuredClone(baseFiles),
      headFiles: effectiveHeadFiles,
      mergeRequests: [],
      issues: [],
      pipelines: [],
    }
    this.#projects.set(`${seed.provider}:${seed.projectPath}`, project)
    return stripStoredProject(project)
  }

  async deliverWebhook(input: MockWebhookDeliveryInput): Promise<{
    status: number
    body: string
    deliveryId: string
  }> {
    const project = this.get(input.provider, input.projectPath)
    if (project === undefined)
      throw new Error(`unknown ${input.provider} project ${input.projectPath}`)
    const deliveryId = input.deliveryId ?? randomUUID()
    const built = buildWebhook(project, input)
    const body = JSON.stringify(built.payload)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...built.headers,
    }
    if (input.provider === 'gitlab') {
      headers['x-gitlab-token'] = input.secret
      headers['x-gitlab-event-uuid'] = deliveryId
      headers['x-gitlab-event'] =
        input.event === 'comment_created'
          ? 'Note Hook'
          : input.event.startsWith('pipeline_')
            ? 'Pipeline Hook'
            : 'Merge Request Hook'
    } else {
      headers['x-github-delivery'] = deliveryId
      headers['x-hub-signature-256'] =
        `sha256=${createHmac('sha256', input.secret).update(body).digest('hex')}`
    }
    const response = await fetch(input.callbackUrl, { method: 'POST', headers, body })
    return { status: response.status, body: await response.text(), deliveryId }
  }
}

function stripStoredProject(project: StoredProject): MockCodeHostProject {
  const {
    repositoryPath: _repositoryPath,
    baseFiles: _baseFiles,
    headFiles: _headFiles,
    ...wire
  } = project
  return structuredClone(wire)
}

async function writeFiles(root: string, files: Record<string, string | null>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    if (!relative(root, absolute).startsWith('..')) {
      if (content === null) {
        await rm(absolute, { force: true })
        continue
      }
      await mkdir(join(absolute, '..'), { recursive: true })
      await writeFile(absolute, content)
    }
  }
}

function buildWebhook(
  project: StoredProject,
  input: MockWebhookDeliveryInput,
): { payload: Record<string, unknown>; headers: Record<string, string> } {
  const action =
    input.event === 'mr_opened'
      ? 'opened'
      : input.event === 'mr_updated'
        ? 'synchronize'
        : input.event === 'mr_merged' || input.event === 'mr_closed'
          ? 'closed'
          : 'created'
  if (project.provider === 'github') {
    const repository = {
      id: Number(project.projectId),
      name: project.projectPath.split('/').at(-1),
      full_name: project.projectPath,
      clone_url: project.repoHttpUrl,
      ssh_url: `git@system-mock:${project.projectPath}.git`,
      html_url: project.webUrl,
      default_branch: project.defaultBranch,
      owner: { login: project.projectPath.split('/')[0] },
    }
    const pullRequest = {
      id: Number(project.projectId) * 100 + project.number,
      number: project.number,
      title: project.title,
      html_url: `${project.webUrl}/pull/${project.number}`,
      merged: input.event === 'mr_merged',
      head: { ref: project.headBranch, sha: project.headSha },
      base: { ref: project.defaultBranch, sha: project.baseSha },
    }
    if (input.event === 'comment_created') {
      return {
        headers: { 'x-github-event': 'issue_comment' },
        payload: {
          action: 'created',
          repository,
          sender: { id: 7, login: 'system-mock-user' },
          issue: {
            id: 80,
            number: project.number,
            title: project.title,
            html_url: `${project.webUrl}/pull/${project.number}`,
            pull_request: {
              url: `${thisApiBase(project)}/repos/${project.projectPath}/pulls/${project.number}`,
            },
          },
          comment: {
            id: 90,
            body: input.body ?? 'system mock comment',
            html_url: `${project.webUrl}/pull/${project.number}#issuecomment-90`,
          },
        },
      }
    }
    if (input.event === 'pipeline_succeeded' || input.event === 'pipeline_failed') {
      return {
        headers: { 'x-github-event': 'workflow_run' },
        payload: {
          action: 'completed',
          repository,
          sender: { id: 7, login: 'system-mock-user' },
          workflow_run: {
            id: 501,
            conclusion: input.event === 'pipeline_succeeded' ? 'success' : 'failure',
            head_branch: project.headBranch,
            head_sha: project.headSha,
            html_url: `${project.webUrl}/actions/runs/501`,
            actor: { login: 'system-mock-user' },
            pull_requests: [{ id: pullRequest.id, number: project.number, base: pullRequest.base }],
          },
        },
      }
    }
    return {
      headers: { 'x-github-event': 'pull_request' },
      payload: {
        action,
        repository,
        sender: { id: 7, login: 'system-mock-user' },
        pull_request: pullRequest,
      },
    }
  }

  const projectBlock = {
    id: Number(project.projectId),
    path_with_namespace: project.projectPath,
    git_http_url: project.repoHttpUrl,
    git_ssh_url: `git@system-mock:${project.projectPath}.git`,
    web_url: project.webUrl,
    default_branch: project.defaultBranch,
  }
  const mergeRequest = {
    id: Number(project.projectId) * 100 + project.number,
    iid: project.number,
    title: project.title,
    url: `${project.webUrl}/-/merge_requests/${project.number}`,
    source_branch: project.headBranch,
    target_branch: project.defaultBranch,
    last_commit: { id: project.headSha },
  }
  if (input.event === 'comment_created') {
    return {
      headers: {},
      payload: {
        object_kind: 'note',
        user: { id: 7, username: 'system-mock-user', name: 'System Mock User' },
        project: projectBlock,
        merge_request: mergeRequest,
        object_attributes: {
          id: 90,
          noteable_type: 'MergeRequest',
          note: input.body ?? 'system mock comment',
          discussion_id: 'mock-thread-1',
          url: `${mergeRequest.url}#note_90`,
        },
      },
    }
  }
  if (input.event === 'pipeline_succeeded' || input.event === 'pipeline_failed') {
    return {
      headers: {},
      payload: {
        object_kind: 'pipeline',
        user: { id: 7, username: 'system-mock-user', name: 'System Mock User' },
        project: projectBlock,
        merge_request: mergeRequest,
        object_attributes: {
          id: 501,
          status: input.event === 'pipeline_succeeded' ? 'success' : 'failed',
          ref: project.headBranch,
          sha: project.headSha,
          url: `${project.webUrl}/-/pipelines/501`,
        },
      },
    }
  }
  const gitlabAction =
    input.event === 'mr_opened'
      ? 'open'
      : input.event === 'mr_updated'
        ? 'update'
        : input.event === 'mr_merged'
          ? 'merge'
          : 'close'
  return {
    headers: {},
    payload: {
      object_kind: 'merge_request',
      user: { id: 7, username: 'system-mock-user', name: 'System Mock User' },
      project: projectBlock,
      object_attributes: { ...mergeRequest, action: gitlabAction },
    },
  }
}

function thisApiBase(project: StoredProject): string {
  return project.webUrl.slice(0, project.webUrl.length - project.projectPath.length) + 'api/v3'
}

export type { StoredProject }
