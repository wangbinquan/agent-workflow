import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { objectFixture } from './helpers/rfc370Objects'
import { parseHostedObjectReference } from '@/platform/crewstation/objectReference'
import { composeCrewStationEmployeeContent } from '@/modules/digital-employee/composition/crewstationContent'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import {
  writeHostedWorkspaceStream,
  HOSTED_UPLOAD_CHUNK_BYTES,
} from '@/modules/source-control/infrastructure/crewstation/workspaceUploads'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { describeEachProvider } from './helpers/eachProvider'
import { createHostedObjectPublications } from '@/modules/system-operations/infrastructure/crewstation/objectPublications'

describeEachProvider('RFC-370 hosted employee object content', (harness) => {
  test('stream objects verify full bodies and exact ranges, and employee metadata retains durable owner refs', async () => {
    const f = objectFixture()
    // RFC-370 v3 V6: employee content publishes through the neutral journal.
    const publications = createHostedObjectPublications({
      db: harness.db,
      objects: f.objects,
      fence: {
        current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'owner' }),
        assertHeld: async () => {},
      },
    }).publications
    const root = mkdtempSync(join(tmpdir(), 'aw-hosted-object-content-'))
    try {
      const writes: { target: string; bytes: Uint8Array }[] = []
      const content = composeCrewStationEmployeeContent({
        publications,
        objects: f.objects,
        writeWorkspace: async (target, stream, facts) => {
          const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
          expect(bytes.byteLength).toBe(facts.size)
          writes.push({ target, bytes })
        },
      })
      const request = {
        runtimeKind: 'node' as const,
        source: 'console.log("hello")',
        parameterValues: { answer: 42, enabled: true },
      }
      const revision = await content.employeePrograms.put(request)
      expect(f.pins).toHaveLength(2)
      // Identical content is content addressed: a second put reuses both pins.
      await content.employeePrograms.put(request)
      expect(f.pins).toHaveLength(2)
      expect(
        await composeCrewStationEmployeeContent({
          publications,
          objects: f.objects,
          writeWorkspace: async () => {},
        }).employeePrograms.read({ ...revision, runtimeKind: 'node' }),
      ).toEqual({ source: request.source, parameterValues: request.parameterValues })
      expect(await content.employeePrograms.read({ ...revision, runtimeKind: 'python' })).toBeNull()
      expect(
        await content.employeePrograms.read({
          ...revision,
          executableDigest: '0'.repeat(64),
          runtimeKind: 'node',
        }),
      ).toBeNull()
      const path = join(root, 'input.bin')
      const bytes = Buffer.from(Array.from({ length: 257_003 }, (_, index) => index % 251))
      writeFileSync(path, bytes)
      const receipt = await content.employeeInputArtifacts.putFile(path)
      rmSync(path)
      expect(await content.employeeInputArtifacts.hasBlob(receipt.blobRef)).toBe(true)
      expect(await content.employeeInputArtifacts.hasBlob(revision.executableArtifactRef)).toBe(
        false,
      )
      await content.employeeInputArtifacts.copyBlobTo(
        receipt.blobRef,
        'cs-workspace:case/inputs/input.bin',
      )
      expect(Buffer.from(writes[0]!.bytes).equals(bytes)).toBe(true)
      const object = parseHostedObjectReference('employee-input', receipt.blobRef)
      const range = new Uint8Array(
        await new Response(await f.objects.open(object, { start: 17, end: 1025 })).arrayBuffer(),
      )
      expect(Buffer.from(range).equals(bytes.subarray(17, 1026))).toBe(true)
      f.tamper('range')
      await expect(f.objects.open(object, { start: 17, end: 1025 })).rejects.toThrow(
        'receipt-mismatch',
      )
      f.tamper('body')
      await expect(
        content.employeeInputArtifacts.copyBlobTo(
          receipt.blobRef,
          'cs-workspace:case/inputs/input.bin',
        ),
      ).rejects.toThrow('content-mismatch')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test('object-to-workspace streaming bounds commands and rejects truncated input before atomic replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-hosted-stream-volume-'))
  const calls: string[] = []
  const helper: WorkspaceHelper = {
    async call<T>(taskId: string, operation: string, value: unknown): Promise<T> {
      expect(taskId).toBe('task')
      calls.push(operation)
      const request = value as { workspace: string; file: string; contentBase64?: string }
      if (request.contentBase64)
        expect(Buffer.from(request.contentBase64, 'base64').byteLength).toBeLessThanOrEqual(
          HOSTED_UPLOAD_CHUNK_BYTES,
        )
      return (await executeWorkspaceTaskImageOperation(
        operation,
        { ...request, workspace: root, file: join(root, 'input.bin') },
        undefined,
        root,
      )) as T
    },
  }
  const bytes = Buffer.alloc(HOSTED_UPLOAD_CHUNK_BYTES + 10, 72)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const stream = (size: number) => {
    let offset = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= size) {
          controller.close()
          return
        }
        const end = Math.min(offset + 17_003, size)
        controller.enqueue(bytes.subarray(offset, end))
        offset = end
      },
    })
  }
  const request = {
    workspaceRef: 'cs-workspace:task/',
    fileRef: 'cs-workspace:task/input.bin',
    sha256,
    size: bytes.length,
    replace: true,
  }
  try {
    writeFileSync(join(root, 'input.bin'), 'original')
    await expect(
      writeHostedWorkspaceStream(helper, { ...request, stream: stream(bytes.length - 1) }),
    ).rejects.toThrow('content-mismatch')
    expect(readFileSync(join(root, 'input.bin'), 'utf8')).toBe('original')
    expect(calls).toContain('upload-abort')
    await writeHostedWorkspaceStream(helper, { ...request, stream: stream(bytes.length) })
    expect(readFileSync(join(root, 'input.bin')).equals(bytes)).toBe(true)
    expect(calls.at(-1)).toBe('upload-commit')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
