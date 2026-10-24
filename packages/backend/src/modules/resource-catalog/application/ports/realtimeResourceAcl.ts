export interface RealtimeResourceAcl {
  find(
    kind: 'workflow' | 'workgroup',
    id: string,
  ): Promise<{
    readonly id: string
    readonly ownerUserId: string | null
    readonly visibility: 'public' | 'private'
  } | null>
}
