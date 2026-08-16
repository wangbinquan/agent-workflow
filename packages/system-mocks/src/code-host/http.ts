import type { IncomingMessage, ServerResponse } from 'node:http'

import { writeJson, writeText } from '../core/http'
import type { CodeHostStore, StoredProject } from './store'
import { SYSTEM_MOCK_CODE_HOST_TOKEN } from './store'

export async function handleCodeHostApi(input: {
  provider: 'gitlab' | 'github'
  request: IncomingMessage
  response: ServerResponse
  url: URL
  body: Buffer
  store: CodeHostStore
}): Promise<boolean> {
  const prefix = input.provider === 'gitlab' ? '/gitlab/api/v4' : '/github/api/v3'
  if (!input.url.pathname.startsWith(prefix)) return false
  const path = input.url.pathname.slice(prefix.length) || '/'
  if (!authorized(input.request, input.provider)) {
    writeJson(input.response, 401, { message: 'Bad credentials' })
    return true
  }
  if (path === '/user' && input.request.method === 'GET') {
    writeJson(
      input.response,
      200,
      input.provider === 'gitlab'
        ? { id: 7, username: 'system-mock-user', name: 'System Mock User' }
        : { id: 7, login: 'system-mock-user', name: 'System Mock User' },
    )
    return true
  }
  if (path === '/') {
    writeJson(input.response, 200, { service: `${input.provider}-system-mock`, ok: true })
    return true
  }
  return input.provider === 'gitlab'
    ? handleGitlab({ ...input, path })
    : handleGithub({ ...input, path })
}

function handleGitlab(input: Parameters<typeof handleCodeHostApi>[0] & { path: string }): boolean {
  const match = /^\/projects\/([^/]+)(.*)$/.exec(input.path)
  if (match === null) return notFound(input.response)
  const project = input.store.get('gitlab', match[1]!)
  if (project === undefined) return notFound(input.response)
  const rest = match[2] || ''
  const mr = gitlabMr(project)
  if (rest === '' && input.request.method === 'GET')
    return json(input.response, gitlabProject(project))
  if (/^\/merge_requests\/?$/.test(rest)) {
    if (input.request.method === 'GET') return json(input.response, [mr])
    if (input.request.method === 'POST') return json(input.response, mr, 201)
  }
  const mrMatch = /^\/merge_requests\/(\d+)(.*)$/.exec(rest)
  if (mrMatch !== null) {
    const tail = mrMatch[2] || ''
    if (tail === '' && ['GET', 'PUT'].includes(input.request.method ?? ''))
      return json(input.response, mr)
    if (tail === '/diffs' && input.request.method === 'GET')
      return json(input.response, [gitlabDiff(project)])
    if (tail === '/changes' && input.request.method === 'GET')
      return json(input.response, { ...mr, changes: [gitlabDiff(project)] })
    if (tail === '/discussions' && input.request.method === 'GET') return json(input.response, [])
    if (tail === '/notes' && input.request.method === 'GET') return json(input.response, [])
    if (/^\/(notes|discussions|draft_notes)/.test(tail))
      return json(input.response, { id: 91, body: jsonBody(input.body).body ?? 'ok' }, 201)
    if (tail === '/approve') return json(input.response, { approved: true })
    if (tail === '/merge')
      return json(input.response, { ...mr, state: 'merged', merged_by: { id: 7 } })
  }
  if (/^\/statuses\/[^/]+$/.test(rest))
    return json(input.response, { id: 701, sha: project.headSha, status: 'success' }, 201)
  if (rest === '/pipeline') return json(input.response, { id: 501, status: 'pending' }, 201)
  if (/^\/pipelines\/\d+\/(retry|cancel)$/.test(rest))
    return json(input.response, {
      id: 501,
      status: rest.endsWith('cancel') ? 'canceled' : 'pending',
    })
  if (/^\/pipelines\/\d+\/jobs$/.test(rest))
    return json(input.response, [{ id: 601, name: 'system-mock-job', status: 'failed' }])
  if (/^\/jobs\/\d+\/trace$/.test(rest)) return text(input.response, 'system mock job log\n')
  const fileMatch = /^\/repository\/files\/(.+)\/raw$/.exec(rest)
  if (fileMatch !== null) {
    const content = project.headFiles[decodeURIComponent(fileMatch[1]!)]
    if (content === undefined) return notFound(input.response)
    return text(input.response, content)
  }
  return notFound(input.response)
}

