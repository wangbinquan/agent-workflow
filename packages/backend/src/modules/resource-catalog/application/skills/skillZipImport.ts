import { Buffer } from 'node:buffer'
import { SKILL_ZIP_LIMITS } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import type { SkillZipImportParticipant } from '../../public/participants'
import type { SkillZipArchiveSubmission } from '../../public/types'
import type { SkillZipImportPort } from './ports'

const PADDED_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_ARCHIVE_BASE64_LENGTH = Math.ceil(SKILL_ZIP_LIMITS.totalBytes / 3) * 4

function decodeArchive(submission: SkillZipArchiveSubmission): Uint8Array {
  if (submission.content.length > MAX_ARCHIVE_BASE64_LENGTH) {
    throw new ValidationError(
      'zip-limit-exceeded',
      `skill ZIP archive exceeds ${SKILL_ZIP_LIMITS.totalBytes} bytes`,
    )
  }
  if (submission.content.length % 4 !== 0 || !PADDED_BASE64.test(submission.content)) {
    throw new ValidationError('zip-decode-failed', 'skill ZIP archive is not valid base64')
  }
  return Buffer.from(submission.content, 'base64')
}

/** Transport-neutral public participant over one provider-selected ZIP port. */
export function createSkillZipImportParticipant(
  port: SkillZipImportPort,
): SkillZipImportParticipant {
  const participant: SkillZipImportParticipant = {
    parse: (authority, input) => port.parse(authority, decodeArchive(input.archive)),
    commit: (authority, input) =>
      port.commit(authority, decodeArchive(input.archive), input.decisions),
  }
  return Object.freeze(participant)
}
