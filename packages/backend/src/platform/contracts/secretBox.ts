// RFC-620 — the neutral contract of the at-rest secret box (moved from `auth/secretBox.ts`). Modules' application and
// infrastructure take the interface from here; the AES-256-GCM implementation and the daemon key file live in
// `platform/crypto/secretBox.ts`.

export interface SecretBox {
  seal(plaintext: string): string
  unseal(packed: string): string
}
