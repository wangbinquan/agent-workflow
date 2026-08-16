import type { MockCodeHostUser, MockWebhookDeliveryInput } from '../types'
import type {
  StoredComment,
  StoredIssue,
  StoredMergeRequest,
  StoredProject,
  WebhookMutation,
} from './stateful-store'

const DEFAULT_ACTOR: Required<MockCodeHostUser> = {
  id: 7,
  username: 'system-mock-user',
  name: 'System Mock User',
}

export function buildWebhook(
  project: StoredProject,
  input: MockWebhookDeliveryInput,
  mutation: WebhookMutation,
): { payload: Record<string, unknown>; headers: Record<string, string> } {
  return project.provider === 'github'
    ? buildGithubWebhook(project, input, mutation)
    : buildGitlabWebhook(project, input, mutation)
}

function buildGithubWebhook(
  project: StoredProject,
  input: MockWebhookDeliveryInput,
  mutation: WebhookMutation,
): { payload: Record<string, unknown>; headers: Record<string, string> } {
  const number = input.number ?? project.number
  const actor = actorOf(input.actor)
  const repository = githubRepository(project)
  const mr = project.mergeRequests.get(number)
  const pullRequest = mr === undefined ? undefined : githubPullRequest(project, mr)
  const base = { repository, sender: githubUser(actor) }

  if (
    input.event === 'comment_created' &&
    pullRequest !== undefined &&
    mutation.comment !== undefined
  ) {
    return {
      headers: { 'x-github-event': 'issue_comment' },
      payload: {
        action: 'created',
        ...base,
        issue: {
          id: pullRequest.id,
          number,
          title: mr?.title,
          html_url: pullRequest.html_url,
          pull_request: {
            url: `${githubApiBase(project)}/repos/${project.projectPath}/pulls/${number}`,
          },
        },
        comment: githubIssueComment(project, number, mutation.comment),
      },
    }
  }
  if (
    input.event === 'review_comment_created' &&
    pullRequest !== undefined &&
    mutation.comment !== undefined
  ) {
    return {
      headers: { 'x-github-event': 'pull_request_review_comment' },
      payload: {
        action: 'created',
        ...base,
        pull_request: pullRequest,
        comment: githubReviewComment(project, number, mutation.comment, mr?.headSha ?? ''),
      },
    }
  }
  if (input.event === 'issue_labeled' && mutation.issue !== undefined) {
    return {
      headers: { 'x-github-event': 'issues' },
      payload: {
        action: 'labeled',
        ...base,
        issue: githubIssue(project, mutation.issue),
        label: { name: input.label ?? mutation.issue.labels.at(-1) ?? 'agent-workflow' },
      },
    }
  }
  if (
    input.event === 'issue_comment' &&
    mutation.issue !== undefined &&
    mutation.comment !== undefined
  ) {
    return {
      headers: { 'x-github-event': 'issue_comment' },
      payload: {
        action: 'created',
        ...base,
        issue: githubIssue(project, mutation.issue),
        comment: githubIssueComment(project, mutation.issue.number, mutation.comment),
      },
    }
  }
  if (
    (input.event === 'pipeline_succeeded' || input.event === 'pipeline_failed') &&
    mutation.pipeline !== undefined
  ) {
    const pipelineMr = project.mergeRequests.get(mutation.pipeline.mrNumber)
    return {
      headers: { 'x-github-event': 'workflow_run' },
      payload: {
        action: 'completed',
        ...base,
        workflow_run: {
          id: mutation.pipeline.id,
          conclusion: mutation.pipeline.state === 'succeeded' ? 'success' : 'failure',
          head_branch: pipelineMr?.sourceBranch,
          head_sha: mutation.pipeline.headSha,
          html_url: `${project.webUrl}/actions/runs/${String(mutation.pipeline.id)}`,
          actor: githubUser(actor),
          pull_requests:
            pipelineMr === undefined || pipelineMr.sourceProjectPath !== project.projectPath
              ? []
              : [
                  {
                    id: pipelineMr.id,
                    number: pipelineMr.number,
                    base: { ref: pipelineMr.targetBranch, sha: pipelineMr.baseSha },
                  },
                ],
        },
      },
    }
  }
  if (input.event === 'push') {
    return {
      headers: { 'x-github-event': 'push' },
      payload: {
        ...base,
        ref: `refs/heads/${mr?.sourceBranch ?? project.headBranch}`,
        before: mr?.baseSha ?? project.baseSha,
        after: mr?.headSha ?? project.headSha,
      },
    }
  }
  if (pullRequest === undefined) throw new Error(`unknown pull request ${number}`)
  const action =
    input.event === 'mr_opened' ? 'opened' : input.event === 'mr_updated' ? 'synchronize' : 'closed'
  return {
    headers: { 'x-github-event': 'pull_request' },
    payload: { action, ...base, pull_request: pullRequest },
  }
}

