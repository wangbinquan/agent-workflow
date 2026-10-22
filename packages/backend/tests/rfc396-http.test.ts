// Explicit product roles: observers read, owners/collaborators edit through the same Case boundary.
import { expect, test } from 'bun:test'
import { canonicalJson, GraphEvidenceBindingSchema } from '@agent-workflow/shared'
import { employeeCases, employeeCaseMembers } from '@/db/schema'
import { createUser } from '@/services/users'
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
      await db.insert(employeeCases).values({
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
      const basis = (await preview.json()) as { basis: { id: string } }
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
    }, 30_000)
  },
)
