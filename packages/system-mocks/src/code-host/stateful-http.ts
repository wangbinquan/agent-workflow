import type { IncomingMessage, ServerResponse } from 'node:http'

import { writeJson, writeText } from '../core/http'
import { readStoredDiff, type StoredDiffEntry } from './diff'
import {
  DEFAULT_AUTHOR,
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  SYSTEM_MOCK_GIT_GLOBAL_TOKEN,
  SYSTEM_MOCK_GIT_PERSONAL_TOKEN,
  SYSTEM_GLOBAL_USER,
  SYSTEM_PERSONAL_USER,
  SYSTEM_USER,
  type CodeHostStore,
  type StoredComment,
  type StoredIssue,
  type StoredMergeRequest,
  type StoredPipeline,
  type StoredProject,
} from './stateful-store'

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

  // GitHub's job-log endpoint redirects to a signed URL. Production deliberately
  // strips Authorization on that hop; requiring it here would make the safe path fail.
  if (input.provider === 'github' && path.startsWith('/downloads/jobs/')) {
    const jobId = Number(path.slice('/downloads/jobs/'.length))
    const job = findJob(input.store, jobId)
    return job === null ? notFound(input.response) : text(input.response, job.log)
  }
  const authenticatedUser = identityFor(input.request, input.provider)
  if (authenticatedUser === null) {
    writeJson(input.response, 401, { message: 'Bad credentials' })
    return true
  }
  if (path === '/user' && input.request.method === 'GET') {
    return json(
      input.response,
      input.provider === 'gitlab'
        ? {
            id: authenticatedUser.id,
            username: authenticatedUser.username,
            name: authenticatedUser.name,
          }
        : {
            id: authenticatedUser.id,
            login: authenticatedUser.username,
            name: authenticatedUser.name,
          },
    )
  }
  if (path === '/')
    return json(input.response, { service: `${input.provider}-system-mock`, ok: true })

  await input.store.syncRefsFromGit()
  return input.provider === 'gitlab'
    ? await handleGitlab({ ...input, path })
    : await handleGithub({ ...input, path })
}

