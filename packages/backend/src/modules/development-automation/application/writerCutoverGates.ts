// RFC-395: legacy drain recovery is completed by conversion, before activation.
export interface DevelopmentWriterCutover {
  read(): Promise<{ readonly mode: 'os-active'; readonly legacyAdmissionsEnabled: false }>
}