function buildGitlabWebhook(
  project: StoredProject,
  input: MockWebhookDeliveryInput,
  mutation: WebhookMutation,
): { payload: Record<string, unknown>; headers: Record<string, string> } {
  const number = input.number ?? project.number
  const actor = actorOf(input.actor)
  const user = gitlabUser(actor)
  const projectBlock = gitlabProjectBlock(project)
  const mr = project.mergeRequests.get(number)
  const mergeRequest = mr === undefined ? undefined : gitlabWebhookMergeRequest(project, mr)

  if (
    (input.event === 'comment_created' || input.event === 'review_comment_created') &&
    mergeRequest !== undefined &&
    mutation.comment !== undefined
  ) {
    return {
      headers: {},
      payload: {
        object_kind: 'note',
        user,
        project: projectBlock,
        merge_request: mergeRequest,
        object_attributes: {
          id: numericId(mutation.comment.id),
          noteable_type: 'MergeRequest',
          note: mutation.comment.body,
          discussion_id: mutation.comment.threadId,
          url: `${String(mergeRequest.url)}#note_${mutation.comment.id}`,
          ...(mutation.comment.position === null ? {} : { position: mutation.comment.position }),
        },
      },
    }
  }
  if (input.event === 'issue_labeled' && mutation.issue !== undefined) {
    const previous = mutation.previousLabels ?? []
    return {
      headers: {},
      payload: {
        object_kind: 'issue',
        user,
        project: projectBlock,
        labels: mutation.issue.labels.map((title) => ({ title })),
        object_attributes: { ...gitlabIssue(project, mutation.issue), action: 'update' },
        changes: {
          labels: {
            previous: previous.map((title) => ({ title })),
            current: mutation.issue.labels.map((title) => ({ title })),
          },
        },
      },
    }
  }
  if (
    input.event === 'issue_comment' &&
    mutation.issue !== undefined &&
    mutation.comment !== undefined
  ) {
    return {
      headers: {},
      payload: {
        object_kind: 'note',
        user,
        project: projectBlock,
        issue: gitlabIssue(project, mutation.issue),
        object_attributes: {
          id: numericId(mutation.comment.id),
          noteable_type: 'Issue',
          note: mutation.comment.body,
          url: `${project.webUrl}/-/issues/${String(mutation.issue.number)}#note_${mutation.comment.id}`,
        },
      },
    }
  }
  if (
    (input.event === 'pipeline_succeeded' || input.event === 'pipeline_failed') &&
    mutation.pipeline !== undefined
  ) {
    const pipelineMr = project.mergeRequests.get(mutation.pipeline.mrNumber)
    return {
      headers: {},
      payload: {
        object_kind: 'pipeline',
        user,
        project: projectBlock,
        ...(pipelineMr === undefined
          ? {}
          : { merge_request: gitlabWebhookMergeRequest(project, pipelineMr) }),
        object_attributes: {
          id: mutation.pipeline.id,
          status: mutation.pipeline.state === 'succeeded' ? 'success' : 'failed',
          ref: pipelineMr?.sourceBranch ?? project.headBranch,
          sha: mutation.pipeline.headSha,
          url: `${project.webUrl}/-/pipelines/${String(mutation.pipeline.id)}`,
        },
      },
    }
  }
  if (input.event === 'push') {
    return {
      headers: {},
      payload: {
        object_kind: 'push',
        user_id: actor.id,
        user_username: actor.username,
        user_name: actor.name,
        project: projectBlock,
        ref: `refs/heads/${mr?.sourceBranch ?? project.headBranch}`,
        before: mr?.baseSha ?? project.baseSha,
        after: mr?.headSha ?? project.headSha,
        checkout_sha: mr?.headSha ?? project.headSha,
      },
    }
  }
  if (mergeRequest === undefined) throw new Error(`unknown merge request ${number}`)
  const action =
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
      user,
      project: projectBlock,
      object_attributes: { ...mergeRequest, action },
    },
  }
}

