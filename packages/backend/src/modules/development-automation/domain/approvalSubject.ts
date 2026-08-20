import { z } from 'zod'

const payloadSchema = z
  .object({
    adapterRef: z
      .object({ id: z.string().min(1).max(500), revision: z.number().int().positive() })
      .strict(),
    correlationRef: z.string().min(1).max(500),
  })
  .strict()

export interface DevelopmentApprovalSubject {
  readonly adapterRef: {
    readonly id: string
    readonly revision: number
  }
  readonly correlationRef: string
}

export function encodeDevelopmentApprovalSubject(input: DevelopmentApprovalSubject): string {
  return `approval:v1:${Buffer.from(JSON.stringify(payloadSchema.parse(input))).toString('base64url')}`
}

export function decodeDevelopmentApprovalSubject(
  subjectRef: string,
): DevelopmentApprovalSubject | null {
  if (!subjectRef.startsWith('approval:v1:')) return null
  try {
    return payloadSchema.parse(
      JSON.parse(
        Buffer.from(subjectRef.slice('approval:v1:'.length), 'base64url').toString('utf8'),
      ) as unknown,
    )
  } catch {
    return null
  }
}
