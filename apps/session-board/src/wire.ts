import { z } from 'zod'
import { isKebabCase } from './session-name.js'

/**
 * The shapes a request body is allowed to arrive in.
 *
 * Parsing rather than asserting, so a body that is not what it claims is
 * refused at the door instead of reaching the metadata file. Unknown keys are
 * dropped by zod, which is what keeps a stray field from being written.
 */

/** `null` clears the field. A key left out leaves it alone. */
const clearableText = z.string().nullable()

// An empty string clears the name, the same as `null`, so it passes alongside
// the pattern rather than being caught as a malformed one.
const sessionName = z
  .string()
  .refine(value => value === '' || isKebabCase(value), {
    message: 'a session name is kebab-case: lowercase letters and digits, single hyphens between',
  })
  .nullable()

export const patchBodySchema = z.object({
  name: sessionName.optional(),
  group: clearableText.optional(),
  parkedReason: clearableText.optional(),
  progressPath: clearableText.optional(),
})

export const openBodySchema = z.object({ cwd: z.string().min(1) })
