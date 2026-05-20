/**
 * CSV export helper — RFC 4180 encoding.
 *
 * Handles commas, double-quotes, and newlines in field values.
 * Returns a string using CRLF line endings as the spec requires.
 */

function escapeCsv(val: unknown): string {
  const s = val == null ? '' : String(val)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

/**
 * Encode an array of records as a CSV string.
 *
 * @param headers  Column names (also used as the keys to pluck from each row).
 * @param rows     Data rows — values are accessed by header name.
 */
export function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const lines: string[] = [headers.map(escapeCsv).join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsv(row[h])).join(','))
  }
  return lines.join('\r\n')
}
