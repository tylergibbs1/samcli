# samcli

An agent-first CLI for the [SAM.gov Opportunities Public API v2](https://open.gsa.gov/api/get-opportunities-public-api/).

Built so AI agents can search federal contract opportunities with predictable
JSON output, strict input validation, and safe defaults. Humans can use it
too — it prints a table when stdout is a TTY.

## Install

```bash
git clone <this repo>
cd samcli
npm install
npm run build
npm link   # makes `samcli` available globally
```

Requires Node 18+.

## Auth

Get a public API key from [sam.gov](https://sam.gov) → Account Details → API Key.
Export it:

```bash
export SAM_API_KEY=xxxxxxxxxxxxxxxx
```

Check status:

```bash
samcli config
```

## Quick examples

```bash
# Recent IT-services opportunities in Virginia (last 30 days by default)
samcli search --naics 541519 --state VA --limit 25 \
  --fields "noticeId,title,type,postedDate,responseDeadLine"

# Small-business set-aside awards in Q1 2026
samcli search --set-aside SBA --ptype a \
  --posted-from 2026-01-01 --posted-to 2026-03-31 --limit 100

# Preview a request without spending daily quota
samcli search --naics 541519 --dry-run

# Fetch a single opportunity by notice ID
samcli get ea55e45cded123fd8d6afd7c061138f0

# Fetch the description text
samcli describe ea55e45cded123fd8d6afd7c061138f0

# Stream all pages as NDJSON
samcli search --naics 541519 --page-all --fields "noticeId,title,award.amount" > results.ndjson

# Introspect schemas at runtime
samcli schema search
samcli schema set-asides
samcli schema procurement-types
```

## Agent-first design choices

- **JSON by default when piped.** TTY output is a table, non-TTY is JSON.
- **ISO dates in, MM/dd/yyyy out.** Agents never deal with the API's format.
- **Sensible defaults.** `postedFrom/postedTo` default to the last 30 days;
  `--limit` defaults to 25 (the API's native default is 1).
- **Hard input validation at the boundary.** Control characters, embedded
  query params, malformed IDs, and bad date formats fail fast with
  machine-readable error codes.
- **364-day range enforced client-side.** The docs say "1 year" but SAM.gov
  rejects exactly-365-day ranges with a broken error template. The CLI caps
  at 364 days so you get `INVALID_DATE_RANGE` with a useful message instead.
- **Field masks.** `--fields "noticeId,title,award.amount"` limits response
  payloads so they don't blow out the agent's context window.
- **`--dry-run`** — preview the request (with API key redacted) without
  calling the API, so agents can validate params without spending quota.
- **Runtime schema introspection.** `samcli schema search` dumps the full
  input schema. Agents don't need to read docs.
- **Machine-readable errors.** JSON envelope on stderr with stable `code`
  values (`INVALID_INPUT`, `NOT_FOUND`, `RATE_LIMITED`, etc.).

See [`SKILL.md`](./SKILL.md) for the agent-facing usage guide.

## Commands

| Command | What it does |
|---|---|
| `samcli search` | Search opportunities (flags or `--json` payload) |
| `samcli get <noticeId>` | Fetch a single opportunity |
| `samcli describe <noticeId>` | Fetch the full description text |
| `samcli schema <topic>` | Introspect schemas (`search`, `set-asides`, `procurement-types`) |
| `samcli config` | Show effective configuration |

## Environment variables

| Var | Purpose |
|---|---|
| `SAM_API_KEY` | **Required.** API key from sam.gov |
| `SAMCLI_BASE_URL` | Override base URL (e.g. `https://api-alpha.sam.gov` for testing) |
| `SAMCLI_USER_AGENT` | Override the HTTP User-Agent |

## Scope

This CLI covers the SAM.gov Opportunities API v2 only. Other SAM.gov APIs
(Entity Management, Exclusions, Assistance Listings, Wage Determinations)
are out of scope for this release.
