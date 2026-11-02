// RFC-429: evidence reads, attempt contexts and mission input capture are members of the deployment's
// evidenceArtifacts, and requirement document commands belong to the requirement purpose. Root-binding tests that
// used to inject the retired `evidenceRead` / `evidenceDocumentCommands` selections inject through these shapes.
import { composeDevelopmentPurposeRoot } from '@/bootstrap/developmentPurposeRoot'
import type { EvidenceDocumentCommands } from '@/modules/development-automation/composition'
import type { EvidenceReadBinding } from '@/modules/development-automation/composition/evidenceReadBinding'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/local/fileEvidenceStore'

/** An evidence artifacts port whose read members are the selected ones and whose other capabilities are local. */
export function evidenceArtifactsWith(
  read: EvidenceReadBinding,
  root: string,
): EvidenceArtifactPort {
  const local = new EvidenceStore(root)
  return Object.freeze({
    get contents() {
      return read.contents
    },
    get documents() {
      return read.documents
    },
    get downloads() {
      return read.downloads
    },
    contexts: local.contexts,
    putFile: (path: string) => local.putFile(path),
    putBlobFromFile: (path: string) => local.putBlobFromFile(path),
    importStagedTree: (
      stagedRoot: string,
      budget: Parameters<EvidenceArtifactPort['importStagedTree']>[1],
    ) => local.importStagedTree(stagedRoot, budget),
    getBundle: (ref: string) => local.getBundle(ref),
    materializeBundle: (ref: string, destination: string) =>
      local.materializeBundle(ref, destination),
    materializeBlob: (ref: string, destination: string) => local.materializeBlob(ref, destination),
    hasBlob: (ref: string) => local.hasBlob(ref),
  })
}

/** The local default requirement purpose with the selected document commands, as a deployment would select it. */
export function requirementPurposeWith(input: {
  readonly appHome: string
  readonly evidenceArtifacts: EvidenceArtifactPort
  readonly documentCommands: EvidenceDocumentCommands
}) {
  const local = composeDevelopmentPurposeRoot({
    appHome: input.appHome,
    evidenceArtifacts: input.evidenceArtifacts,
  }).requirement
  return {
    configurationFor: local.configurationFor.bind(local),
    effects: local.effects,
    staging: local.staging,
    documentCommands: input.documentCommands,
  }
}
