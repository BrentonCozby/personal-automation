// Building blocks shared by the apps that render HTML email digests (notify, tasks).
// Email clients strip <style>/<head> and can't load web fonts, so digests inline everything and
// lean on system font stacks.

/** System sans-serif stack — what the OS already has, since email can't load web fonts. */
export const SANS_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

/** System monospace stack, for ids and error blocks. */
export const MONO_FONT_STACK = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"

/** Escape the five HTML-significant characters so user content can't break the markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Wrap explicit `http(s)://` and `www.` URLs (already HTML-escaped) in links. Schemeless domains
 * like "irs.gov/x" are left as text, keeping the pattern safe from false positives. Pass `escaped`
 * output from {@link escapeHtml}.
 */
export function linkify(escaped: string): string {
  return escaped.replace(/\b(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi, match => {
    const href = /^https?:\/\//i.test(match) ? match : `https://${match}`

    return `<a href="${href}" style="color:#1a73e8;">${match}</a>`
  })
}
