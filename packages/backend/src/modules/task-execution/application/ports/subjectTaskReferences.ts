export interface SubjectTaskReferences {
  nonTerminalTaskIds(subject: {
    readonly kind: 'agent' | 'workflow' | 'workgroup'
    readonly sourceId: string
  }): Promise<readonly string[]>
}