async function handleGitlab(
  input: Parameters<typeof handleCodeHostApi>[0] & { path: string },
): Promise<boolean> {
  const match = /^\/projects\/([^/]+)(.*)$/.exec(input.path)
  if (match === null) return notFound(input.response)
  const project = input.store.get('gitlab', match[1]!)
  if (project === undefined) return notFound(input.response)
  const rest = match[2] || ''
  if (rest === '' && input.request.method === 'GET')
    return json(input.response, gitlabProject(project))

  if (/^\/merge_requests\/?$/.test(rest)) {
    if (input.request.method === 'GET') {
      const state = input.url.searchParams.get('state')
      return json(
        input.response,
        [...project.mergeRequests.values()]
          .filter((mr) => state === null || state === 'all' || mr.state === state)
          .map((mr) => gitlabMr(project, mr)),
      )
    }
    if (input.request.method === 'POST') {
      const body = jsonBody(input.body)
      try {
        const mr = await input.store.createMergeRequest(project, {
          title: stringField(body, 'title', 'System mock merge request'),
          description: stringField(body, 'description', ''),
          sourceBranch: stringField(body, 'source_branch'),
          targetBranch: stringField(body, 'target_branch'),
          author: DEFAULT_AUTHOR,
        })
        return json(input.response, gitlabMr(project, mr), 201)
      } catch (error) {
        return json(input.response, { message: String(error) }, 422)
      }
    }
  }

  const mrMatch = /^\/merge_requests\/(\d+)(.*)$/.exec(rest)
  if (mrMatch !== null) {
    const mr = project.mergeRequests.get(Number(mrMatch[1]))
    if (mr === undefined) return notFound(input.response)
    const tail = mrMatch[2] || ''
    if (tail === '' && ['GET', 'PUT'].includes(input.request.method ?? '')) {
      if (input.request.method === 'PUT') updateGitlabMr(mr, jsonBody(input.body))
      return json(input.response, gitlabMr(project, mr))
    }
    if ((tail === '/diffs' || tail === '/changes') && input.request.method === 'GET') {
      const diff = (await readStoredDiff(project, mr)).map(gitlabDiff)
      return json(
        input.response,
        tail === '/changes' ? { ...gitlabMr(project, mr), changes: diff } : diff,
      )
    }
    if (tail === '/draft_notes' && input.request.method === 'GET') {
      return json(input.response, mr.drafts.map(gitlabDraft))
    }
    if (tail === '/draft_notes' && input.request.method === 'POST') {
      const body = jsonBody(input.body)
      const position = objectField(body, 'position')
      if (!validGitlabPosition(mr, position)) {
        return json(input.response, { message: 'invalid merge request diff position' }, 422)
      }
      const draft = input.store.addDraft(project, mr.number, {
        body: stringField(body, 'note'),
        position: position!,
      })
      return json(input.response, gitlabDraft(draft), 201)
    }
    if (tail === '/draft_notes/bulk_publish' && input.request.method === 'POST') {
      return json(
        input.response,
        { published: input.store.publishDrafts(project, mr.number).length },
        201,
      )
    }
    const draftMatch = /^\/draft_notes\/(\d+)$/.exec(tail)
    if (draftMatch !== null && input.request.method === 'DELETE') {
      if (!input.store.discardDraft(project, mr.number, draftMatch[1]!))
        return notFound(input.response)
      input.response.writeHead(204)
      input.response.end()
      return true
    }
    if (tail === '/discussions' && input.request.method === 'GET') {
      return json(input.response, gitlabDiscussions(mr))
    }
    if (tail === '/discussions' && input.request.method === 'POST') {
      const body = jsonBody(input.body)
      const position = objectField(body, 'position')
      if (!validGitlabPosition(mr, position)) {
        return json(input.response, { message: 'invalid merge request diff position' }, 422)
      }
      const comment = input.store.addReviewComment(project, mr.number, {
        body: stringField(body, 'body'),
        position: position!,
      })
      return json(input.response, gitlabDiscussion(mr, comment.threadId!), 201)
    }
    const discussionMatch = /^\/discussions\/([^/]+)(?:\/notes)?$/.exec(tail)
    if (discussionMatch !== null) {
      const threadId = decodeURIComponent(discussionMatch[1]!)
      if (tail.endsWith('/notes') && input.request.method === 'POST') {
        const comment = input.store.addReviewComment(project, mr.number, {
          body: stringField(jsonBody(input.body), 'body'),
          threadId,
          inReplyToId: firstCommentInThread(mr, threadId)?.id,
        })
        return json(input.response, gitlabNote(comment), 201)
      }
      if (input.request.method === 'PUT') {
        if (!input.store.resolveDiscussion(project, mr.number, threadId))
          return notFound(input.response)
        return json(input.response, gitlabDiscussion(mr, threadId))
      }
      if (input.request.method === 'GET') {
        const discussion = gitlabDiscussion(mr, threadId)
        return discussion === null ? notFound(input.response) : json(input.response, discussion)
      }
    }
    if (tail === '/notes' && input.request.method === 'GET') {
      return json(input.response, mr.issueComments.map(gitlabNote))
    }
    if (tail === '/notes' && input.request.method === 'POST') {
      return json(
        input.response,
        gitlabNote(
          input.store.addMergeRequestComment(
            project,
            mr.number,
            stringField(jsonBody(input.body), 'body'),
          ),
        ),
        201,
      )
    }
    const noteMatch = /^\/notes\/(\d+)$/.exec(tail)
    if (noteMatch !== null && input.request.method === 'PUT') {
      const updated = input.store.updateComment(
        project,
        noteMatch[1]!,
        stringField(jsonBody(input.body), 'body'),
      )
      return updated === null ? notFound(input.response) : json(input.response, gitlabNote(updated))
    }
    if (tail === '/approve') return json(input.response, { approved: true })
    if (tail === '/merge') {
      mr.state = 'merged'
      return json(input.response, {
        ...gitlabMr(project, mr),
        state: 'merged',
        merged_by: gitlabUser(SYSTEM_USER),
      })
    }
  }

  const issueMatch = /^\/issues\/(\d+)(.*)$/.exec(rest)
  if (issueMatch !== null) {
    const issue = project.issues.get(Number(issueMatch[1]))
    if (issue === undefined) return notFound(input.response)
    const tail = issueMatch[2] || ''
    if (tail === '' && input.request.method === 'GET')
      return json(input.response, gitlabIssue(project, issue))
    if (tail === '/notes' && input.request.method === 'GET') {
      return json(input.response, issue.comments.map(gitlabNote))
    }
    if (tail === '/notes' && input.request.method === 'POST') {
      return json(
        input.response,
        gitlabNote(
          input.store.addIssueComment(
            project,
            issue.number,
            stringField(jsonBody(input.body), 'body'),
          ),
        ),
        201,
      )
    }
  }

  const statusMatch = /^\/statuses\/([^/]+)$/.exec(rest)
  if (statusMatch !== null)
    return json(input.response, { id: 701, sha: statusMatch[1], status: 'success' }, 201)
  if (rest === '/pipeline' && input.request.method === 'POST') {
    return json(
      input.response,
      gitlabPipeline(input.store.setPipeline(project, { state: 'pending' })),
      201,
    )
  }
  const pipelineAction = /^\/pipelines\/(\d+)\/(retry|cancel)$/.exec(rest)
  if (pipelineAction !== null) {
    const pipeline = project.pipelines.get(Number(pipelineAction[1]))
    if (pipeline === undefined) return notFound(input.response)
    pipeline.state = pipelineAction[2] === 'cancel' ? 'canceled' : 'pending'
    return json(input.response, gitlabPipeline(pipeline))
  }
  const pipelineJobs = /^\/pipelines\/(\d+)\/jobs$/.exec(rest)
  if (pipelineJobs !== null) {
    const pipeline = project.pipelines.get(Number(pipelineJobs[1]))
    return pipeline === undefined
      ? notFound(input.response)
      : json(input.response, pipeline.jobs.map(gitlabJob))
  }
  const jobTrace = /^\/jobs\/(\d+)\/trace$/.exec(rest)
  if (jobTrace !== null) {
    const job = findProjectJob(project, Number(jobTrace[1]))
    return job === null ? notFound(input.response) : text(input.response, job.log)
  }
  const branchMatch = /^\/repository\/branches\/(.+)$/.exec(rest)
  if (branchMatch !== null && input.request.method === 'GET') {
    const branch = decodeURIComponent(branchMatch[1]!)
    const sha =
      branch === project.defaultBranch
        ? project.baseSha
        : [...project.mergeRequests.values()].find((mr) => mr.sourceBranch === branch)?.headSha
    return sha === undefined
      ? notFound(input.response)
      : json(input.response, {
          name: branch,
          commit: { id: sha, short_id: sha.slice(0, 8) },
        })
  }
  const fileMatch = /^\/repository\/files\/(.+)\/raw$/.exec(rest)
  if (fileMatch !== null) {
    const ref = input.url.searchParams.get('ref') ?? project.headSha
    const content = await input.store.readFile(project, ref, decodeURIComponent(fileMatch[1]!))
    return content === null ? notFound(input.response) : binary(input.response, content)
  }
  return notFound(input.response)
}

