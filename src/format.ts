/**
 * Output formatters.
 *
 * JSON is the default for agents. NDJSON is used for streaming paginated
 * results so large result sets don't need to be buffered end-to-end. A tiny
 * text table is provided for humans browsing from a TTY.
 */

export type OutputFormat = "json" | "ndjson" | "table";

/**
 * Select a format from an explicit flag or the TTY state. Agents pipe stdout,
 * so non-TTY implies JSON — matching the agent-CLI convention.
 */
export function pickFormat(flag: string | undefined): OutputFormat {
  if (flag === "json" || flag === "ndjson" || flag === "table") return flag;
  if (flag && flag.length > 0) {
    throw new Error(`unknown --output format: ${flag}`);
  }
  return process.stdout.isTTY ? "table" : "json";
}

/**
 * Apply a field mask to an opportunity object. Supports dotted paths so
 * agents can request nested fields without pulling the whole subtree:
 *
 *   --fields "noticeId,title,award.amount,placeOfPerformance.state.name"
 */
export function applyFieldMask(
  obj: Record<string, unknown>,
  fields: string[] | undefined,
): Record<string, unknown> {
  if (!fields || fields.length === 0) return obj;
  const out: Record<string, unknown> = {};
  for (const path of fields) {
    const value = getPath(obj, path);
    if (value !== undefined) setPath(out, path, value);
  }
  return out;
}

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      cur = next as Record<string, unknown>;
    } else {
      const fresh: Record<string, unknown> = {};
      cur[key] = fresh;
      cur = fresh;
    }
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Parse a CSV field list — trims whitespace and drops empty entries. */
export function parseFields(csv: string | undefined): string[] | undefined {
  if (!csv) return undefined;
  const parts = csv.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function writeNdjson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

/**
 * Human-readable table for TTY users. Intentionally minimal — agents should
 * not parse this, they should use JSON.
 */
export function writeOpportunitiesTable(
  opps: Array<Record<string, unknown>>,
  total: number,
): void {
  if (opps.length === 0) {
    process.stdout.write(`No opportunities (totalRecords=${total})\n`);
    return;
  }
  const rows = opps.map((o) => ({
    noticeId: str(o.noticeId).slice(0, 32),
    type: str(o.type).slice(0, 20),
    posted: str(o.postedDate).slice(0, 10),
    deadline: str(o.responseDeadLine).slice(0, 10),
    title: str(o.title).slice(0, 60),
  }));
  const widths = {
    noticeId: maxWidth(rows, "noticeId", "noticeId"),
    type: maxWidth(rows, "type", "type"),
    posted: maxWidth(rows, "posted", "posted"),
    deadline: maxWidth(rows, "deadline", "deadline"),
    title: maxWidth(rows, "title", "title"),
  };
  const header = [
    pad("noticeId", widths.noticeId),
    pad("type", widths.type),
    pad("posted", widths.posted),
    pad("deadline", widths.deadline),
    pad("title", widths.title),
  ].join("  ");
  process.stdout.write(header + "\n");
  process.stdout.write("-".repeat(header.length) + "\n");
  for (const r of rows) {
    process.stdout.write(
      [
        pad(r.noticeId, widths.noticeId),
        pad(r.type, widths.type),
        pad(r.posted, widths.posted),
        pad(r.deadline, widths.deadline),
        pad(r.title, widths.title),
      ].join("  ") + "\n",
    );
  }
  process.stdout.write(`\n${opps.length} shown / ${total} total\n`);
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function maxWidth<T extends Record<string, string>>(
  rows: T[],
  key: keyof T,
  header: string,
): number {
  // noUncheckedIndexedAccess treats r[key] as possibly undefined; we know
  // the rows are built with all keys present, so coerce to string.
  return Math.max(
    header.length,
    ...rows.map((r) => (r[key] ?? "").length),
  );
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}
