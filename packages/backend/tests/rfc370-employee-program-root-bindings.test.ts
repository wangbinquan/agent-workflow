// RFC-370 A2: real HTTP put/read must use the bootstrap-selected program store.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProgramArtifactPort } from '@/modules/digital-employee/composition/required-ports'
import { createDigitalEmployeeAuthoringPersistence } from '@/modules/digital-employee/infrastructure/authoringStore'
import { sha256Hex } from '@/util/hash'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

describeEachProviderHttpApplication(
  'RFC-370 true employee program root binding',
  {
    token: 'd'.repeat(64),
    dbVersion: 17,
    opencodeVersion: null,
    tempPrefix: 'aw-rfc370-program-root-',
  },
  (scope) => {
    const headers = {
      Authorization: `Bearer ${'d'.repeat(64)}`,
      'content-type': 'application/json',
    }
    const path = '/api/digital-employee-types/development@10/work-items/prepare-materials/tools'
    for (const outcome of ['content', 'missing', 'failure'] as const) {
      test(`HTTP waits for selected put/read ACK and preserves the ${outcome} result`, async () => {
        const source = 'print("selected remote program")\n'
        const parameterValues = { enabled: false, retries: 0, mode: 'selected' }
        const putEntered = Promise.withResolvers<void>(),
          putReady = Promise.withResolvers<void>()
        const readEntered = Promise.withResolvers<void>(),
          readReady = Promise.withResolvers<void>()
        let puts = 0,
          reads = 0
        const selected: ProgramArtifactPort = {
          async put(input) {
            expect(this).toBe(selected)
            puts += 1
            expect(input).toEqual({ runtimeKind: 'python', source, parameterValues })
            putEntered.resolve()
            await putReady.promise
            return {
              executableArtifactRef: 'object:program/source',
              executableDigest: sha256Hex(source),
              parameterValuesRef: 'object:program/parameters',
            }
          },
          async read(input) {
            expect(this).toBe(selected)
            reads += 1
            const expectedRead = {
              kind: 'program',
              runtimeKind: 'python',
              executableArtifactRef: 'object:program/source',
              executableDigest: sha256Hex(source),
              parameterValuesRef: 'object:program/parameters',
              runtimeProfileRef: { id: 'builtin:script-runtime', revision: 1 },
            } as const
            expect(input).toEqual(expectedRead)
            readEntered.resolve()
            await readReady.promise
            if (outcome === 'failure') throw new Error('selected program read failed')
            return outcome === 'missing' ? null : { source, parameterValues }
          },
        }
        const { app, appHome } = await scope.open({ employeePrograms: selected })
        let created = false,
          readSettled = false
        const pending = Promise.resolve(
          app.request(path, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              displayName: 'Selected program',
              description: 'Selected exact bytes',
              roleRef: 'primary',
              implementation: {
                kind: 'program',
                runtimeKind: 'python',
                source,
                parameterValues,
                runtimeProfileRef: { id: 'builtin:script-runtime', revision: 1 },
              },
            }),
          }),
        ).finally(() => {
          created = true
        })
        let reading: Promise<Response> | undefined
        try {
          await Promise.race([
            putEntered.promise,
            pending.then(async (response) => {
              throw new Error(
                `selected put ACK missed: ${response.status} ${await response.clone().text()}`,
              )
            }),
          ])
          expect(created).toBe(false)
          expect(puts).toBe(1)
          putReady.resolve()
          const response = await pending
          expect(response.status).toBe(201)
          const tool = (await response.json()) as { id: string }
          const store = createDigitalEmployeeAuthoringPersistence(scope.harness.db)
          const before = await store.getTool(tool.id)
          reading = Promise.resolve(app.request(`${path}/${tool.id}`, { headers })).finally(() => {
            readSettled = true
          })
          await Promise.race([
            readEntered.promise,
            reading.then(async (response) => {
              throw new Error(
                `selected read ACK missed: ${response.status} ${await response.clone().text()}`,
              )
            }),
          ])
          expect(readSettled).toBe(false)
          expect(await store.getTool(tool.id)).toEqual(before)
          readReady.resolve()
          const read = await reading
          if (outcome === 'content') {
            expect(read.status).toBe(200)
            expect(await read.json()).toMatchObject({
              body: {
                implementation: {
                  kind: 'program',
                  runtimeKind: 'python',
                  source,
                  parameterValues,
                },
              },
            })
          } else {
            expect(read.status).toBe(outcome === 'missing' ? 409 : 500)
            if (outcome === 'missing')
              expect(await read.text()).toContain('employee-program-artifact-unavailable')
          }
          expect(await store.getTool(tool.id)).toEqual(before)
          expect(puts).toBe(1)
          expect(reads).toBe(1)
          expect(existsSync(join(appHome, 'digital-employee', 'program-tools'))).toBe(false)
        } finally {
          putReady.resolve()
          readReady.resolve()
          await pending
          await reading
        }
      }, 20_000)
    }
  },
)
