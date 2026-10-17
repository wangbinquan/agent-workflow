import { canonicalJson } from '@agent-workflow/shared'
import { createReadStream, lstatSync } from 'node:fs'
import { z } from 'zod'
import type { HostedObjectPublications } from '@/modules/system-operations/public/participants'
import type {
  CrewStationStreamObjectStorage,
  HostedObjectStream,
  HostedStoredObject,
} from '@/platform/crewstation/objectStorage'
import {
  hostedObjectReference,
  parseHostedObjectReference,
} from '@/platform/crewstation/objectReference'
import { CrewStationApiError } from '@/platform/crewstation/platformApi'
import type { EmployeeInputArtifactPort, ProgramArtifactPort } from './required-ports'
import { createSha256DigestBuilder, sha256Hex } from '@/util/hash'

const parameters = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
const digest = (value: string) => sha256Hex(value)
/** Publication owner of employee program/parameter/input blobs. Employee blobs
 * are content addressed and shared by revisions and cases; the native retention
 * policy keeps them, so these publications are never released. */
export const EMPLOYEE_CONTENT_OWNER = 'employee-content'

/** Existing program revisions and upload rows retain the immutable object refs;
 * no service-local file or shared cross-domain metadata registry is introduced. */
export function composeCrewStationEmployeeContent(input: {
  readonly publications: Pick<HostedObjectPublications, 'publish'>
  readonly objects: CrewStationStreamObjectStorage
  readonly writeWorkspace: (
    reference: string,
    stream: ReadableStream<Uint8Array>,
    facts: { readonly sha256: string; readonly size: number },
  ) => Promise<void>
}) {
  const publish = async (
    owner: string,
    content: HostedObjectStream,
  ): Promise<HostedStoredObject> => {
    const [object] = await input.publications.publish([
      { owner: EMPLOYEE_CONTENT_OWNER, key: `${owner}/${content.sha256}`, content },
    ])
    return object!
  }
  const writeText = async (owner: string, text: string) => {
    const bytes = Buffer.from(text)
    const sha256 = digest(text)
    const object = await publish(owner, {
      sha256,
      size: bytes.byteLength,
      open: () => new Blob([bytes]).stream(),
    })
    return hostedObjectReference(owner, object)
  }
  const readText = async (owner: string, reference: string) => {
    const object = parseHostedObjectReference(owner, reference)
    return new Response(await input.objects.open(object)).text()
  }
  const programs: ProgramArtifactPort = {
    async put(request) {
      const executableArtifactRef = await writeText(
        `employee-program-${request.runtimeKind}`,
        request.source,
      )
      const parameterValuesRef =
        request.parameterValues !== null && Object.keys(request.parameterValues).length > 0
          ? await writeText(
              'employee-program-params',
              canonicalJson(request.parameterValues) + '\n',
            )
          : null
      return { executableArtifactRef, executableDigest: digest(request.source), parameterValuesRef }
    },
    async read(request) {
      try {
        const source = await readText(
          `employee-program-${request.runtimeKind}`,
          request.executableArtifactRef,
        )
        if (digest(source) !== request.executableDigest) return null
        if (request.parameterValuesRef === null) return { source, parameterValues: null }
        const parsed = parameters.safeParse(
          JSON.parse(await readText('employee-program-params', request.parameterValuesRef)),
        )
        return parsed.success ? { source, parameterValues: parsed.data } : null
      } catch (error) {
        if (error instanceof CrewStationApiError && error.status !== 404) throw error
        return null
      }
    },
  }
  const uploads: EmployeeInputArtifactPort = {
    async putFile(path) {
      // The HTTP owner supplies an ephemeral upload file. Only its verified
      // object receipt is published; the service filesystem retains no state.
      const stat = lstatSync(path)
      if (!stat.isFile()) throw new Error('employee input must be a regular file')
      const hash = createSha256DigestBuilder()
      let bytes = 0
      for await (const value of createReadStream(path, { highWaterMark: 64 * 1024 })) {
        const chunk = value as Buffer
        hash.update(chunk)
        bytes += chunk.byteLength
      }
      const sha256 = hash.digestHex()
      const object = await publish('employee-input', {
        sha256,
        size: bytes,
        open: () => Bun.file(path).stream(),
      })
      return { blobRef: hostedObjectReference('employee-input', object), sha256, bytes }
    },
    async hasBlob(reference) {
      let object
      try {
        object = parseHostedObjectReference('employee-input', reference)
      } catch {
        return false
      }
      try {
        const found = await input.objects.stat(object.id)
        return found.sha256 === object.sha256 && found.size === object.size
      } catch (error) {
        if (error instanceof CrewStationApiError && error.status === 404) return false
        throw error
      }
    },
    async copyBlobTo(reference, target) {
      const object = parseHostedObjectReference('employee-input', reference)
      const stream = await input.objects.open(object)
      try {
        await input.writeWorkspace(target, stream, object)
      } catch (error) {
        if (!stream.locked) await stream.cancel(error).catch(() => undefined)
        throw error
      }
    },
  }
  return { employeePrograms: programs, employeeInputArtifacts: uploads }
}
