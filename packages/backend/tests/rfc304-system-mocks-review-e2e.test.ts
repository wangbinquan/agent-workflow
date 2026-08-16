// RFC-304 system-mock acceptance — the real review runner talks to the shared
// stateful GitLab/GitHub suite. Unlike the fetch-stub contract test, this keeps
// provider routing, auth, response shapes, read-back and Git state outside the
// product process, which is the boundary deployed E2E actually crosses.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  startSystemMockSuite,
  type MockCodeHostProject,
  type StartedSystemMockSuite,
} from '@agent-workflow/system-mocks'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createCodeCapabilityRunner } from '../src/modules/code-capability/composition/codeCapabilityRunner'
import {
  mrReviewAiStages,
  mrReviewProgramStages,
  type MrReviewEnvironment,
} from '../src/modules/code-capability/composition/mrReviewStages'
import { createCodeHostAdapter } from '../src/modules/code-capability/infrastructure/codeHostAdapter'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'
import type { CodeHostConnectionsService } from '../src/services/codeHost/connections'
import { createGitPortFake } from './helpers/gitPortFake'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NONCE = 'systemmocknonce'
const FINDING_MARKER = 'aw-finding:'

let suite: StartedSystemMockSuite

beforeAll(async () => {
  suite = await startSystemMockSuite()
})

beforeEach(async () => {
  await suite.client.reset()
})

afterAll(async () => {
  await suite.close()
})

for (const provider of ['gitlab', 'github'] as const) {
  describe(`RFC-304 review through the ${provider} system mock`, () => {
    let db: DbClient
    let worktree: string

    beforeEach(() => {
      db = createInMemoryDb(MIGRATIONS)
      worktree = mkdtempSync(join(tmpdir(), `aw-rfc304-system-mock-${provider}-`))
    })

    afterEach(() => {
      db.$client.close()
      rmSync(worktree, { recursive: true, force: true })
    })

    test('runs the eight-stage review and reconciles the visible remote comments', async () => {
      const project = await suite.client.seedCodeHost({
        provider,
        projectPath: `rfc304/${provider}-review`,
        title: 'Use the shared mock suite',
        baseFiles: { 'src/a.ts': 'export function value() {\n  return 1\n}\n' },
        headFiles: { 'src/a.ts': 'export function value() {\n  return 2\n}\n' },
      })
      const environment = reviewEnvironment(provider, project, db, worktree)
      const result = await createCodeCapabilityRunner({
        db,
        programStages: mrReviewProgramStages(environment),
        aiStages: mrReviewAiStages(environment),
      }).runRound({
        roundId: ulid(),
        capability: 'mr-review',
        roundSeq: 1,
        worktreePath: worktree,
        repos: [{ name: 'main', path: worktree }],
        envelopeNonce: NONCE,
        resumeFromStage: null,
      })

      expect(result.outcome).toBe('done')
      const snapshot = await suite.client.snapshot()
      const remote = snapshot.codeHosts[0]!
      expect(remote.mergeRequests[0]?.reviewComments).toHaveLength(1)
      expect(remote.mergeRequests[0]?.reviewComments[0]).toMatchObject({
        position: expect.any(Object),
      })
      expect(remote.mergeRequests[0]?.reviewComments[0]?.body).toContain(FINDING_MARKER)
      if (provider === 'gitlab') {
        expect(remote.mergeRequests[0]?.drafts).toHaveLength(0)
        expect(remote.mergeRequests[0]?.reviewComments[0]?.threadId).toStartWith('discussion-')
        expect(remote.mergeRequests[0]?.issueComments[0]?.body).toContain('aw-review-overview')
      }

      const requests = await suite.client.requests(provider)
      const paths = requests.map((request) => `${request.method} ${request.path}`)
      if (provider === 'gitlab') {
        expect(paths).toContain(`GET /gitlab/api/v4/projects/${project.projectId}/merge_requests/1`)
        expect(paths).toContain(
          `POST /gitlab/api/v4/projects/${project.projectId}/merge_requests/1/draft_notes`,
        )
        expect(paths).toContain(
          `POST /gitlab/api/v4/projects/${project.projectId}/merge_requests/1/draft_notes/bulk_publish`,
        )
      } else {
        expect(paths).toContain(`GET /github/api/v3/repos/${project.projectPath}/pulls/1/files`)
        expect(paths).toContain(`POST /github/api/v3/repos/${project.projectPath}/pulls/1/reviews`)
        const reviewRequest = requests.find((request) => request.path.endsWith('/reviews'))
        expect(JSON.parse(reviewRequest!.bodyText)).toMatchObject({
          event: 'COMMENT',
          commit_id: project.headSha,
          comments: [{ path: 'src/a.ts', line: 2, side: 'RIGHT' }],
        })
      }
    })
  })
}

function reviewEnvironment(
  provider: 'gitlab' | 'github',
  project: MockCodeHostProject,
  db: DbClient,
  worktree: string,
): MrReviewEnvironment {
  const connections = {
    resolve: () => ({
      provider,
      baseUrl:
        provider === 'gitlab' ? suite.endpoints.gitlabApiBaseUrl : suite.endpoints.githubApiBaseUrl,
      repositoryUrlPrefixes: [],
      token: SYSTEM_MOCK_CODE_HOST_TOKEN,
      rejectUnauthorized: true,
    }),
  } as unknown as CodeHostConnectionsService
  const git: GitPort = createGitPortFake({ resolvedSha: project.headSha })
  const envelope = `<workflow-output nonce="${NONCE}"><port name="findings">${JSON.stringify({
    findings: [
      {
        file: 'src/a.ts',
        line: 2,
        severity: 'major',
        title: 'hard-coded result',
        body: 'The result should come from the caller.',
      },
    ],
  })}</port></workflow-output>`

  return {
    codeHost: createCodeHostAdapter({ db, provider, connections }),
    git,
    webhook: {
      event_type: 'mr_opened',
      provider,
      project_id: project.projectId,
      mr_iid: String(project.number),
      commit_sha: project.headSha,
      repo_path: project.projectPath,
      mr_title: project.title,
    },
    codeHostEndpointId: `system-mock-${provider}`,
    repoPath: worktree,
    worktreePath: worktree,
    makeCaller: () => async () => ({ stdout: envelope, sessionId: 'system-mock-session' }),
    protocolBlock: '',
    nonce: NONCE,
    budget: { sameSession: 1, freshSession: 0 },
    gate: { threshold: 'info', maxPerRound: 20 },
  }
}
