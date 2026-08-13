/**
 * Whether a candidate receipt email is trustworthy enough to feed the model.
 *
 * Gmail stamps every message it receives with an `Authentication-Results` header carrying its
 * own SPF/DKIM/DMARC verdict. We drop a candidate only when DMARC explicitly **failed** (a
 * strong forged-sender signal, since real Amazon mail is `dmarc=pass`) and keep everything else.
 *
 * This is fail-open by design: a missing or unparseable header never costs us a real receipt
 * (a missed enrichment is harmless; a wrongly-dropped one is not). It's defense-in-depth on top
 * of the address match in the Gmail query (which already excludes display-name spoofing) and
 * Amazon's own DMARC reject policy (which keeps forged amazon.com mail out of the inbox).
 */
export function isAuthentic(authenticationResults: string | null): boolean {
  if (!authenticationResults) return true

  return !/dmarc=fail/i.test(authenticationResults)
}
