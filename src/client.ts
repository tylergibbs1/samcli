/**
 * SAM.gov Opportunities API client.
 *
 * Responsibilities:
 *  - Translate agent-facing ISO dates to the API's MM/dd/yyyy format.
 *  - Apply sensible defaults (last-30-days window, limit=25) so that the
 *    API's surprising defaults (limit=1, required date range) don't bite.
 *  - Enforce the 1-year date range client-side so we get a clean CliError
 *    instead of an opaque 400.
 *  - Normalize HTTP errors into machine-readable CliError codes.
 *
 * Notes:
 *  - Authentication is the `api_key` query parameter.
 *  - There is no documented per-second rate limit; daily quotas apply and
 *    vary by account tier. The client does not retry on 429 by design —
 *    agents should see rate-limit failures immediately, not silently wait.
 */
import { CliError } from "./errors.js";
import {
  SearchParams,
  SearchResponse,
  type SearchResponse as SearchResponseType,
} from "./schema.js";

const DEFAULT_BASE_URL = "https://api.sam.gov";
const SEARCH_PATH = "/opportunities/v2/search";

/**
 * Hosts we consider trustworthy when following a `description` URL returned
 * by the search endpoint. We append the API key to that URL, so we must
 * refuse to follow URLs on other hosts — otherwise a SAM.gov-side mistake
 * (or injection into a stored opportunity) could leak the key.
 */
const TRUSTED_HOST_SUFFIX = ".sam.gov";

/**
 * Maximum server-accepted date range, in milliseconds.
 *
 * The API docs say "1 year" but the server rejects even exactly-365-day
 * ranges with a (broken) "Date range must be null year(s) apart" error.
 * We stay a day under to avoid edge cases at the boundary — we'd rather
 * clip one day than have agents hit an opaque 400.
 */
const MAX_RANGE_MS = 364 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_LIMIT = 25;

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

/** Preview of the request that would be made — used by --dry-run. */
export interface RequestPreview {
  method: "GET";
  url: string;
  /** Same URL but with `api_key` redacted for safe display/logging. */
  redactedUrl: string;
  params: Record<string, string>;
}

export class SamClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    if (!opts.apiKey) {
      throw new CliError({
        code: "MISSING_API_KEY",
        message: "SAM_API_KEY is not set",
        suggestion:
          "Export SAM_API_KEY with a key from https://sam.gov (Account Details → API Key).",
      });
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.userAgent = opts.userAgent ?? "samcli/0.1 (+agent)";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Build the request without sending it. Exposed for `--dry-run` and for
   * tests that want to assert on the exact URL construction.
   */
  buildSearchRequest(rawParams: SearchParams): RequestPreview {
    const params = this.applyDefaults(rawParams);
    this.assertDateRange(params.postedFrom, params.postedTo, "postedFrom/postedTo");
    this.assertDateRange(
      params.responseDeadlineFrom,
      params.responseDeadlineTo,
      "responseDeadlineFrom/responseDeadlineTo",
    );

    const query: Record<string, string> = {};
    // Dates — ISO → MM/dd/yyyy
    if (params.postedFrom) query.postedFrom = isoToSlash(params.postedFrom);
    if (params.postedTo) query.postedTo = isoToSlash(params.postedTo);
    if (params.responseDeadlineFrom)
      query.rdlfrom = isoToSlash(params.responseDeadlineFrom);
    if (params.responseDeadlineTo)
      query.rdlto = isoToSlash(params.responseDeadlineTo);

    // Direct-mapped string params
    if (params.ptype) query.ptype = params.ptype;
    if (params.solicitationNumber) query.solnum = params.solicitationNumber;
    if (params.noticeId) query.noticeid = params.noticeId;
    if (params.title) query.title = params.title;
    if (params.state) query.state = params.state;
    if (params.zip) query.zip = params.zip;
    if (params.naicsCode) query.ncode = params.naicsCode;
    if (params.classificationCode) query.ccode = params.classificationCode;
    if (params.organizationCode) query.organizationCode = params.organizationCode;
    if (params.organizationName) query.organizationName = params.organizationName;
    if (params.typeOfSetAside) query.typeOfSetAside = params.typeOfSetAside;
    if (params.typeOfSetAsideDescription)
      query.typeOfSetAsideDescription = params.typeOfSetAsideDescription;

    // Numbers
    if (params.limit !== undefined) query.limit = String(params.limit);
    if (params.offset !== undefined) query.offset = String(params.offset);

    const url = this.makeUrl(SEARCH_PATH, { ...query, api_key: this.apiKey });
    const redactedUrl = this.makeUrl(SEARCH_PATH, { ...query, api_key: "REDACTED" });
    return { method: "GET", url, redactedUrl, params: query };
  }

