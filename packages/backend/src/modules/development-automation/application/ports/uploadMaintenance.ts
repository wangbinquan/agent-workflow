export interface UploadMaintenancePersistence {
  sweepExpired(now: number, limit: number): Promise<number>
}
