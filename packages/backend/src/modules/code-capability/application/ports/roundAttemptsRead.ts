import type { CodeAiAttemptProjection } from '../../public/queries'

/** Provider-neutral read mechanics for one round's bounded AI attempt history. */
export interface RoundAttemptsReadPort {
  load(roundId: string, limit: number): Promise<readonly CodeAiAttemptProjection[]>
}
