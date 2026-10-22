import { z } from 'zod'

/** Neutral content link. Collaboration does not interpret the linked model. */
export const ArtifactElementAnchorSchema = z
  .object({
    artifactRef: z.string().min(1).max(200),
    elementIds: z.array(z.string().min(1).max(200)),
    relationIds: z.array(z.string().min(1).max(200)),
    viewId: z.string().min(1).max(200).optional(),
  })
  .strict()
export type ArtifactElementAnchor = z.infer<typeof ArtifactElementAnchorSchema>
