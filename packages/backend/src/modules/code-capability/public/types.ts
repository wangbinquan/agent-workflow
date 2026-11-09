// RFC-474 — what another context is handed for this module's part of the first-run sample: the participant bootstrap composes
// (`composition/demoSeed.ts`) and the receipt it answers. Named types only, no star re-export. (Not `public/participants.ts`:
// RFC-453 retired that path with the code-review artifact participant it held, and locks it absent.)
export type {
  CodeCapabilityDemoSeedParticipant,
  CodeCapabilityDemoSeedReceipt,
} from '../application/demoSeed'
