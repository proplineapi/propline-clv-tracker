/**
 * Tiny CSV parser — handles quoted fields with embedded commas/quotes
 * but nothing fancier (no escaped newlines mid-field, no schema-on-read).
 * The bet-log files this tool consumes are small (<10MB) and human-edited,
 * so we don't need a streaming parser or a heavyweight dependency.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        cur += c;
        i++;
      }
    } else if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ",") {
      row.push(cur);
      cur = "";
      i++;
    } else if (c === "\n" || c === "\r") {
      // Trailing \r in CRLF: skip the \n that follows.
      if (c === "\r" && text[i + 1] === "\n") i += 2;
      else i++;
      row.push(cur);
      cur = "";
      // Skip empty trailing rows (e.g. final newline).
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      cur += c;
      i++;
    }
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

export interface CsvHeader {
  index: Map<string, number>;
  /** Throws if the column doesn't exist — fail fast at parse time. */
  required(row: string[], col: string): string;
  /** Returns null when the column is absent or empty. */
  optional(row: string[], col: string): string | null;
}

export function makeHeader(headerRow: string[]): CsvHeader {
  const index = new Map<string, number>();
  for (let i = 0; i < headerRow.length; i++) {
    index.set(headerRow[i]!.trim().toLowerCase(), i);
  }
  return {
    index,
    required(row, col) {
      const i = index.get(col.toLowerCase());
      if (i === undefined) {
        throw new Error(`CSV missing required column: '${col}'`);
      }
      const v = (row[i] ?? "").trim();
      if (v === "") {
        throw new Error(`CSV row missing value for '${col}'`);
      }
      return v;
    },
    optional(row, col) {
      const i = index.get(col.toLowerCase());
      if (i === undefined) return null;
      const v = (row[i] ?? "").trim();
      return v === "" ? null : v;
    },
  };
}
