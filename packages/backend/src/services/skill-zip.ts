// RFC-345 narrow archive-decoder compatibility facade. Provider-bound parse
// and commit moved behind SkillZipImportParticipant; only the pure ZIP decoder
// remains for package parsing and exact legacy decoder tests.
export { decodeZip, ZIP_LIMITS } from '@/modules/resource-catalog/infrastructure/legacy/skill-zip'