async function handleGithub(
  input: Parameters<typeof handleCodeHostApi>[0] & { path: string },
): Promise<boolean> {
  const match = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(input.path)
  if (match === null) return notFound(input.response)
  const project = input.store.get('github', match[1]!)
  if (project === undefined) return notFound(input.response)
  const rest = match[2] || ''
  if (rest === '' && input.request.method === 'GET')
    return json(input.response, githubProject(project))

  if (rest === '/pulls') {
    if (input.request.method === 'GET') {
      const state = input.url.searchParams.get('state')
      return json(
        input.response,
        [...project.mergeRequests.values()]
          .filter((mr) => state === null || state === 'all' || githubState(mr) === state)
          .map((mr) => githubPr(project, mr)),
      )
    }
    if (input.request.method === 'POST') {
      const body = jsonBody(input.body)
      const rawHead = stringField(body, 'head')
      const [sourceOwner, branch = rawHead] = rawHead.includes(':') ? rawHead.split(':', 2) : []
      const sourceProjectPath =
        sourceOwner === undefined
          ? project.projectPath
          : `${sourceOwner}/${project.projectPath.split('/').at(-1)!}`
      try {
        const mr = await input.store.createMergeRequest(project, {
          title: stringField(body, 'title', 'System mock pull request'),
          description: stringField(body, 'body', ''),
          sourceBranch: branch,
          targetBranch: stringField(body, 'base'),
          sourceProjectPath,
          author: DEFAULT_AUTHOR,
        })
        return json(input.response, githubPr(project, mr), 201)
      } catch (error) {
        return json(input.response, { message: String(error) }, 422)
      }
    }
  }

  const prMatch = /^\/pulls\/(\d+)(.*)$/.exec(rest)
  if (prMatch !== null) {
    const mr = project.mergeRequests.get(Number(prMatch[1]))
    if (mr === undefined) return notFound(input.response)
    const tail = prMatch[2] || ''
    if (tail === '' && ['GET', 'PATCH'].includes(input.request.method ?? '')) {
      if (input.request.method === 'PATCH') updateGithubMr(mr, jsonBody(input.body))
      return json(input.response, githubPr(project, mr))
    }
    if (tail === '/files' && input.request.method === 'GET') {
      return json(
        input.response,
        (await readStoredDiff(project, mr)).map((entry) => githubDiff(entry, mr)),
      )
    }
    if (tail === '/comments' && input.request.method === 'GET') {
      return json(
        input.response,
        mr.reviewComments.map((comment) => githubReviewComment(project, mr, comment)),
      )
    }
    if (tail === '/comments' && input.request.method === 'POST') {
      const body = jsonBody(input.body)
      const comment = input.store.addReviewComment(project, mr.number, {
        body: stringField(body, 'body'),
        ...(body.in_reply_to === undefined ? {} : { inReplyToId: String(body.in_reply_to) }),
        position: reviewPosition(body),
      })
      return json(input.response, githubReviewComment(project, mr, comment), 201)
    }
    const replyMatch = /^\/comments\/(\d+)\/replies$/.exec(tail)
    if (replyMatch !== null && input.request.method === 'POST') {
      const root = mr.reviewComments.find((comment) => comment.id === replyMatch[1])
      if (root === undefined) return notFound(input.response)
      const reply = input.store.addReviewComment(project, mr.number, {
        body: stringField(jsonBody(input.body), 'body'),
        inReplyToId: root.id,
        position: root.position ?? undefined,
      })
      return json(input.response, githubReviewComment(project, mr, reply), 201)
    }
    if (tail === '/reviews' && input.request.method === 'POST') {
      const body = jsonBody(input.body)
      const commitId = stringField(body, 'commit_id', mr.headSha)
      if (commitId !== mr.headSha)
        return json(input.response, { message: 'commit_id is not the current head' }, 422)
      const comments = Array.isArray(body.comments) ? body.comments : []
      for (const raw of comments) {
        if (typeof raw !== 'object' || raw === null) continue
        const comment = raw as Record<string, unknown>
        input.store.addReviewComment(project, mr.number, {
          body: stringField(comment, 'body'),
          position: { ...reviewPosition(comment), commit_id: commitId },
        })
      }
      return json(
        input.response,
        { id: Number(input.store.allocateId(project)), state: 'COMMENTED', body: body.body ?? '' },
        201,
      )
    }
    if (tail === '/merge') {
      mr.state = 'merged'
      return json(input.response, { merged: true, sha: mr.headSha })
    }
  }

  const issueMatch = /^\/issues\/(\d+)(.*)$/.exec(rest)
  if (issueMatch !== null) {
    const number = Number(issueMatch[1])
    const issue = project.issues.get(number)
    const mr = project.mergeRequests.get(number)
    if (issue === undefined && mr === undefined) return notFound(input.response)
    const tail = issueMatch[2] || ''
    if (tail === '' && input.request.method === 'GET') {
      return json(
        input.response,
        issue === undefined ? githubIssueForPr(project, mr!) : githubIssue(project, issue),
      )
    }
    if (tail === '/comments' && input.request.method === 'GET') {
      const comments = issue === undefined ? mr!.issueComments : issue.comments
      return json(
        input.response,
        comments.map((comment) => githubIssueComment(project, number, comment)),
      )
    }
    if (tail === '/comments' && input.request.method === 'POST') {
      const body = stringField(jsonBody(input.body), 'body')
      const comment =
        issue === undefined
          ? input.store.addMergeRequestComment(project, number, body)
          : input.store.addIssueComment(project, number, body)
      return json(input.response, githubIssueComment(project, number, comment), 201)
    }
    if (tail === '/labels' && input.request.method === 'POST') {
      const labels = arrayOfStrings(jsonBody(input.body).labels)
      if (issue !== undefined) issue.labels = [...new Set([...issue.labels, ...labels])]
      return json(
        input.response,
        labels.map((name) => ({ name })),
        201,
      )
    }
    if (tail === '/assignees' && input.request.method === 'POST')
      return json(input.response, { ok: true }, 201)
  }

  const updateComment = /^\/(issues|pulls)\/comments\/(\d+)$/.exec(rest)
  if (updateComment !== null && input.request.method === 'PATCH') {
    const comment = input.store.updateComment(
      project,
      updateComment[2]!,
      stringField(jsonBody(input.body), 'body'),
    )
    return comment === null
      ? notFound(input.response)
      : json(
          input.response,
          updateComment[1] === 'issues'
            ? githubIssueComment(project, project.number, comment)
            : githubReviewComment(project, project.mergeRequests.get(project.number)!, comment),
        )
  }

  const statusMatch = /^\/statuses\/([^/]+)$/.exec(rest)
  if (statusMatch !== null)
    return json(input.response, { id: 701, sha: statusMatch[1], state: 'success' }, 201)
  if (/^\/actions\/workflows\/[^/]+\/dispatches$/.test(rest)) {
    input.response.writeHead(204)
    input.response.end()
    return true
  }
  const runAction = /^\/actions\/runs\/(\d+)\/(rerun-failed-jobs|cancel)$/.exec(rest)
  if (runAction !== null) {
    const pipeline = project.pipelines.get(Number(runAction[1]))
    if (pipeline === undefined) return notFound(input.response)
    pipeline.state = runAction[2] === 'cancel' ? 'canceled' : 'pending'
    input.response.writeHead(204)
    input.response.end()
    return true
  }
  const runJobs = /^\/actions\/runs\/(\d+)\/jobs$/.exec(rest)
  if (runJobs !== null) {
    const pipeline = project.pipelines.get(Number(runJobs[1]))
    return pipeline === undefined
      ? notFound(input.response)
      : json(input.response, {
          total_count: pipeline.jobs.length,
          jobs: pipeline.jobs.map(githubJob),
        })
  }
  const jobLogs = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest)
  if (jobLogs !== null) {
    const job = findProjectJob(project, Number(jobLogs[1]))
    if (job === null) return notFound(input.response)
    input.response.writeHead(302, {
      location: `${new URL(project.webUrl).origin}/github/api/v3/downloads/jobs/${String(job.id)}`,
    })
    input.response.end()
    return true
  }
  const contentMatch = /^\/contents\/(.+)$/.exec(rest)
  if (contentMatch !== null) {
    const ref = input.url.searchParams.get('ref') ?? project.headSha
    const content = await input.store.readFile(project, ref, decodeURIComponent(contentMatch[1]!))
    if (content === null) return notFound(input.response)
    if ((input.request.headers.accept ?? '').includes('application/vnd.github.raw')) {
      return binary(input.response, content)
    }
    return json(input.response, {
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
      sha: ref,
    })
  }
  return notFound(input.response)
}

