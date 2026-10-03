import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PackageImportReceiptSchema, PackagePreviewSchema } from '@agent-workflow/shared'

import { plugins, resourceBundleApplies, skills, skillVersions } from '@/db/schema'
import type {
  ResourcePackageSkillArtifactOwner,
  ResourcePackagePluginArtifactOwner,
  SkillPackageContentReader,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { sha256Hex } from '@/util/hash'
import { encodeZip } from '@/util/zip'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

type ArtifactContext = Parameters<ResourcePackageSkillArtifactOwner['planCreate']>[0]
type Artifact =
  | ReturnType<ResourcePackageSkillArtifactOwner['planCreate']>['artifact']
  | ReturnType<ResourcePackagePluginArtifactOwner['planInstall']>['artifact']
type Receipt = Parameters<ResourcePackageSkillArtifactOwner['afterCommitted']>[1]
const token = 'c'.repeat(64)
const utf8 = (text: string) => new TextEncoder().encode(text)
const binary = new Uint8Array([0, 255, 128, 10])
const bodyMd = '# Selected root\n'
const contentHash = sha256Hex(binary)

function packageBytes(kind: 'skill' | 'plugin') {
  const slug = `${kind}-selected-root`
  return encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: ${slug}
  type: ${kind}
  name: selected-root
resources:
  - slug: ${slug}
    type: ${kind}
    name: selected-root
${kind === 'skill' ? 'requirements: {}' : 'requirements:\n  pluginSources:\n    - name: selected-root\n      spec: selected-root-fixture@1.0.0\n      sourceKind: npm'}
secrets: []
danglingCallRefs: []
`),
    },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'selected-root-create',
              kind: `${kind}-create`,
              slug,
              payload:
                kind === 'skill'
                  ? {
                      name: 'selected-root',
                      description: '',
                      frontmatterExtra: {},
                      bodyMd,
                      files: [{ path: 'binary.bin', ref: `skills/${slug}/files/binary.bin` }],
                    }
                  : {
                      name: 'selected-root',
                      description: '',
                      options: {},
                      enabled: true,
                      spec: 'selected-root-fixture@1.0.0',
                      sourceKind: 'npm',
                    },
            },
          ],
          rootRef: `local:${slug}`,
        }),
      ),
    },
    ...(kind === 'skill' ? [{ path: `skills/${slug}/files/binary.bin`, bytes: binary }] : []),
  ])
}

class SelectedPackageArtifacts
  implements
    ResourcePackageSkillArtifactOwner,
    ResourcePackagePluginArtifactOwner,
    SkillPackageContentReader
{
  readonly #failure: boolean
  readonly #beforeStage: (artifact: Artifact) => Promise<void>
  readonly entered = Promise.withResolvers<void>()
  readonly release = Promise.withResolvers<void>()
  readonly exportEntered = Promise.withResolvers<void>()
  readonly exportRelease = Promise.withResolvers<void>()
  readonly calls: string[] = []
  readonly references: Parameters<SkillPackageContentReader['readTree']>[0][] = []

  constructor(failure: boolean, beforeStage: (artifact: Artifact) => Promise<void>) {
    this.#failure = failure
    this.#beforeStage = beforeStage
    Object.freeze(this)
  }

  async #stage(artifact: Artifact) {
    await this.#beforeStage(artifact)
    this.calls.push(`stage:${artifact.kind}`)
    this.entered.resolve()
    await this.release.promise
    if (this.#failure) throw new Error('selected-package-stage-failure')
  }

  #stageSkill(
    context: ArtifactContext,
    artifact: ReturnType<ResourcePackageSkillArtifactOwner['planCreate']>['artifact'],
  ) {
    return {
      artifact,
      stage: async () => {
        expect(context.readSkillFile?.('skills/skill-selected-root/files/binary.bin')).toEqual(
          binary,
        )
        await this.#stage(artifact)
        return {
          managedPath: 'logical:skill-live',
          filesPath: 'logical:skill-version',
          contentHash,
        }
      },
    }
  }

  planCreate(
    context: ArtifactContext,
    request: Parameters<ResourcePackageSkillArtifactOwner['planCreate']>[1],
  ): ReturnType<ResourcePackageSkillArtifactOwner['planCreate']> {
    return this.#stageSkill(context, {
      kind: 'skill-stage',
      operationId: request.mutation.opId,
      skillId: request.skillId,
      stagingDirectory: 'logical:skill-stage',
      targetDirectory: 'logical:skill-live',
    })
  }

  planUpdate(
    context: ArtifactContext,
    request: Parameters<ResourcePackageSkillArtifactOwner['planUpdate']>[1],
  ): ReturnType<ResourcePackageSkillArtifactOwner['planUpdate']> {
    return this.#stageSkill(context, {
      kind: 'skill-version-stage',
      operationId: request.mutation.opId,
      skillId: request.skillId,
      publishId: request.publishId,
      version: request.version,
      stagingDirectory: 'logical:skill-stage',
      versionDirectory: 'logical:skill-version',
    })
  }

  planInstall(
    _context: ArtifactContext,
    request: Parameters<ResourcePackagePluginArtifactOwner['planInstall']>[1],
  ): ReturnType<ResourcePackagePluginArtifactOwner['planInstall']> {
    const artifact = {
      kind: 'plugin-install' as const,
      operationId: request.mutation.opId,
      pluginId: request.pluginId,
      generationId: request.generationId,
      generationDirectory: 'logical:plugin-generation',
    }
    return {
      artifact,
      install: async () => {
        await this.#stage(artifact)
        return { sourceKind: 'npm', cachedPath: 'logical:plugin-content', resolvedVersion: '1.0.0' }
      },
    }
  }

  async compensate(
    _context: ArtifactContext,
    input: { readonly artifact: Artifact; readonly databaseCommitted: boolean },
  ) {
    this.calls.push(`compensate:${input.artifact.kind}:${input.databaseCommitted}`)
  }

  async rollForward(
    _context: ArtifactContext,
    input: { readonly artifact: Artifact; readonly receipt: Receipt },
  ) {
    this.calls.push(`roll-forward:${input.artifact.kind}`)
  }

  async afterCommitted(_context: ArtifactContext, _receipt: Receipt) {
    this.calls.push('after-committed')
  }

  async readTree(reference: Parameters<SkillPackageContentReader['readTree']>[0]) {
    this.references.push(reference)
    this.exportEntered.resolve()
    await this.exportRelease.promise
    return [
      {
        path: 'SKILL.md',
        bytes: utf8(`---\nname: selected-root\ndescription: ''\n---\n\n${bodyMd}`),
      },
      { path: 'files/binary.bin', bytes: binary },
    ]
  }
}

function upload(zip: Uint8Array) {
  const form = new FormData()
  form.set('file', new Blob([Buffer.from(zip)]), 'selected-root.awpkg.zip')
  return form
}

describeEachProviderHttpApplication(
  'RFC-370 selected resource package artifacts at actual HTTP roots',
  { token, dbVersion: 17, opencodeVersion: null, tempPrefix: 'rfc370-package-root-' },
  (scope) => {
    for (const kind of ['skill', 'plugin'] as const) {
      for (const failure of [false, true]) {
        test(`${kind} multipart apply uses the complete selected prototype owner for ${failure ? 'failure' : 'success'}`, async () => {
          const selected = new SelectedPackageArtifacts(failure, async (artifact) => {
            const rows = await scope.harness.db.select().from(resourceBundleApplies)
            expect(rows).toHaveLength(1)
            expect(rows[0]!.state).toBe('prepared')
            expect(JSON.parse(rows[0]!.preparedArtifactsJson!)).toEqual([artifact])
          })
          expect(Object.hasOwn(selected, 'planInstall')).toBe(false)
          const { app, appHome } = await scope.open({
            resourcePackageSkillArtifacts: selected,
            resourcePackagePluginArtifacts: selected,
            resourcePackageSkillContent: selected,
          })
          const beforeSkills = await scope.harness.db.select().from(skills)
          const beforePlugins = await scope.harness.db.select().from(plugins)
          const zip = packageBytes(kind)
          const previewResponse = await app.request('/api/resource-packages/preview', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: upload(zip),
          })
          expect(previewResponse.status).toBe(200)
          const preview = PackagePreviewSchema.parse(await previewResponse.json())
          const form = upload(zip)
          form.set('previewToken', preview.previewToken)
          form.set(
            'decisions',
            JSON.stringify([{ localSlug: `${kind}-selected-root`, action: 'new' }]),
          )
          let settled = false
          const pending = Promise.resolve(
            app.request('/api/resource-packages/commit', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
              body: form,
            }),
          ).then((response) => {
            settled = true
            return response
          })
          await selected.entered.promise
          expect(settled).toBe(false)
          expect(await scope.harness.db.select().from(skills)).toEqual(beforeSkills)
          expect(await scope.harness.db.select().from(plugins)).toEqual(beforePlugins)
          selected.release.resolve()
          const response = await pending
          if (failure) {
            expect(response.status).toBeGreaterThanOrEqual(400)
            expect(selected.calls).toContain(
              `compensate:${kind === 'skill' ? 'skill-stage' : 'plugin-install'}:false`,
            )
            expect(await scope.harness.db.select().from(skills)).toEqual(beforeSkills)
            expect(await scope.harness.db.select().from(plugins)).toEqual(beforePlugins)
          } else {
            expect(response.status).toBe(200)
            const receipt = PackageImportReceiptSchema.parse(await response.json())
            expect(receipt.root).toBeDefined()
            expect(selected.calls).toContain('after-committed')
            if (kind === 'plugin') {
              const row = (await scope.harness.db.select().from(plugins)).find(
                (item) => item.id === receipt.root!.resourceId,
              )
              expect(row).toMatchObject({
                cachedPath: 'logical:plugin-content',
                resolvedVersion: '1.0.0',
              })
            } else {
              const row = (await scope.harness.db.select().from(skills)).find(
                (item) => item.id === receipt.root!.resourceId,
              )
              expect(row).toMatchObject({ managedPath: 'logical:skill-live', contentHash })
              expect(
                (await scope.harness.db.select().from(skillVersions)).find(
                  (item) => item.skillId === row!.id,
                ),
              ).toMatchObject({ filesPath: 'logical:skill-version' })
              let exported = false
              const exporting = Promise.resolve(
                app.request(`/api/skills/${row!.id}/export-package`, {
                  headers: { Authorization: `Bearer ${token}` },
                }),
              ).then((result) => {
                exported = true
                return result
              })
              await selected.exportEntered.promise
              expect(exported).toBe(false)
              expect(selected.references).toEqual([
                { id: row!.id, name: 'selected-root', contentVersion: 1 },
              ])
              selected.exportRelease.resolve()
              const exportResponse = await exporting
              expect(exportResponse.status).toBe(200)
              const parsed = await parseResourcePackage(
                new Uint8Array(await exportResponse.arrayBuffer()),
              )
              const files = [...parsed.files.entries()].filter(([path]) =>
                path.endsWith('/files/binary.bin'),
              )
              expect(files).toHaveLength(1)
              expect(files[0]![1]).toEqual(binary)
            }
          }
          expect(existsSync(join(appHome, 'plugins'))).toBe(false)
          expect(existsSync(join(appHome, 'skills', 'selected-root'))).toBe(false)
        }, 35_000)
      }
    }
  },
)
