import type { z } from 'zod'
import type { metadataFileSchema, sessionMetadataSchema } from './schemas.js'

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>
export type MetadataBySession = z.infer<typeof metadataFileSchema>

/**
 * A change to one session's row. A key present with `undefined` clears that
 * field; a key left out leaves it alone. The HTTP layer turns the wire's `null`
 * into `undefined` before building one of these.
 */
export type MetadataPatch = Partial<SessionMetadata>