function identityFor(
  request: IncomingMessage,
  provider: 'gitlab' | 'github',
): typeof SYSTEM_USER | null {
  const token =
    provider === 'gitlab'
      ? (request.headers['private-token'] ??
        request.headers.authorization?.replace(/^Bearer\s+/i, ''))
      : request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (token === SYSTEM_MOCK_GIT_PERSONAL_TOKEN) return SYSTEM_PERSONAL_USER
  if (token === SYSTEM_MOCK_GIT_GLOBAL_TOKEN) return SYSTEM_GLOBAL_USER
  if (token === SYSTEM_MOCK_CODE_HOST_TOKEN) return SYSTEM_USER
  return null
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

function gitlabMr(project: StoredProject, mr: StoredMergeRequest): Record<string, unknown> {
  return {
    id: mr.id,
    iid: mr.number,
    title: mr.title,
    description: mr.description,
    state: mr.state,
    source_branch: mr.sourceBranch,
    target_branch: mr.targetBranch,
    sha: mr.headSha,
    diff_refs: { base_sha: mr.baseSha, start_sha: mr.baseSha, head_sha: mr.headSha },
    detailed_merge_status:
      mr.state !== 'opened'
        ? 'not_open'
        : mr.mergeableState === 'conflict'
          ? 'conflict'
          : mr.mergeableState === 'mergeable'
            ? 'mergeable'
            : 'checking',
    merge_status:
      mr.state !== 'opened'
        ? 'unchecked'
        : mr.mergeableState === 'conflict'
          ? 'cannot_be_merged'
          : mr.mergeableState === 'mergeable'
            ? 'can_be_merged'
            : 'unchecked',
    author: gitlabUser(mr.author),
    web_url: `${project.webUrl}/-/merge_requests/${String(mr.number)}`,
    references: { full: `${project.projectPath}!${String(mr.number)}` },
  }
}

function gitlabDiff(entry: StoredDiffEntry): Record<string, unknown> {
  const path = entry.newPath ?? entry.oldPath ?? ''
  return {
    old_path: entry.oldPath ?? path,
    new_path: entry.newPath ?? path,
    new_file: entry.status === 'added',
    renamed_file: entry.status === 'renamed',
    deleted_file: entry.status === 'deleted',
    diff: entry.patch,
  }
}

function gitlabDraft(comment: StoredComment): Record<string, unknown> {
  return {
    id: numericId(comment.id),
    note: comment.body,
    position: comment.position,
    author: gitlabUser(comment.author),
  }
}

function gitlabDiscussions(mr: StoredMergeRequest): Record<string, unknown>[] {
  const ids = new Set(
    [...mr.reviewComments, ...mr.issueComments]
      .map((comment) => comment.threadId)
      .filter((id): id is string => id !== null),
  )
  return [...ids]
    .map((id) => gitlabDiscussion(mr, id))
    .filter((discussion): discussion is Record<string, unknown> => discussion !== null)
}

function gitlabDiscussion(
  mr: StoredMergeRequest,
  threadId: string,
): Record<string, unknown> | null {
  const notes = [...mr.reviewComments, ...mr.issueComments].filter(
    (comment) => comment.threadId === threadId,
  )
  return notes.length === 0 ? null : { id: threadId, notes: notes.map(gitlabNote) }
}

function gitlabNote(comment: StoredComment): Record<string, unknown> {
  return {
    id: numericId(comment.id),
    body: comment.body,
    author: gitlabUser(comment.author),
    created_at: comment.createdAt,
    resolved: comment.resolved,
    position: comment.position,
  }
}

function gitlabIssue(project: StoredProject, issue: StoredIssue): Record<string, unknown> {
  return {
    id: issue.id,
    iid: issue.number,
    title: issue.title,
    description: issue.body,
    state: issue.state,
    web_url: `${project.webUrl}/-/issues/${String(issue.number)}`,
    labels: issue.labels,
    author: gitlabUser(issue.author),
  }
}

function gitlabPipeline(pipeline: StoredPipeline): Record<string, unknown> {
  return { id: pipeline.id, status: gitlabPipelineState(pipeline.state), sha: pipeline.headSha }
}

function gitlabJob(job: StoredPipeline['jobs'][number]): Record<string, unknown> {
  return { id: job.id, name: job.name, status: gitlabPipelineState(job.state) }
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

function githubPr(project: StoredProject, mr: StoredMergeRequest): Record<string, unknown> {
  return {
    id: mr.id,
    number: mr.number,
    title: mr.title,
    body: mr.description,
    state: githubState(mr),
    html_url: `${project.webUrl}/pull/${String(mr.number)}`,
    merged: mr.state === 'merged',
    mergeable:
      mr.state !== 'opened'
        ? null
        : mr.mergeableState === 'unknown'
          ? null
          : mr.mergeableState === 'mergeable',
    mergeable_state:
      mr.state !== 'opened'
        ? 'unknown'
        : mr.mergeableState === 'conflict'
          ? 'dirty'
          : mr.mergeableState === 'mergeable'
            ? 'clean'
            : 'unknown',
    user: githubUser(mr.author),
    head: {
      ref: mr.sourceBranch,
      sha: mr.headSha,
      label: `${mr.sourceProjectPath}:${mr.sourceBranch}`,
    },
    base: { ref: mr.targetBranch, sha: mr.baseSha },
  }
}

function githubDiff(entry: StoredDiffEntry, mr: StoredMergeRequest): Record<string, unknown> {
  const filename = entry.newPath ?? entry.oldPath ?? ''
  return {
    filename,
    ...(entry.status === 'renamed' && entry.oldPath !== null
      ? { previous_filename: entry.oldPath }
      : {}),
    status:
      entry.status === 'added' ? 'added' : entry.status === 'deleted' ? 'removed' : entry.status,
    additions: entry.additions,
    deletions: entry.deletions,
    changes: entry.additions + entry.deletions,
    ...(entry.omission === 'none' ? { patch: entry.patch } : {}),
    sha: mr.headSha,
  }
}

function githubReviewComment(
  project: StoredProject,
  mr: StoredMergeRequest,
  comment: StoredComment,
): Record<string, unknown> {
  return {
    id: numericId(comment.id),
    body: comment.body,
    user: githubUser(comment.author),
    created_at: comment.createdAt,
    html_url: `${project.webUrl}/pull/${String(mr.number)}#discussion_r${comment.id}`,
    ...(comment.inReplyToId === null ? {} : { in_reply_to_id: numericId(comment.inReplyToId) }),
    commit_id: comment.position?.commit_id ?? mr.headSha,
    ...(comment.position ?? {}),
  }
}

function githubIssue(project: StoredProject, issue: StoredIssue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'opened' ? 'open' : 'closed',
    html_url: `${project.webUrl}/issues/${String(issue.number)}`,
    user: githubUser(issue.author),
    labels: issue.labels.map((name) => ({ name })),
  }
}

function githubIssueForPr(project: StoredProject, mr: StoredMergeRequest): Record<string, unknown> {
  return {
    id: mr.id,
    number: mr.number,
    title: mr.title,
    body: mr.description,
    state: githubState(mr),
    html_url: `${project.webUrl}/pull/${String(mr.number)}`,
    pull_request: { url: `${project.webUrl}/pull/${String(mr.number)}` },
    user: githubUser(mr.author),
    labels: [],
  }
}

function githubIssueComment(
  project: StoredProject,
  number: number,
  comment: StoredComment,
): Record<string, unknown> {
  return {
    id: numericId(comment.id),
    body: comment.body,
    user: githubUser(comment.author),
    created_at: comment.createdAt,
    html_url: `${project.webUrl}/issues/${String(number)}#issuecomment-${comment.id}`,
  }
}

function githubJob(job: StoredPipeline['jobs'][number]): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    status: job.state === 'running' ? 'in_progress' : 'completed',
    conclusion: githubConclusion(job.state),
  }
}

