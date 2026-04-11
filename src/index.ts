#!/usr/bin/env node
/**
 * samcli — agent-first CLI for the SAM.gov Opportunities API.
 *
 * Design rules (see SKILL.md for the agent-facing version):
 *  - Default output is JSON when stdout is not a TTY. Table output is for
 *    humans only; agents should never parse it.
 *  - Every mutation-like operation supports --dry-run. The Opportunities
 *    API is read-only, but search requests still consume daily quota, so
 *    dry-run lets agents validate without spending it.
 *  - Inputs are validated at the CLI boundary by zod. Internal code trusts
 *    typed values — we do not sprinkle defensive checks downstream.
 *  - Errors exit non-zero and write a JSON envelope to stderr. See errors.ts.
 */
import { Command, Option } from "commander";
import { z } from "zod";
import { SamClient } from "./client.js";
import { CliError, reportError } from "./errors.js";
import {
  applyFieldMask,
  parseFields,
  pickFormat,
  writeJson,
  writeNdjson,
  writeOpportunitiesTable,
} from "./format.js";
import {
  PROCUREMENT_TYPES,
  SET_ASIDE_CODES,
  SearchParams,
  SearchResponse,
} from "./schema.js";

const VERSION = "0.1.0";

// ---- Client bootstrap ------------------------------------------------------

function makeClient(): SamClient {
  const apiKey = process.env.SAM_API_KEY ?? "";
  const baseUrl = process.env.SAMCLI_BASE_URL;
  return new SamClient({
    apiKey,
    baseUrl,
    userAgent: process.env.SAMCLI_USER_AGENT,
  });
}

// ---- Input parsing helpers -------------------------------------------------

/**
 * Merge a raw --json payload with convenience flags. Convenience flags
 * override the JSON payload on conflict — this matches agent intuition
 * ("the flag I just typed wins").
 */
function buildSearchParams(
  jsonPayload: string | undefined,
  flagParams: Record<string, unknown>,
): SearchParams {
  let base: Record<string, unknown> = {};
  if (jsonPayload) {
    try {
      const parsed = JSON.parse(jsonPayload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CliError({
          code: "INVALID_INPUT",
          message: "--json must be a JSON object",
        });
      }
      base = parsed as Record<string, unknown>;
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError({
        code: "INVALID_INPUT",
        message: `--json is not valid JSON: ${(e as Error).message}`,
      });
    }
  }
  // Drop undefined flag values so they don't shadow JSON payload keys.
  for (const [k, v] of Object.entries(flagParams)) {
    if (v !== undefined) base[k] = v;
  }

  const result = SearchParams.safeParse(base);
  if (!result.success) {
    throw new CliError({
      code: "INVALID_INPUT",
      message: "search parameters failed validation",
      details: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return result.data;
}

function parseIntFlag(label: string) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n)) {
      throw new CliError({
        code: "INVALID_INPUT",
        message: `${label} must be an integer`,
      });
    }
    return n;
  };
}

// ---- Commands --------------------------------------------------------------

function searchCommand(): Command {
  return new Command("search")
    .description("Search SAM.gov contract opportunities")
    .option("--json <payload>", "raw JSON params object (merged with flags)")
    .option("--posted-from <date>", "posted date from (YYYY-MM-DD)")
    .option("--posted-to <date>", "posted date to (YYYY-MM-DD)")
    .option("--response-from <date>", "response deadline from (YYYY-MM-DD)")
    .option("--response-to <date>", "response deadline to (YYYY-MM-DD)")
    .option("--title <text>", "title text (free text search)")
    .option("--notice-id <id>", "notice id")
    .option("--solicitation <num>", "solicitation number")
    .option("--state <code>", "place of performance state (2-letter)")
    .option("--zip <zip>", "place of performance zip (5 or 9 digits)")
    .option("--naics <code>", "NAICS code (1-6 digits)")
    .option("--classification <code>", "classification code")
    .option("--organization-name <name>", "organization name (dept or subtier)")
    .option("--organization-code <code>", "organization code")
    .addOption(
      new Option("--ptype <code>", "procurement type code").choices(
        Object.keys(PROCUREMENT_TYPES),
      ),
    )
    .addOption(
      new Option("--set-aside <code>", "set-aside code").choices(
        Object.keys(SET_ASIDE_CODES),
      ),
    )
    .option("--limit <n>", "records per page (1-1000)", parseIntFlag("--limit"))
    .option("--offset <n>", "page offset (0-based)", parseIntFlag("--offset"))
    .option("--fields <csv>", "comma-separated fields to return (dotted paths ok)")
    .option("--page-all", "paginate all pages, emit NDJSON")
    .option("--max-pages <n>", "safety cap for --page-all", parseIntFlag("--max-pages"))
    .option("--dry-run", "print the request that would be sent, don't call the API")
    .option("--output <fmt>", "output format: json | ndjson | table")
    .action(async (opts) => {
      try {
        const params = buildSearchParams(opts.json, {
          postedFrom: opts.postedFrom,
          postedTo: opts.postedTo,
          responseDeadlineFrom: opts.responseFrom,
          responseDeadlineTo: opts.responseTo,
          title: opts.title,
          noticeId: opts.noticeId,
          solicitationNumber: opts.solicitation,
          state: opts.state,
          zip: opts.zip,
          naicsCode: opts.naics,
          classificationCode: opts.classification,
          organizationName: opts.organizationName,
          organizationCode: opts.organizationCode,
          ptype: opts.ptype,
          typeOfSetAside: opts.setAside,
          limit: opts.limit,
          offset: opts.offset,
        });

        const fields = parseFields(opts.fields);
        const format = pickFormat(opts.output);

        const client = makeClient();

        if (opts.dryRun) {
          const preview = client.buildSearchRequest(params);
          writeJson({
            dryRun: true,
            method: preview.method,
            url: preview.redactedUrl,
            params: preview.params,
          });
          return;
        }

        if (opts.pageAll) {
          await streamAllPages(client, params, fields, opts.maxPages);
          return;
        }

        const res = await client.search(params);
        emitSearchResult(res, fields, format);
      } catch (e) {
        reportError(e);
      }
    });
}

