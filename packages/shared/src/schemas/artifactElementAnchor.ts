import { z } from 'zod'
import { utf16MaxLength } from './utf16Length'

/** Neutral content link. Collaboration does not interpret the linked model. */
export const ArtifactElementAnchorSchema = z
  .object({
    artifactRef: z.string().min(1).check(utf16MaxLength(200)),
    elementIds: z.array(z.string().min(1).check(utf16MaxLength(200))),
    relationIds: z.array(z.string().min(1).check(utf16MaxLength(200))),
    viewId: z.string().min(1).check(utf16MaxLength(200)).optional(),
  })
  .strict()
export type ArtifactElementAnchor = z.infer<typeof ArtifactElementAnchorSchema>
