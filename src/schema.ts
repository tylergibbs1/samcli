/**
 * Zod schemas for SAM.gov Opportunities API.
 *
 * The schema layer is the single source of truth for what the CLI accepts.
 * It also powers runtime schema introspection (`samcli schema ...`).
 *
 * Agent-facing inputs are ISO (YYYY-MM-DD) dates and strict identifiers —
 * any translation to the wire format (MM/dd/yyyy) lives in client.ts.
 */
import { z } from "zod";

// ---- Enums -----------------------------------------------------------------

/** Procurement types accepted by the SAM.gov Opportunities API. */
export const PROCUREMENT_TYPES = {
  u: "Justification (J&A)",
  p: "Pre-solicitation",
  a: "Award Notice",
  r: "Sources Sought",
  s: "Special Notice",
  o: "Solicitation",
  g: "Sale of Surplus Property",
  k: "Combined Synopsis/Solicitation",
  i: "Intent to Bundle Requirements (DoD-Funded)",
} as const;

export const ProcurementType = z.enum(
  Object.keys(PROCUREMENT_TYPES) as [keyof typeof PROCUREMENT_TYPES],
);
export type ProcurementType = z.infer<typeof ProcurementType>;

/** Set-aside codes. */
export const SET_ASIDE_CODES = {
  SBA: "Total Small Business Set-Aside (FAR 19.5)",
  SBP: "Partial Small Business Set-Aside (FAR 19.5)",
  "8A": "8(a) Set-Aside (FAR 19.8)",
  "8AN": "8(a) Sole Source (FAR 19.8)",
  HZC: "HUBZone Set-Aside",
  HZS: "HUBZone Sole Source",
  SDVOSBC: "Service-Disabled Veteran-Owned Small Business Set-Aside",
  SDVOSBS: "SDVOSB Sole Source",
  WOSB: "Women-Owned Small Business Program Set-Aside",
  WOSBSS: "WOSB Program Sole Source",
  EDWOSB: "Economically Disadvantaged WOSB Set-Aside",
  EDWOSBSS: "EDWOSB Program Sole Source",
  LAS: "Local Area Set-Aside (FAR 26.2)",
  IEE: "Indian Economic Enterprise Set-Aside",
  ISBEE: "Indian Small Business Economic Enterprise Set-Aside",
  BICiv: "Buy Indian Set-Aside",
  VSA: "Veteran-Owned Small Business Set-Aside",
  VSS: "Veteran-Owned Small Business Sole Source",
} as const;

// ---- Primitive validators --------------------------------------------------

/**
 * Reject control characters (< 0x20) and DEL (0x7f). These usually indicate
 * hallucinated escapes or injected terminators rather than real input.
 *
 * Also requires `min(1)` — an empty-string filter would be silently dropped
 * by the client (`if (params.foo)` on falsy strings) and run an unfiltered
 * query, which is a surprising and dangerous fallthrough. Filter fields
 * are either absent or non-empty, never a blank string.
 *
 * Implemented with regex + min(1) on a plain `z.string()` so the result is
 * still a `ZodString` and `.max()` remains chainable.
 */
const NO_CONTROL = /^[^\x00-\x1f\x7f]+$/;
const noControlChars = (field: string) =>
  z.string().min(1, { message: `${field} must not be empty` }).regex(NO_CONTROL, {
    message: `${field} contains control characters`,
  });

/**
 * Reject characters that smuggle query params or fragments into an ID
 * (`?`, `#`, `%`) in addition to control chars. Hallucinated IDs sometimes
 * arrive pre-encoded. Also non-empty — see `noControlChars` for the reason.
 */
const STRICT_ID = /^[^\x00-\x1f\x7f?#%]+$/;
const strictIdentifier = (field: string) =>
  z.string().min(1, { message: `${field} must not be empty` }).regex(STRICT_ID, {
    message: `${field} contains control characters or any of ?, #, %`,
  });

/**
 * ISO 8601 date: YYYY-MM-DD.
 *
 * We validate that the string round-trips through Date — `Date.parse` alone
 * silently accepts invalid calendar dates like 2026-02-30 (coerces to March
 * 2), so we reconstruct the canonical ISO from UTC components and compare.
 */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be ISO format YYYY-MM-DD" })
  .refine(
    (s) => {
      const ms = Date.parse(s + "T00:00:00Z");
      if (Number.isNaN(ms)) return false;
      const d = new Date(ms);
      const canonical =
        d.getUTCFullYear().toString().padStart(4, "0") +
        "-" +
        (d.getUTCMonth() + 1).toString().padStart(2, "0") +
        "-" +
        d.getUTCDate().toString().padStart(2, "0");
      return canonical === s;
    },
    { message: "date is not a valid calendar date" },
  );
export type IsoDate = z.infer<typeof IsoDate>;

// ---- Search params schema --------------------------------------------------

/**
 * Normalized, agent-facing search parameters.
 *
 * Notable differences from the raw API:
 * - Dates are ISO (YYYY-MM-DD) and required by the API but defaulted by
 *   the CLI to "last 30 days" when omitted.
 * - `naicsCode` is validated as ≤6 digits up front.
 * - Field names mirror the API (camelCase) so agents familiar with the API
 *   docs can transfer knowledge 1:1.
 */
export const SearchParams = z.object({
  postedFrom: IsoDate.optional(),
  postedTo: IsoDate.optional(),
  responseDeadlineFrom: IsoDate.optional(),
  responseDeadlineTo: IsoDate.optional(),

  ptype: ProcurementType.optional(),
  solicitationNumber: strictIdentifier("solicitationNumber").max(64).optional(),
  noticeId: strictIdentifier("noticeId").max(64).optional(),
  title: noControlChars("title").max(500).optional(),
  state: z.string().regex(/^[A-Z]{2}$/, {
    message: "state must be a 2-letter uppercase code (e.g. CA)",
  }).optional(),
  zip: z.string().regex(/^\d{5}(\d{4})?$/, {
    message: "zip must be 5 or 9 digits",
  }).optional(),
  naicsCode: z.string().regex(/^\d{1,6}$/, {
    message: "naicsCode must be 1-6 digits",
  }).optional(),
  classificationCode: strictIdentifier("classificationCode").max(8).optional(),
  organizationCode: strictIdentifier("organizationCode").max(32).optional(),
  organizationName: noControlChars("organizationName").max(200).optional(),
  typeOfSetAside: z.enum(
    Object.keys(SET_ASIDE_CODES) as [keyof typeof SET_ASIDE_CODES],
  ).optional(),
  typeOfSetAsideDescription: noControlChars("typeOfSetAsideDescription")
    .max(200)
    .optional(),

  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
}).strict();

export type SearchParams = z.infer<typeof SearchParams>;

// ---- Response schemas ------------------------------------------------------

/**
 * Loose response schemas — the API sometimes omits or nests fields
 * inconsistently, so we validate the outer envelope strictly and pass the
 * opportunity objects through as `unknown` records. This preserves fields
 * we don't know about for the agent to use.
 */
export const SearchResponse = z.object({
  totalRecords: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  opportunitiesData: z.array(z.record(z.unknown())).default([]),
  links: z.array(z.record(z.unknown())).optional(),
}).passthrough();

export type SearchResponse = z.infer<typeof SearchResponse>;
