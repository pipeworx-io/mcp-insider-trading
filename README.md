# @pipeworx/insider-trading

SEC EDGAR insider and ownership filings for US-listed companies — Form 4 insider
transactions, 8-K material events, and Schedule 13D/G stake filings — read live
from EDGAR full-text search.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

| Tool | Returns |
|---|---|
| `insider_trades` | Form 4 filings: date, the officer/director/10%-owner who filed, form, accession, EDGAR link |
| `insider_8k` | 8-K filings with item codes decoded (earnings, acquisitions, officer departures, delistings…) |
| `insider_13d` | Schedule 13D/G beneficial-ownership filings: which investor crossed 5%, when, and the filing link |
| `insider_activity_summary` | All three in one call — 90 days of Form 4 and 8-K, one year of 13D/G, with counts |

All four take `ticker`, which also accepts a company name (`"NVIDIA Corp"`) or a
bare CIK. `insider_trades` / `insider_8k` / `insider_13d` also take `days` and
`limit` (max 200).

### Counts mean what they say

`total_*_filings` is the number of rows in `filings` — the two always agree.
The upstream total for the same company and window is reported separately as
`matched_*_filings`, with `truncated: true` when it is larger. Raise `limit` to
retrieve the rest. (Before 2026-08-31 the count was the upstream total and the
rows were a client-side-filtered subset, so the tool could answer
`{total_form4_filings: 3, filings: []}` as a clean 200 — fleet #739.)

A ticker with no matching SEC registrant returns
`{found: false, reason: "unresolved_company", hint}` rather than throwing, so an
agent can recover. `reason: "missing_ticker"` means the argument was empty.

## Auth

None. EDGAR is keyless. SEC fair-access rules require a descriptive
`User-Agent`, which the pack sends; requests are subject to SEC's ~10 req/s
per-IP limit, so a burst of parallel calls can transiently fail.

## Data sources

- EDGAR full-text search — `https://efts.sec.gov/LATEST/search-index`
  (`forms`, `ciks`, `dateRange=custom` + `startdt`/`enddt`, `from` for paging)
- SEC company ticker universe — `https://www.sec.gov/files/company_tickers.json`
  (ticker/name → CIK, via `resolveSecEntity` in `@pipeworx/shared`)
- Filing documents — `https://www.sec.gov/Archives/edgar/data/<cik>/…` (linked, not fetched)

### Upstream gotchas worth knowing

- **`forms` filters the ROOT form.** Schedule 13D/G root forms are
  `SCHEDULE 13D` / `SCHEDULE 13G`; the legacy `SC 13D` spelling matches zero
  documents and returns a silent empty result.
- **efts caches on a key that omits `ciks`**, so a filtered request can be served
  an unfiltered cached body as a 200. Every request here carries a negated
  nonsense token (`-zqfc<cik>`) to make the cache key unique, checks the echoed
  `query.query.bool.filter`, and re-checks each row against the CIK.
- **`dateRange=custom` with only `startdt` is silently ignored** — both bounds
  are always sent.
- **`display_names` carries the ticker inconsistently.** An NVDA Form 4 reads
  `NVIDIA CORP  (CIK 0001045810)` while an NVDA 8-K reads
  `NVIDIA CORP  (NVDA)  (CIK 0001045810)`. Never select a company by matching
  the ticker against that string; filter server-side on `ciks`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "insider-trading": {
      "url": "https://gateway.pipeworx.io/insider-trading/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/insider-trading/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/insider_trades \
  -H 'Content-Type: application/json' \
  -d '{"ticker":"NVDA","days":30}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/insider_trades`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "insider-trading": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-insider-trading"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-insider-trading
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Insider Trading data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