function githubRepository(project: StoredProject): Record<string, unknown> {
  return {
    id: Number(project.projectId),
    name: project.projectPath.split('/').at(-1),
    full_name: project.projectPath,
    clone_url: project.repoHttpUrl,
    ssh_url: `git@system-mock:${project.projectPath}.git`,
    html_url: project.webUrl,
    default_branch: project.defaultBranch,
    owner: { login: project.projectPath.split('/')[0] },
  }
}

function githubPullRequest(
  project: StoredProject,
  mr: StoredMergeRequest,
): Record<string, unknown> {
  return {
    id: mr.id,
    number: mr.number,
    title: mr.title,
    body: mr.description,
    state: mr.state === 'opened' ? 'open' : 'closed',
    html_url: `${project.webUrl}/pull/${String(mr.number)}`,
    merged: mr.state === 'merged',
    user: githubUser(mr.author),
    head: {
      ref: mr.sourceBranch,
      sha: mr.headSha,
      label: `${mr.sourceProjectPath}:${mr.sourceBranch}`,
    },
    base: { ref: mr.targetBranch, sha: mr.baseSha },
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

function githubReviewComment(
  project: StoredProject,
  number: number,
  comment: StoredComment,
  headSha: string,
): Record<string, unknown> {
  const position = comment.position ?? {}
  return {
    id: numericId(comment.id),
    body: comment.body,
    user: githubUser(comment.author),
    created_at: comment.createdAt,
    html_url: `${project.webUrl}/pull/${String(number)}#discussion_r${comment.id}`,
    ...(comment.inReplyToId === null ? {} : { in_reply_to_id: numericId(comment.inReplyToId) }),
    commit_id: position.commit_id ?? headSha,
    ...position,
  }
}

function gitlabProjectBlock(project: StoredProject): Record<string, unknown> {
  return {
    id: Number(project.projectId),
    path_with_namespace: project.projectPath,
    git_http_url: project.repoHttpUrl,
    git_ssh_url: `git@system-mock:${project.projectPath}.git`,
    web_url: project.webUrl,
    default_branch: project.defaultBranch,
  }
}

function gitlabWebhookMergeRequest(
  project: StoredProject,
  mr: StoredMergeRequest,
): Record<string, unknown> {
  return {
    id: mr.id,
    iid: mr.number,
    title: mr.title,
    url: `${project.webUrl}/-/merge_requests/${String(mr.number)}`,
    source_branch: mr.sourceBranch,
    target_branch: mr.targetBranch,
    last_commit: { id: mr.headSha },
  }
}

function gitlabIssue(project: StoredProject, issue: StoredIssue): Record<string, unknown> {
  return {
    id: issue.id,
    iid: issue.number,
    title: issue.title,
    description: issue.body,
    state: issue.state,
    url: `${project.webUrl}/-/issues/${String(issue.number)}`,
    labels: issue.labels.map((title) => ({ title })),
  }
}

function githubUser(user: Required<MockCodeHostUser>): Record<string, unknown> {
  return { id: user.id, login: user.username, name: user.name }
}

function gitlabUser(user: Required<MockCodeHostUser>): Record<string, unknown> {
  return { id: user.id, username: user.username, name: user.name }
}

function actorOf(user: MockCodeHostUser | undefined): Required<MockCodeHostUser> {
  return {
    id: user?.id ?? DEFAULT_ACTOR.id,
    username: user?.username ?? DEFAULT_ACTOR.username,
    name: user?.name ?? user?.username ?? DEFAULT_ACTOR.name,
  }
}

function githubApiBase(project: StoredProject): string {
  return project.webUrl.slice(0, project.webUrl.length - project.projectPath.length) + 'api/v3'
}

export function gitlabEventHeader(event: MockWebhookDeliveryInput['event']): string {
  if (
    event === 'comment_created' ||
    event === 'review_comment_created' ||
    event === 'issue_comment'
  ) {
    return 'Note Hook'
  }
  if (event.startsWith('pipeline_')) return 'Pipeline Hook'
  if (event === 'issue_labeled') return 'Issue Hook'
  if (event === 'push') return 'Push Hook'
  return 'Merge Request Hook'
}

function numericId(id: string): number | string {
  const parsed = Number(id)
  return Number.isSafeInteger(parsed) ? parsed : id
}