function validGitlabPosition(
  mr: StoredMergeRequest,
  position: Record<string, unknown> | null,
): boolean {
  return (
    position !== null &&
    position.position_type === 'text' &&
    position.base_sha === mr.baseSha &&
    position.start_sha === mr.baseSha &&
    position.head_sha === mr.headSha &&
    (typeof position.new_path === 'string' || typeof position.old_path === 'string')
  )
}

function reviewPosition(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [
      'commit_id',
      'path',
      'line',
      'side',
      'start_line',
      'start_side',
      'original_line',
      'original_start_line',
    ]
      .filter((key) => body[key] !== undefined)
      .map((key) => [key, body[key]]),
  )
}

function updateGitlabMr(mr: StoredMergeRequest, body: Record<string, unknown>): void {
  if (typeof body.title === 'string') mr.title = body.title
  if (typeof body.description === 'string') mr.description = body.description
  if (typeof body.state_event === 'string') {
    if (body.state_event === 'close') mr.state = 'closed'
    if (body.state_event === 'reopen') mr.state = 'opened'
  }
}

function updateGithubMr(mr: StoredMergeRequest, body: Record<string, unknown>): void {
  if (typeof body.title === 'string') mr.title = body.title
  if (typeof body.body === 'string') mr.description = body.body
  if (body.state === 'closed' || body.state === 'open')
    mr.state = body.state === 'open' ? 'opened' : 'closed'
}

