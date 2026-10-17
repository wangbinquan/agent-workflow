// RFC-370 §9.2 V3 — a hosted task's publication (commit-and-push) network Git
// runs in its task volume through the task-image `git` command (which receives
// the deployment's Git credentials), never as local Git on a `cs-workspace:`
// reference. Before this, the PostgreSQL daemon root's in-process transport ran
// local git against the hosted reference and every hosted publish failed.
import { expect, test } from 'bun:test'
import { createHostedRepositoryPublicationTransport } from '@/modules/source-control/infrastructure/crewstation/publicationTransport'
import {
  hostedWorkspaceReference,
  parseHostedWorkspaceReference,
} from '@/modules/source-control/infrastructure/crewstation/workspaceReference'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'

test('network Git of a publication runs as one volume command per call', async () => {
  const calls: { taskId: string; operation: string; value: unknown; options: unknown }[] = []
  const helper: WorkspaceHelper = {
    async call<T>(taskId: string, operation: string, value: unknown, options?: unknown) {
      calls.push({ taskId, operation, value, options })
      return { stdout: 'pushed', stderr: '', exitCode: 0 } as T
    },
  }
  const transport = createHostedRepositoryPublicationTransport({ helper })
  const opened = await transport.open({
    subject: { kind: 'user', userId: 'user' } as never,
    remoteUrl: 'http://user:secret@gitlab.local/group/repo.git',
  })
  if (!opened.ok) throw new Error('fixture')
  // The sanitized endpoint never carries credentials.
  expect(opened.session.endpointUrl).toBe('http://gitlab.local/group/repo.git')
  expect(opened.session.receipt).toMatchObject({ credentialSource: 'global' })
  const worktree = hostedWorkspaceReference('task-1', '/work/worktrees/task-1')
  const controller = new AbortController()
  const result = await opened.session.runNetwork(worktree, ['push', 'origin', 'aw/task-1'], {
    env: { GIT_TERMINAL_PROMPT: '0' },
    timeoutMs: 60_000,
    signal: controller.signal,
  })
  expect(result).toEqual({ stdout: 'pushed', stderr: '', exitCode: 0 })
  expect(calls).toEqual([
    {
      taskId: 'task-1',
      operation: 'git',
      value: {
        path: parseHostedWorkspaceReference(worktree).path,
        args: ['push', 'origin', 'aw/task-1'],
        options: { env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 60_000 },
      },
      options: { signal: controller.signal, timeoutMs: 60_000 },
    },
  ])
  await opened.session.close()
  await expect(opened.session.runNetwork(worktree, ['fetch'])).rejects.toThrow(
    'repository publication session is closed',
  )
})

test('a non-hosted repository path is refused instead of running local Git', async () => {
  const helper: WorkspaceHelper = {
    async call<T>(): Promise<T> {
      throw new Error('must not run')
    },
  }
  const opened = await createHostedRepositoryPublicationTransport({ helper }).open({
    subject: { kind: 'user', userId: 'user' } as never,
    remoteUrl: 'http://gitlab.local/group/repo.git',
  })
  if (!opened.ok) throw new Error('fixture')
  await expect(opened.session.runNetwork('/tmp/local/repo', ['push'])).rejects.toThrow()
})
