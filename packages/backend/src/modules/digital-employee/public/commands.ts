/** Context-owned maintenance command port, composed once by the Worker bootstrap. */
export interface DigitalEmployeeMaintenanceCommands {
  sweepExpiredInputUploads(now: number, limit: number): Promise<number>
}
