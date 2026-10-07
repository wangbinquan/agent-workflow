// RFC-370: actual SQLite/PG roots keep selected program writes and document reads coherent.
import { expect, test, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSelectedRequirementMaterializer } from '@/modules/development-automation/application/requirementMaterializer'
import { createRequirementBundleRefPersistence } from '@/modules/development-automation/infrastructure/requirementBundleRefPersistence'
import { composeSelectedRequirementSourceRunnerFor } from '@/modules/integration/composition/requirementSource'
import type {
  AdapterConfigurationReference,
  RequirementAdapterBinding,
} from '@/modules/integration/public/participants'
import { describeEachProvider } from './helpers/eachProvider'
import { createProviderHttpApplication } from './helpers/providerHttpApplication'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'
import {
  held,
  MemoryPurposeContent,
  PurposeEffects,
  unusedPurposeEffect,
} from './helpers/developmentPurpose'

setDefaultTimeout(60_000)

describeEachProvider('RFC-370 real purpose root content', (harness) => {
  test('external acquire writes readable content; rebuilt HTTP root preview uses the same selected program and awaits staging ACK', async () => {
    const fx = await buildPr3Fixture({
      db: harness.db,
      external: { mockUrl: 'http://unchosen.invalid' },
    })
    const appHome = mkdtempSync(join(tmpdir(), 'aw-selected-purpose-root-'))
    const content = new MemoryPurposeContent()
    const configuration: AdapterConfigurationReference = {
      kind: 'development-adapter-configuration',
      reference: {},
    }
    const effects = new PurposeEffects(content.namespace, {
      bind(received) {
        expect(received).toBe(configuration)
        return { ok: true, program: { kind: 'development-adapter-program', reference: {} } }
      },
    })
    effects.observeOperation = async (kind, input) => {
      expect(kind).toBe('acquire')
      await content
        .stage(input.staging)
        .writeText({ relativeName: 'body.md', text: 'Selected requirement 正文\n' })
      return {
        kind: 'completed',
        stdout: JSON.stringify({
          protocol: 'aw-adapter@1',
          operation: 'acquire',
          sourceRevision: 'selected-r1',
          title: 'Selected demand',
          files: [{ relativePath: 'body.md', role: 'body' }],
        }),
        exitCode: 0,
      }
    }
    let configurations = 0
    const binding: RequirementAdapterBinding = {
      effects,
      configurationFor(configured) {
        expect(this).toBe(requirement)
        expect(configured.purpose).toBe('requirement-source')
        expect(configured.operations).toContain('acquire')
        configurations++
        return configuration
      },
    }
    const requirement = {
      ...binding,
      staging: content.staging,
      documentCommands: content.documents,
    }
    const materializer = createSelectedRequirementMaterializer({
      store: fx.store,
      snapshots: fx.snapshots,
      bundleRefs: createRequirementBundleRefPersistence(harness.db),
      evidence: content.evidence,
      documentCommands: requirement.documentCommands,
      staging: requirement.staging,
      source: composeSelectedRequirementSourceRunnerFor(harness.db, requirement),
      now: () => Date.now(),
    })
    let application: Awaited<ReturnType<typeof createProviderHttpApplication>> | undefined
    let pending: Promise<Response> | undefined
    const entered = held<void>(),
      ack = held<void>()
    try {
      const missionId = await fx.launchExternal('selected-root', 'EXT-1')
      const mission = (await fx.store.getMission(missionId))!
      const acquired = await materializer.acquireExternal({
        missionId,
        adapterBindingRef: `${mission.resolvedAdapterId}@${mission.resolvedAdapterRevision}`,
        externalId: 'EXT-1',
      })
      expect(acquired).toMatchObject({ ok: true, sourceRevision: 'selected-r1', fileCount: 1 })
      const manifest = (await materializer.getRequirementManifest(missionId))!
      expect(manifest.files[0]!.relativePath).toBe('body.md')
      expect(await content.evidence.contents.readText(manifest.files[0]!.sha256)).toBe(
        'Selected requirement 正文\n',
      )
      const input = {
        appHome,
        token: 'tok',
        configPath: join(appHome, 'config.json'),
        dbVersion: 17,
        opencodeVersion: '1.14.25',
        evidenceArtifacts: content.evidence,
        developmentPurposes: { requirement },
        evidenceDocumentCommands: { writeDocument: unusedPurposeEffect },
      }
      application = await createProviderHttpApplication(harness, input)
      await application.dispose()
      application = await createProviderHttpApplication(harness, input)
      const headers = { Authorization: 'Bearer tok' },
        path = '/api/code/missions/' + missionId
      const read = await application.app.request(path + '/requirement-manifest', { headers })
      expect(read.status).toBe(200)
      expect(await read.json()).toEqual({ missionId, manifest })
      const file = await application.app.request(
        path + '/requirement-files/' + manifest.files[0]!.sha256,
        { headers },
      )
      expect(file.status).toBe(200)
      expect(await file.text()).toBe('Selected requirement 正文\n')
      // A synchronous HTTP operation on the reconstructed actual root invokes
      // its selected program, then cannot return before selected adoption ACK.
      content.before = (operation) => {
        if (operation === 'import') {
          entered.resolve()
          return ack.promise
        }
      }
      let settled = false
      pending = Promise.resolve(
        application.app.request(path + '/source-refresh/preview', { method: 'POST', headers }),
      ).then((response) => {
        settled = true
        return response
      })
      await Promise.race([
        entered.promise,
        pending.then((response) => {
          throw new Error('preview ended before adoption: ' + response.status)
        }),
      ])
      expect(settled).toBe(false)
      expect(configurations).toBe(2)
      expect(effects.calls.map((call) => call.kind)).toEqual(['acquire', 'acquire'])
      ack.resolve()
      const preview = await pending
      expect(preview.status).toBe(200)
      expect(await preview.json()).toMatchObject({
        missionId,
        newSourceRevision: 'selected-r1',
        fileCount: 1,
      })
      expect([...content.stages.values()].every((stage) => stage.closed)).toBe(true)
    } finally {
      ack.resolve()
      await pending
      await application?.dispose()
      rmSync(appHome, { recursive: true, force: true })
      rmSync(fx.stagingRoot, { recursive: true, force: true })
      rmSync(dirname(dirname(dirname(fx.evidence.blobPath('a'.repeat(64))))), {
        recursive: true,
        force: true,
      })
    }
  })
})
