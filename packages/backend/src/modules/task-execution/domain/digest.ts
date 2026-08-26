// Task-execution-owned access to the repository's canonical one-shot digest.
// Keeping this adapter inside the bounded context prevents every application,
// domain and infrastructure consumer from creating a separate legacy outbound
// dependency while preserving RFC-284's single crypto implementation.
export { sha256Hex } from '@/util/hash'