function handleGithub(input: Parameters<typeof handleCodeHostApi>[0] & { path: string }): boolean {
  if (input.path.startsWith('/downloads/')) return text(input.response, 'system mock job log\n')
  const match = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(input.path)
  if (match === null) return notFound(input.response)
  const project = input.store.get('github', match[1]!)
  if (project === undefined) return notFound(input.response)
  const rest = match[2] || ''
  const pr = githubPr(project)
  if (rest === '' && input.request.method === 'GET')
    return json(input.response, githubProject(project))
  if (rest === '/pulls') {
    if (input.request.method === 'GET') return json(input.response, [pr])
    if (input.request.method === 'POST') return json(input.response, pr, 201)
  }
  const prMatch = /^\/pulls\/(\d+)(.*)$/.exec(rest)
  if (prMatch !== null) {
    const tail = prMatch[2] || ''
    if (tail === '' && ['GET', 'PATCH'].includes(input.request.method ?? ''))
      return json(input.response, pr)
    if (tail === '/files') return json(input.response, [githubDiff(project)])
    if (tail === '/comments' && input.request.method === 'GET') return json(input.response, [])
    if (tail === '/reviews' || tail.startsWith('/comments'))
      return json(input.response, { id: 91, body: jsonBody(input.body).body ?? 'ok' }, 201)
    if (tail === '/merge') return json(input.response, { merged: true, sha: project.headSha })
  }
  if (/^\/issues\/\d+\/(comments|labels|assignees)/.test(rest))
    return json(input.response, { id: 92, body: jsonBody(input.body).body ?? 'ok' }, 201)
  if (/^\/statuses\/[^/]+$/.test(rest))
    return json(input.response, { id: 701, sha: project.headSha, state: 'success' }, 201)
  if (/^\/actions\/workflows\/[^/]+\/dispatches$/.test(rest)) {
    input.response.writeHead(204)
    input.response.end()
    return true
  }
  if (/^\/actions\/runs\/\d+\/(rerun-failed-jobs|cancel)$/.test(rest)) {
    input.response.writeHead(204)
    input.response.end()
    return true
  }
  if (/^\/actions\/runs\/\d+\/jobs$/.test(rest))
    return json(input.response, {
      total_count: 1,
      jobs: [{ id: 601, name: 'system-mock-job', conclusion: 'failure' }],
    })
  if (/^\/actions\/jobs\/\d+\/logs$/.test(rest)) {
    input.response.writeHead(302, {
      location: `${new URL(project.webUrl).origin}/github/api/v3/downloads/job.log`,
    })
    input.response.end()
    return true
  }
  const contentMatch = /^\/contents\/(.+)$/.exec(rest)
  if (contentMatch !== null) {
    const content = project.headFiles[decodeURIComponent(contentMatch[1]!)]
    if (content === undefined) return notFound(input.response)
    return json(input.response, {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(content).toString('base64'),
      sha: project.headSha,
    })
  }
  return notFound(input.response)
}

function authorized(request: IncomingMessage, provider: 'gitlab' | 'github'): boolean {
  if (provider === 'gitlab') {
    return (
      request.headers['private-token'] === SYSTEM_MOCK_CODE_HOST_TOKEN ||
      request.headers.authorization === `Bearer ${SYSTEM_MOCK_CODE_HOST_TOKEN}`
    )
  }
  return request.headers.authorization === `Bearer ${SYSTEM_MOCK_CODE_HOST_TOKEN}`
}

function gitlabProject(project: StoredProject): Record<string, unknown> {
  return {
    id: Number(project.projectId),
    path_with_namespace: project.projectPath,
    http_url_to_repo: project.repoHttpUrl,
    web_url: project.webUrl,
    default_branch: project.defaultBranch,
  }
}

function gitlabMr(project: StoredProject): Record<string, unknown> {
  return {
    id: Number(project.projectId) * 100 + project.number,
    iid: project.number,
    title: project.title,
    state: 'opened',
    source_branch: project.headBranch,
    target_branch: project.defaultBranch,
    sha: project.headSha,
    web_url: `${project.webUrl}/-/merge_requests/${project.number}`,
    references: { full: `${project.projectPath}!${project.number}` },
  }
}

function gitlabDiff(project: StoredProject): Record<string, unknown> {
  const path = Object.keys(project.headFiles)[0] ?? 'README.md'
  return {
    old_path: path,
    new_path: path,
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: '@@ -1 +1 @@\n-system mock\n+system mock changed\n',
  }
}

function githubProject(project: StoredProject): Record<string, unknown> {
  return {
    id: Number(project.projectId),
    name: project.projectPath.split('/').at(-1),
    full_name: project.projectPath,
    clone_url: project.repoHttpUrl,
    html_url: project.webUrl,
    default_branch: project.defaultBranch,
  }
}

function githubPr(project: StoredProject): Record<string, unknown> {
  return {
    id: Number(project.projectId) * 100 + project.number,
    number: project.number,
    title: project.title,
    state: 'open',
    html_url: `${project.webUrl}/pull/${project.number}`,
    head: { ref: project.headBranch, sha: project.headSha },
    base: { ref: project.defaultBranch, sha: project.baseSha },
  }
}

function githubDiff(project: StoredProject): Record<string, unknown> {
  const path = Object.keys(project.headFiles)[0] ?? 'README.md'
  return {
    filename: path,
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: '@@ -1 +1 @@\n-system mock\n+system mock changed\n',
    sha: project.headSha,
  }
}

function jsonBody(body: Buffer): Record<string, unknown> {
  try {
    return JSON.parse(body.toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function json(response: ServerResponse, value: unknown, status = 200): true {
  writeJson(response, status, value)
  return true
}

function text(response: ServerResponse, value: string, status = 200): true {
  writeText(response, status, value)
  return true
}

function notFound(response: ServerResponse): true {
  writeJson(response, 404, { message: 'Not Found' })
  return true
}
