// RFC-414: the hosted task image's archive listing is infrastructure; bootstrap (which depends only on module
// composition / public) reaches it through this export.
export { executeTaskImageArchive } from '../infrastructure/crewstation/taskImageArchive'