  async search(rawParams: SearchParams): Promise<SearchResponseType> {
    const preview = this.buildSearchRequest(rawParams);
    const res = await this.request(preview.url);
    const body = await this.parseBody(res);
    return SearchResponse.parse(body);
  }

  /**
   * Fetch the plaintext description for a notice.
   *
   * SAM.gov's description endpoint lives at an inconsistent path (search is
   * under `/opportunities/v2/...` but description is under `/prod/...`),
   * and has changed in the past. Rather than hardcode the path, we first
   * search for the notice, extract the `description` URL from the payload,
   * and follow it. This is self-healing if SAM.gov moves the endpoint.
   *
   * Security: we append the API key to the URL we follow, so we refuse any
   * URL whose host is not under `.sam.gov`.
   */
  async describe(noticeId: string): Promise<{ description: string; sourceUrl: string }> {
    const today = new Date();
    const from = new Date(today);
    from.setUTCDate(from.getUTCDate() - 364);
    const searchRes = await this.search({
      noticeId,
      postedFrom: isoFromDate(from),
      postedTo: isoFromDate(today),
      limit: 1,
    });
    const opp = searchRes.opportunitiesData[0];
    if (!opp) {
      throw new CliError({
        code: "NOT_FOUND",
        message: `No opportunity found with noticeId ${noticeId} in the last 364 days`,
        suggestion: "Older notices fall outside the search window; describe is not available for them via this CLI.",
      });
    }
    const descField = opp.description;
    if (typeof descField !== "string" || !/^https?:\/\//.test(descField)) {
      throw new CliError({
        code: "NOT_FOUND",
        message: `Opportunity ${noticeId} has no description URL`,
      });
    }

    const followUrl = this.authorizeDescriptionUrl(descField);
    const res = await this.request(followUrl);
    if (res.status === 404) {
      throw new CliError({
        code: "NOT_FOUND",
        message: `Description not available for notice ${noticeId}`,
        suggestion: "Some opportunities omit description bodies. Check the uiLink for the full notice.",
      });
    }
    const body = await this.parseBody(res);
    const text = extractDescriptionText(body);
    if (text === null) {
      throw new CliError({
        code: "UPSTREAM_ERROR",
        message: "Unexpected description payload shape",
        details: body,
      });
    }
    return { description: text, sourceUrl: descField };
  }

