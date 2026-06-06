/**
 * Test-only: decode the part bodies of an RFC 5322 message (already base64url-decoded to text)
 * and join them. The Gmail client encodes each part with Content-Transfer-Encoding: base64, so
 * tests that assert on the visible body text decode it through here rather than scanning the raw
 * MIME. Handles single-part and multipart/alternative messages.
 */
export function decodeEmailBodies(rawMessage: string): string {
  const lines = rawMessage.split('\r\n')
  const parts: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== 'Content-Transfer-Encoding: base64') continue
    // The body starts after the blank line that ends this part's headers.
    let j = i + 1
    while (j < lines.length && lines[j] !== '') j++
    j++
    const b64: string[] = []
    for (; j < lines.length; j++) {
      const line = lines[j]
      if (line === undefined || line === '' || line.startsWith('--')) break
      b64.push(line)
    }
    parts.push(Buffer.from(b64.join(''), 'base64').toString('utf8'))
  }

  return parts.join('\n')
}
