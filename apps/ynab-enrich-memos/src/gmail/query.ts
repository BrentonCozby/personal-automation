/**
 * Builds the Gmail search query for one transaction's receipt: messages from any of the
 * configured Amazon senders, within ± `windowDays` of the transaction date.
 *
 * Gmail's `after:`/`before:` take YYYY/MM/DD and bound by day, and `before:` is exclusive, so
 * the upper bound is shifted one extra day to keep the +windowDays day inside the range.
 */
export function buildReceiptQuery({
  fromAddresses,
  txnDate,
  windowDays,
}: {
  fromAddresses: string[]
  txnDate: string
  windowDays: number
}): string {
  const from = fromAddresses.map(a => `from:${a}`).join(' OR ')
  const after = toGmailDate(shiftIsoDate({ iso: txnDate, deltaDays: -windowDays }))
  const before = toGmailDate(shiftIsoDate({ iso: txnDate, deltaDays: windowDays + 1 }))

  return `(${from}) after:${after} before:${before}`
}

// Adds (or subtracts) whole days to a YYYY-MM-DD date in UTC, so the result depends only on the
// input string, with no local-timezone drift. Returns YYYY-MM-DD.
function shiftIsoDate({ iso, deltaDays }: { iso: string; deltaDays: number }): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)

  return d.toISOString().slice(0, 10)
}

function toGmailDate(iso: string): string {
  return iso.replaceAll('-', '/')
}
