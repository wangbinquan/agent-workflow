// RFC-395 II-pre：用户夹具改接生产 identity-access 运行时，保留原用例意图。
// Explicit product roles: observers read, owners/collaborators edit through the same Case boundary.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import {
  canonicalJson,
  GraphEvidenceBindingSchema,
  type GraphImplementationBasis,
} from '@agent-workflow/shared'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { graphDigest } from '@/modules/development-automation/domain/graph-development/model'
import { createUser } from './helpers/userFixture'
import { createGraphDesignStore } from '@/modules/development-automation/infrastructure/graph-development/designStore'
import { createGraphDesignArtifacts } from '@/modules/development-automation/infrastructure/graph-development/designArtifacts'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'
import { createSession } from './helpers/auth/sessionStore'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { bookingDesign } from './helpers/graphDesign'

describeEachProviderHttpApplication(
  'RFC-396 graph HTTP in the actual application graph',
  { token: 'd'.repeat(64), tempPrefix: 'rfc396-http-', dbVersion: 1, opencodeVersion: null },
  (scope) => {
    test('read, element deep link, independent presentation and revision-conflict behavior use the production routes', async () => {
      const f = await scope.open(),
        db = scope.harness.db
      const user = async (name: string) => {
        const value = await createUser(db, {
          username: name,
          displayName: name,
          role: 'user',
          password: 'longEnoughPassword',
        })
        return { id: value.id, token: (await createSession({ db, userId: value.id })).token }
      }
      const owner = await user('graph-owner'),
        observer = await user('graph-observer'),
        collaborator = await user('graph-collaborator')
      const { employeeCases, employeeCaseMembers } = tablesOf(db)
      await insertOne(db, employeeCases, {
        id: 'case-a',
        name: 'graph case',
        employeeId: 'employee',
        employeeRevision: 1,
        typeId: 'graph-development',
        typeRevision: 1,
        primaryContextId: 'context',
        executionPolicyRevision: 1,
        ownerUserId: owner.id,
        state: 'active',
        revision: 1,
        writerGeneration: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      await db.insert(employeeCaseMembers).values([
        { caseId: 'case-a', userId: observer.id, role: 'observer', addedBy: owner.id, addedAt: 1 },
        {
          caseId: 'case-a',
          userId: collaborator.id,
          role: 'collaborator',
          addedBy: owner.id,
          addedAt: 1,
        },
      ])
      const document = bookingDesign(),
        store = createGraphDesignStore(db),
        artifacts = createGraphDesignArtifacts(new EvidenceStore(f.appHome))
      const artifact = await artifacts.put([
        { path: 'design.json', content: canonicalJson(document) },
      ])
      await store.create(
        {
          id: document.id,
          caseId: document.caseId,
          revision: 1,
          presentationJson: '{}',
          presentationRevision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        { ...artifact, designId: document.id, revision: 1, requestId: 'seed', createdAt: 1 },
      )
      const request = (token: string, path: string, body?: unknown, method?: string) =>
        f.app.request(path, {
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      const missing = await request(owner.token, '/api/development-designs/does-not-exist')
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({ code: 'graph-design-not-found' })
      const invalid = await request(owner.token, '/api/development-designs/design-a/changes', {
        requestId: 'invalid',
        expectedRevision: 0,
      })
      // ValidationError uses the repository-wide 422 response contract.
      expect(invalid.status).toBe(422)
      expect(await invalid.json()).toMatchObject({ code: 'graph-request-invalid' })
      const view = await request(observer.token, '/api/development-designs/design-a/views/overview')
      const rawArtifact = await artifacts.put([
        { path: 'execution.json', content: '{"exitCode":3}' },
        { path: 'logs/0-output-tail.txt', content: 'actual failed command output' },
      ])
      await store.insertLink({
        designId: document.id,
        id: 'execution:raw',
        kind: 'evidence',
        createdAt: 1,
        payloadJson: canonicalJson(
          GraphEvidenceBindingSchema.parse({
            id: 'execution:raw',
            kind: 'execution',
            obligationIds: [],
            readSet: [],
            basisDigest: 'a'.repeat(64),
            candidateTreeOid: 'b'.repeat(40),
            commitSha: null,
            ci: null,
            profileRef: null,
            environmentDigest: null,
            executionRef: 'run',
            artifactRef: rawArtifact.artifactRef,
            artifactDigest: rawArtifact.digest,
            result: 'failed',
            summary: 'Failed',
            limitations: [],
            recordedAt: 1,
          }),
        ),
      })
      const raw = await request(
        observer.token,
        '/api/development-designs/design-a/evidence/execution%3Araw/artifacts?download=true',
      )
      expect(raw.status).toBe(200)
      expect(raw.headers.get('content-disposition')).toContain('graph-evidence.json')
      expect(((await raw.json()) as { files: unknown[] }).files).toContainEqual({
        path: 'logs/0-output-tail.txt',
        content: 'actual failed command output',
      })
      expect(view.status).toBe(200)
      expect(((await view.json()) as { elements: { id: string }[] }).elements[0]!.id).toBe(
        'booking',
      )
      const link = await request(
        observer.token,
        '/api/content-links/design-a?selection=%5B%22booking%22%5D&viewId=overview',
      )
      expect(link.status).toBe(200)
      expect(((await link.json()) as { href: string }).href).toContain('tab=design')
      const input = {
        requestId: 'edit',
        expectedRevision: 1,
        document: { ...document, title: 'Updated booking' },
      }
      expect(
        (await request(observer.token, '/api/development-designs/design-a/changes', input)).status,
      ).toBe(403)
      const edited = await request(
        collaborator.token,
        '/api/development-designs/design-a/changes',
        input,
      )
      expect(edited.status, await edited.clone().text()).toBe(200)
      expect(
        (
          await request(owner.token, '/api/development-designs/design-a/changes', {
            ...input,
            requestId: 'stale',
          })
        ).status,
      ).toBe(409)
      const layout = await request(
        owner.token,
        '/api/development-designs/design-a/presentation',
        {
          expectedRevision: 1,
          views: {
            overview: {
              viewId: 'overview',
              revision: 1,
              collapsedIds: [],
              positions: {},
              viewport: { x: 0, y: 0, zoom: 1.5 },
            },
          },
        },
        'PUT',
      )
      expect(layout.status, await layout.clone().text()).toBe(200)
      expect((await store.find('design-a'))?.revision).toBe(2)
      const old = await request(
        owner.token,
        '/api/development-designs/design-a/views/overview?revision=1',
      )
      expect(old.status).toBe(200)
      expect(((await old.json()) as { revision: number }).revision).toBe(1)
      const preview = await request(
        owner.token,
        '/api/development-designs/design-a/baseline-previews',
        { requestId: 'basis', expectedRevision: 2, includedElementIds: ['booking'] },
      )
      expect(preview.status, await preview.clone().text()).toBe(200)
      const basis = (await preview.json()) as { basis: GraphImplementationBasis }
      const exported = await request(
        observer.token,
        `/api/development-designs/design-a/bases/${encodeURIComponent(basis.basis.id)}/export`,
      )
      expect(exported.status).toBe(200)
      expect(
        ((await exported.json()) as { files: { path: string }[] }).files.some(
          (file: { path: string }) => file.path === 'manifest.json',
        ),
      ).toBe(true)

      // H5: the production route uses the proposal's implementation report and the request actor.
      const repo = join(f.appHome, 'h5-repository')
      mkdirSync(repo)
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(['git', ...args], { cwd: repo })
        if (result.exitCode) throw new Error(result.stderr.toString())
        return result.stdout.toString().trim()
      }
      git('init', '-q', '-b', 'main')
      writeFileSync(join(repo, 'README.md'), 'implemented candidate')
      git('add', 'README.md')
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=f@example.test',
        'commit',
        '-qm',
        'candidate',
      )
      const candidateTreeOid = git('rev-parse', 'HEAD^{tree}')
      const now = Date.now()
      const texts = ['Platform verification has not run yet.']
      for (const row of [
        {
          id: 'workspace',
          kind: 'workspace',
          status: 'ready',
          payload: {
            workspacePath: repo,
            baselineRepoPath: repo,
            targetBranch: 'main',
            remoteHeadSha: git('rev-parse', 'HEAD'),
            baseline: {
              kind: 'commit',
              commitSha: git('rev-parse', 'HEAD'),
              treeOid: candidateTreeOid,
            },
          },
        },
        {
          id: 'verification:h5-http',
          kind: 'verification',
          status: 'completed',
          payload: {
            basisId: basis.basis.id,
            basisDigest: basis.basis.digest,
            implementationRoundRef: 'http-build',
            candidate: { treeOid: candidateTreeOid },
          },
        },
      ])
        await store.insertRecord({
          designId: document.id,
          id: row.id,
          kind: row.kind,
          requestDigest: graphDigest(row),
          status: row.status,
          version: 1,
          payloadJson: canonicalJson(row.payload),
          createdAt: now,
          updatedAt: now,
        })
      await store.insertLink({
        designId: document.id,
        id: 'implementation:http-build',
        kind: 'execution',
        createdAt: now,
        payloadJson: canonicalJson({
          basisId: basis.basis.id,
          basisDigest: basis.basis.digest,
          roundRef: 'http-build',
          result: {
            traceProposals: [],
            testRefs: [],
            limitations: texts,
            deliveryContent: { commitMessage: 'booking', title: 'booking', description: '' },
          },
        }),
      })
      const proposalId = 'code-feedback:http-build'
      const proposalArtifact = await artifacts.put([
        {
          path: 'proposal.json',
          content: canonicalJson({
            schemaVersion: 1,
            id: proposalId,
            requestId: proposalId,
            designId: document.id,
            kind: 'code-feedback',
            status: 'proposed',
            readSet: basis.basis.readSet,
            invocationRef: 'http-build',
            document: basis.basis.document,
            plan: null,
            explanation: 'Implementation limitation report',
            createdAt: now,
          }),
        },
      ])
      await store.insertRecord({
        designId: document.id,
        id: `proposal:${proposalId}`,
        kind: 'proposal',
        requestDigest: graphDigest(proposalArtifact),
        status: 'proposed',
        version: 1,
        payloadJson: canonicalJson(proposalArtifact),
        createdAt: now,
        updatedAt: now,
      })
      const endpoint = `/api/development-designs/design-a/proposals/${encodeURIComponent(proposalId)}/limitation-review`
      const reviewBody = {
        requestId: 'http-judgment',
        comment: 'Verification is a separate platform step, not missing implementation.',
      }
      expect((await request(observer.token, endpoint, reviewBody)).status).toBe(403)
      const empty = await request(collaborator.token, endpoint, { ...reviewBody, comment: '  ' })
      expect(empty.status).toBe(422)
      expect(await empty.json()).toMatchObject({ code: 'graph-request-invalid' })
      const judgment = await request(collaborator.token, endpoint, reviewBody)
      expect(judgment.status, await judgment.clone().text()).toBe(200)
      const evidence = GraphEvidenceBindingSchema.parse(await judgment.json())
      expect(evidence).toMatchObject({
        kind: 'limitation-review',
        limitations: texts,
        executionRef: 'http-build',
        candidateTreeOid: null,
      })
      const rawJudgment = await artifacts.read(
        { artifactRef: evidence.artifactRef!, digest: evidence.artifactDigest! },
        'limitation-review.json',
      )
      expect(JSON.parse(rawJudgment!)).toMatchObject({
        actorUserId: collaborator.id,
        candidateTreeOid,
        ...reviewBody,
      })
      expect(await (await request(collaborator.token, endpoint, reviewBody)).json()).toEqual(
        evidence,
      )
      const conflict = await request(collaborator.token, endpoint, {
        ...reviewBody,
        comment: 'Changed reason',
      })
      expect(conflict.status).toBe(409)
      expect(await conflict.json()).toMatchObject({
        code: 'graph-request-reused-with-different-input',
      })
      const rejected = await request(
        owner.token,
        `/api/development-designs/design-a/proposals/${encodeURIComponent(proposalId)}/apply`,
        { requestId: 'apply-judged' },
      )
      expect(rejected.status).toBe(409)
      expect(await rejected.json()).toMatchObject({ code: 'graph-proposal-already-decided' })
    }, 30_000)
  },
)
