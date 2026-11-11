/**
 * Output shaping: keep tool results small enough for a model to read, and
 * strip anything that looks like a credential before it leaves the process.
 */

export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_OUTPUT_LINES = 200;

export interface ClipOptions {
  maxBytes?: number;
  maxLines?: number;
  hint?: string;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return value;
  }
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

/**
 * Trim text to a byte and line budget, replacing the tail with a hint the
 * model can act on ("narrow with path= or max_lines=").
 */
export function clip(text: string, options: ClipOptions = {}): string {
  const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
  const maxLines = options.maxLines ?? MAX_OUTPUT_LINES;
  const hint = options.hint ?? "narrow with path= or max_lines=";
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.length === 0) {
    return normalized;
  }

  const lines = normalized.split("\n");
  const kept: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    if (kept.length >= maxLines) {
      break;
    }
    const cost = byteLength(line) + 1;
    if (bytes + cost > maxBytes) {
      break;
    }
    kept.push(line);
    bytes += cost;
  }

  if (kept.length === lines.length) {
    return kept.join("\n");
  }

  const suffixFor = (remaining: number): string =>
    "\n…truncated (" + remaining + " more lines; " + hint + ")";

  // Drop whole lines until the truncation note itself fits in the budget.
  while (kept.length > 0) {
    const candidate = kept.join("\n") + suffixFor(lines.length - kept.length);
    if (byteLength(candidate) <= maxBytes) {
      return candidate;
    }
    kept.pop();
  }

  // A single line is already over budget: hard-trim the first line.
  const suffix = suffixFor(lines.length);
  const room = Math.max(0, maxBytes - byteLength(suffix));
  return truncateUtf8(lines[0] ?? "", room) + suffix;
}

/**
 * Keep the newest lines of a log, replacing the head with a count. CI failures
 * are almost always at the end, and this keeps a job log inside one result.
 */
export function tailLines(text: string, maxLines: number): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  if (normalized.length === 0) {
    return "";
  }
  const lines = normalized.split("\n");
  if (lines.length <= maxLines) {
    return normalized;
  }
  const omitted = lines.length - maxLines;
  return "…(" + omitted + " earlier lines omitted)\n" + lines.slice(omitted).join("\n");
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bghp_[A-Za-z0-9]{20,}\b/g, "ghp_***redacted***"],
  [/\bgho_[A-Za-z0-9]{20,}\b/g, "gho_***redacted***"],
  [/\bghs_[A-Za-z0-9]{20,}\b/g, "ghs_***redacted***"],
  [/\bghu_[A-Za-z0-9]{20,}\b/g, "ghu_***redacted***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_***redacted***"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer ***redacted***"],
  [/\bx-access-token:[^@\s]+/g, "x-access-token:***redacted***"],
];

/** Replace credential-shaped substrings with a marker. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