function firstCommentInThread(mr: StoredMergeRequest, threadId: string): StoredComment | undefined {
  return mr.reviewComments.find((comment) => comment.threadId === threadId)
}

function findJob(store: CodeHostStore, id: number): StoredPipeline['jobs'][number] | null {
  for (const project of store.list()) {
    const internal = store.get(project.provider, project.projectPath)
    if (internal === undefined) continue
    const job = findProjectJob(internal, id)
    if (job !== null) return job
  }
  return null
}

function findProjectJob(project: StoredProject, id: number): StoredPipeline['jobs'][number] | null {
  for (const pipeline of project.pipelines.values()) {
    const job = pipeline.jobs.find((candidate) => candidate.id === id)
    if (job !== undefined) return job
  }
  return null
}

function githubState(mr: StoredMergeRequest): 'open' | 'closed' {
  return mr.state === 'opened' ? 'open' : 'closed'
}

function gitlabPipelineState(state: StoredPipeline['state']): string {
  return state === 'succeeded' ? 'success' : state === 'canceled' ? 'canceled' : state
}

function githubConclusion(state: StoredPipeline['state']): string | null {
  if (state === 'succeeded') return 'success'
  if (state === 'failed') return 'failure'
  if (state === 'canceled') return 'cancelled'
  return null
}

function gitlabUser(user: StoredComment['author']): Record<string, unknown> {
  return { id: user.id, username: user.username, name: user.name }
}

function githubUser(user: StoredComment['author']): Record<string, unknown> {
  return { id: user.id, login: user.username, name: user.name }
}

function jsonBody(body: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function stringField(body: Record<string, unknown>, key: string, fallback?: string): string {
  const value = body[key]
  if (typeof value === 'string' && value !== '') return value
  if (fallback !== undefined) return fallback
  throw new Error(`request body is missing '${key}'`)
}

function objectField(body: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = body[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function numericId(id: string): number | string {
  const parsed = Number(id)
  return Number.isSafeInteger(parsed) ? parsed : id
}

function json(response: ServerResponse, value: unknown, status = 200): true {
  writeJson(response, status, value)
  return true
}

function text(response: ServerResponse, value: string, status = 200): true {
  writeText(response, status, value)
  return true
}

function binary(response: ServerResponse, value: Buffer, status = 200): true {
  writeText(response, status, value, 'application/octet-stream')
  return true
}

function notFound(response: ServerResponse): true {
  writeJson(response, 404, { message: 'Not Found' })
  return true
}