async function streamAllPages(
  client: SamClient,
  baseParams: SearchParams,
  fields: string[] | undefined,
  maxPagesOpt: number | undefined,
): Promise<void> {
  const pageSize = baseParams.limit ?? 100;
  const maxPages = maxPagesOpt ?? 100;
  let offset = baseParams.offset ?? 0;
  let page = 0;
  let total = Infinity;

  while (page < maxPages && offset < total) {
    const params: SearchParams = { ...baseParams, limit: pageSize, offset };
    const res = await client.search(params);
    total = res.totalRecords;
    for (const opp of res.opportunitiesData) {
      writeNdjson(applyFieldMask(opp, fields));
    }
    if (res.opportunitiesData.length === 0) break;
    offset += res.opportunitiesData.length;
    page += 1;
  }
}

function emitSearchResult(
  res: z.infer<typeof SearchResponse>,
  fields: string[] | undefined,
  format: "json" | "ndjson" | "table",
): void {
  const filtered = res.opportunitiesData.map((o) => applyFieldMask(o, fields));
  if (format === "ndjson") {
    for (const o of filtered) writeNdjson(o);
    return;
  }
  if (format === "table") {
    writeOpportunitiesTable(filtered, res.totalRecords);
    return;
  }
  writeJson({
    totalRecords: res.totalRecords,
    limit: res.limit,
    offset: res.offset,
    opportunitiesData: filtered,
  });
}

function getCommand(): Command {
  return new Command("get")
    .description("Fetch a single opportunity by noticeId")
    .argument("<noticeId>", "SAM.gov notice id")
    .option("--fields <csv>", "comma-separated fields to return")
    .option("--posted-from <date>", "posted window start (default: 1 year ago)")
    .option("--posted-to <date>", "posted window end (default: today)")
    .option("--output <fmt>", "output format: json | ndjson | table")
    .action(async (noticeId: string, opts) => {
      try {
        // The v2 search endpoint has no by-id lookup, so we search by
        // noticeid inside a wide date window. The server rejects exactly-
        // 1-year ranges, so we stay a day under (matches MAX_RANGE_MS in
        // client.ts).
        const today = new Date();
        const yearAgo = new Date(today);
        yearAgo.setUTCDate(yearAgo.getUTCDate() - 364);
        const params = buildSearchParams(undefined, {
          noticeId,
          postedFrom: opts.postedFrom ?? toIso(yearAgo),
          postedTo: opts.postedTo ?? toIso(today),
          limit: 1,
        });
        const client = makeClient();
        const res = await client.search(params);
        if (res.opportunitiesData.length === 0) {
          throw new CliError({
            code: "NOT_FOUND",
            message: `No opportunity found with noticeId ${noticeId} in the requested window`,
            suggestion:
              "Widen the date window with --posted-from / --posted-to (max 1 year).",
          });
        }
        const fields = parseFields(opts.fields);
        const format = pickFormat(opts.output);
        const opp = applyFieldMask(res.opportunitiesData[0]!, fields);
        if (format === "ndjson") {
          writeNdjson(opp);
        } else if (format === "table") {
          writeOpportunitiesTable([opp], res.totalRecords);
        } else {
          writeJson(opp);
        }
      } catch (e) {
        reportError(e);
      }
    });
}