  /**
   * Validate a SAM.gov-returned description URL before we attach the API
   * key and follow it. Enforces https, a trusted host suffix, and no
   * credential leakage via userinfo.
   */
  private authorizeDescriptionUrl(rawUrl: string): string {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new CliError({
        code: "UPSTREAM_ERROR",
        message: "Description URL returned by SAM.gov is not a valid URL",
        details: rawUrl,
      });
    }
    if (parsed.protocol !== "https:") {
      throw new CliError({
        code: "UPSTREAM_ERROR",
        message: "Refusing to follow non-HTTPS description URL",
        details: rawUrl,
      });
    }
    if (parsed.username || parsed.password) {
      throw new CliError({
        code: "UPSTREAM_ERROR",
        message: "Refusing to follow description URL containing userinfo",
        details: rawUrl,
      });
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== "sam.gov" && !host.endsWith(TRUSTED_HOST_SUFFIX)) {
      throw new CliError({
        code: "UPSTREAM_ERROR",
        message: `Refusing to follow description URL on untrusted host ${host}`,
        details: rawUrl,
      });
    }
    if (!parsed.searchParams.has("api_key")) {
      parsed.searchParams.set("api_key", this.apiKey);
    }
    return parsed.toString();
  }

  // ---- Internals ------------------------------------------------------------

  private applyDefaults(params: SearchParams): SearchParams {
    const out: SearchParams = { ...params };
    if (out.limit === undefined) out.limit = DEFAULT_LIMIT;
    if (!out.postedFrom && !out.postedTo) {
      const today = new Date();
      const from = new Date(today);
      from.setUTCDate(from.getUTCDate() - DEFAULT_WINDOW_DAYS);
      out.postedFrom = isoFromDate(from);
      out.postedTo = isoFromDate(today);
    } else if (!out.postedFrom || !out.postedTo) {
      throw new CliError({
        code: "INVALID_INPUT",
        message: "postedFrom and postedTo must be provided together",
        suggestion: "Omit both to default to the last 30 days, or provide both.",
      });
    }
    return out;
  }

  private assertDateRange(
    from: string | undefined,
    to: string | undefined,
    label: string,
  ): void {
    if (!from || !to) return;
    const fromMs = Date.parse(from + "T00:00:00Z");
    const toMs = Date.parse(to + "T00:00:00Z");
    if (toMs < fromMs) {
      throw new CliError({
        code: "INVALID_DATE_RANGE",
        message: `${label}: 'from' date is after 'to' date`,
      });
    }
    if (toMs - fromMs > MAX_RANGE_MS) {
      throw new CliError({
        code: "INVALID_DATE_RANGE",
        message: `${label}: range must be 364 days or less (SAM.gov enforces a "1 year" limit strictly)`,
        suggestion: "Narrow the date window or paginate across multiple windows.",
      });
    }
  }

  private makeUrl(path: string, params: Record<string, string>): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  private async request(url: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": this.userAgent,
        },
      });
    } catch (e) {
      throw new CliError({
        code: "NETWORK_ERROR",
        message: `Network error contacting SAM.gov: ${(e as Error).message}`,
      });
    }

    if (res.ok) return res;

    const body = await safeReadText(res);
    const code = mapStatus(res.status);
    throw new CliError({
      code,
      message: `SAM.gov returned ${res.status} ${res.statusText}`,
      details: truncate(body, 2000),
      suggestion: suggestionForStatus(res.status),
    });
  }

  private async parseBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // Some endpoints return text/plain for descriptions.
      return text;
    }
  }
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Pull plaintext out of whatever the description endpoint returns. SAM.gov
 * has been seen returning:
 *   - a bare string (text/plain)
 *   - `{ description: "..." }`
 *   - `{ description: { content: "..." } }` (nested)
 */
function extractDescriptionText(body: unknown): string | null {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.description === "string") return obj.description;
    if (obj.description && typeof obj.description === "object") {
      const inner = (obj.description as Record<string, unknown>).content;
      if (typeof inner === "string") return inner;
    }
    if (typeof obj.content === "string") return obj.content;
  }
  return null;
}

function isoFromDate(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isoToSlash(iso: string): string {
  // YYYY-MM-DD → MM/dd/yyyy (already validated upstream).
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function mapStatus(status: number): CliError["code"] {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_ERROR";
  return "UPSTREAM_ERROR";
}

function suggestionForStatus(status: number): string | undefined {
  if (status === 401) return "Check SAM_API_KEY — the key was rejected.";
  if (status === 403) return "The key is valid but not authorized for this resource.";
  if (status === 429)
    return "Daily quota or per-minute rate exceeded. Wait and retry.";
  if (status >= 500) return "Upstream error — retry after a short delay.";
  return undefined;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