function describeCommand(): Command {
  return new Command("describe")
    .description("Fetch the full description text for an opportunity")
    .argument("<noticeId>", "SAM.gov notice id")
    .option("--output <fmt>", "output format: json | table (default json)")
    .action(async (noticeId: string, opts) => {
      try {
        // Identifier hardening before we hit the network. We reuse the
        // same rules as search via the shared schema, and translate any
        // zod error into a CliError so the stderr envelope stays stable.
        const parsed = SearchParams.shape.noticeId.safeParse(noticeId);
        if (!parsed.success || parsed.data === undefined) {
          throw new CliError({
            code: "INVALID_INPUT",
            message: "invalid noticeId",
            details: parsed.success
              ? "empty noticeId"
              : parsed.error.issues.map((i) => i.message),
          });
        }
        const client = makeClient();
        const desc = await client.describe(parsed.data);
        const format = pickFormat(opts.output);
        if (format === "table") {
          process.stdout.write(desc.description + "\n");
        } else {
          writeJson(desc);
        }
      } catch (e) {
        reportError(e);
      }
    });
}

function schemaCommand(): Command {
  const cmd = new Command("schema").description(
    "Introspect CLI parameter and response schemas (agent-friendly)",
  );
  cmd
    .command("search")
    .description("Dump the search parameters schema as JSON")
    .action(() => {
      writeJson({
        name: "search",
        description: "SAM.gov Opportunities API v2 search parameters",
        inputSchema: zodToPlain(SearchParams),
        responseEnvelope: {
          totalRecords: "number",
          limit: "number",
          offset: "number",
          opportunitiesData: "array<Opportunity>",
        },
        notes: [
          "Dates are ISO YYYY-MM-DD. The client converts to MM/dd/yyyy internally.",
          "postedFrom/postedTo default to the last 30 days if omitted.",
          "API's native default limit is 1; the CLI defaults to 25.",
          "The 'description' field on each opportunity is a URL. Use `samcli describe <noticeId>` for the text.",
        ],
      });
    });

  cmd
    .command("set-asides")
    .description("List set-aside codes and their descriptions")
    .action(() => writeJson(SET_ASIDE_CODES));

  cmd
    .command("procurement-types")
    .description("List procurement type codes (ptype values)")
    .action(() => writeJson(PROCUREMENT_TYPES));

  return cmd;
}

function configCommand(): Command {
  return new Command("config")
    .description("Show current configuration (for debugging)")
    .action(() => {
      writeJson({
        version: VERSION,
        apiKey: process.env.SAM_API_KEY ? "set" : "unset",
        baseUrl: process.env.SAMCLI_BASE_URL ?? "https://api.sam.gov",
        userAgent: process.env.SAMCLI_USER_AGENT ?? "samcli/0.1 (+agent)",
      });
    });
}

// ---- Zod → plain JSON (best effort for introspection) ---------------------

/**
 * Render a zod schema as a plain JSON description. We deliberately do this
 * by hand for the shapes we actually use — a full zod-to-json-schema dep
 * would dwarf the rest of the binary.
 */
function zodToPlain(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(shape)) {
      out[key] = describeField(value);
    }
    return { type: "object", properties: out };
  }
  return { type: "unknown" };
}

function describeField(field: z.ZodTypeAny): Record<string, unknown> {
  let current = field;
  let optional = false;
  // Peel off Optional, Default, and Effects (refinements) to expose the
  // underlying base type. Order of wrappers is not significant.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      optional = true;
      current = current._def.innerType;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current._def.schema;
      continue;
    }
    break;
  }

  const entry: Record<string, unknown> = { optional };
  if (current instanceof z.ZodString) {
    entry.type = "string";
    for (const check of (current._def.checks ?? []) as Array<{
      kind: string;
      regex?: RegExp;
      message?: string;
    }>) {
      if (check.kind === "regex" && check.regex) {
        entry.pattern = check.regex.source;
      }
    }
  } else if (current instanceof z.ZodNumber) {
    entry.type = "number";
  } else if (current instanceof z.ZodEnum) {
    entry.type = "enum";
    entry.values = current._def.values;
  } else if (current instanceof z.ZodArray) {
    entry.type = "array";
  } else if (current instanceof z.ZodObject) {
    entry.type = "object";
  } else {
    entry.type = current._def.typeName ?? "unknown";
  }
  return entry;
}

// ---- Utilities -------------------------------------------------------------

function toIso(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---- Entry point -----------------------------------------------------------

const program = new Command("samcli")
  .version(VERSION)
  .description(
    "Agent-first CLI for SAM.gov contract opportunities. Outputs JSON by default when piped.",
  )
  .addHelpText(
    "after",
    `\nEnvironment:\n` +
      `  SAM_API_KEY        Required. Public API key from https://sam.gov.\n` +
      `  SAMCLI_BASE_URL    Override base URL (e.g. for alpha.sam.gov testing).\n` +
      `  SAMCLI_USER_AGENT  Override the HTTP User-Agent.\n`,
  );

program.addCommand(searchCommand());
program.addCommand(getCommand());
program.addCommand(describeCommand());
program.addCommand(schemaCommand());
program.addCommand(configCommand());

program.parseAsync(process.argv).catch(reportError);
