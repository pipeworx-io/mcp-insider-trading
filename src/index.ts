interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


// Reusable entity-resolution helpers for MCP packs. SELF-CONTAINED — no internal
// imports — so publish-pack.sh can inline it into standalone pack builds the same
// way it inlines the McpToolExport type.
//
// Recurring failure mode across financial packs: callers pass a company NAME
// ("Apple", "apple inc") where a ticker / CIK / provider symbol is expected, and
// the pack 404s or throws "not found". `rankMatches` is a generic name-ranker any
// pack can run over its OWN list (US tickers, B3 tickers, drug names, airports…);
// `resolveSecEntity` wraps it around the SEC company_tickers.json universe, shared
// by the packs that key on CIK (edgar, sec).

type MatchKind = 'exact' | 'prefix' | 'word' | 'substring';

interface RankedMatch<T> {
  item: T;
  kind: MatchKind;
  score: number;
}

const normalize = (s: string): string =>
  s.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Rank `items` by how well their name matches `query`:
 * exact (4) > prefix (3) > whole-word (2) > substring (1). Ties break by shortest
 * name — the primary entity (e.g. "Apple Inc." over "Apple Hospitality REIT").
 * Returns only items that match at all, best first. Pure (no I/O).
 */
function rankMatches<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
): RankedMatch<T>[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { item: T; kind: MatchKind; score: number; len: number }[] = [];
  for (const item of items) {
    const name = getName(item);
    const n = normalize(name);
    let kind: MatchKind | null = null;
    let score = 0;
    if (n === q) { kind = 'exact'; score = 4; }
    else if (n.startsWith(q)) { kind = 'prefix'; score = 3; }
    else if (n.includes(` ${q} `) || n.endsWith(` ${q}`)) { kind = 'word'; score = 2; }
    else if (n.includes(q)) { kind = 'substring'; score = 1; }
    if (kind) scored.push({ item, kind, score, len: name.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored.map(({ item, kind, score }) => ({ item, kind, score }));
}

interface SecTickerRow { cik_str: number; ticker: string; title: string }

interface SecEntity {
  ticker: string;
  cik: string;
  cik_padded: string;
  company_name: string;
  matched_by: 'ticker' | 'company_name';
  alternatives?: { ticker: string; company_name: string; cik: string }[];
}

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/**
 * Resolve a ticker OR company name to its SEC identity (CIK + canonical name).
 * Exact ticker first (the common, unambiguous case), then fuzzy company-name
 * fallback so "Apple" / "APPLE" → AAPL's CIK. Throws if nothing matches.
 *
 * `headers` lets callers pass their pack's SEC User-Agent — www.sec.gov requires
 * a UA. `fetchImpl` defaults to global fetch (override in tests).
 */
async function resolveSecEntity(
  query: string,
  opts: { fetchImpl?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<SecEntity> {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Required argument is missing or empty. Pass a ticker like "AAPL" or a company name like "Apple".');
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(SEC_TICKERS_URL, { headers: opts.headers });
  if (!res.ok) throw new Error(`SEC ticker lookup error: ${res.status}`);
  const data = (await res.json()) as Record<string, SecTickerRow>;
  const rows = Object.values(data);

  // 1) Exact ticker match — the common, unambiguous case.
  const q = query.toUpperCase().trim();
  for (const r of rows) {
    if (r.ticker === q) return toEntity(r, 'ticker');
  }

  // 2) Company-name fallback.
  const ranked = rankMatches(query, rows, (r) => r.title);
  if (ranked.length) {
    const best = toEntity(ranked[0].item, 'company_name');
    const alts = ranked.slice(1, 4).map((m) => ({
      ticker: m.item.ticker,
      company_name: m.item.title,
      cik: String(m.item.cik_str),
    }));
    if (alts.length) best.alternatives = alts;
    return best;
  }

  throw new Error(`No SEC company matches "${query}". Pass a US-listed ticker ("AAPL") or the exact listed-company name ("Apple Inc."). If this is a clinical-trial sponsor, an operating subsidiary (e.g. "Merck Sharp & Dohme" → Merck & Co), or a foreign/private entity, call sponsor_to_filer({sponsor}) instead — it resolves subsidiaries to the listed parent and honestly reports when no US-listed filer exists.`);
}

function toEntity(r: SecTickerRow, matched_by: 'ticker' | 'company_name'): SecEntity {
  return {
    ticker: r.ticker,
    cik: String(r.cik_str),
    cik_padded: String(r.cik_str).padStart(10, '0'),
    company_name: r.title,
    matched_by,
  };
}

const GENERIC_CORP_WORDS = new Set([
  'THE', 'A', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED',
  'LLC', 'LP', 'PLC', 'SA', 'AG', 'NV', 'GMBH', 'AB', 'AS', 'OY', 'SPA',
  'GROUP', 'HOLDINGS', 'HOLDING', 'AND', 'OF', 'US', 'USA', 'INTERNATIONAL',
  'GLOBAL',
]);

/**
 * Split a corporate/organization name into its SIGNIFICANT tokens — words
 * that aren't generic corporate boilerplate (Inc, Co, Ltd, Group, ...) or
 * punctuation — sorted LONGEST FIRST. Built for cross-registry name joins
 * where the two registries anchor on different words of the same name: SEC
 * lists Eli Lilly as "ELI LILLY & Co", but Drugs@FDA's sponsor_name field
 * uses "LILLY" — the longer, more distinctive token, not the first one
 * ("ELI" alone is short and matches too loosely). Pure (no I/O); callers
 * typically try tokens in order until one call to their OWN registry
 * returns a result.
 */
function significantNameTokens(name: string): string[] {
  const tokens = name
    .toUpperCase()
    .replace(/[.,&/()-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !GENERIC_CORP_WORDS.has(t));
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}
/**
 * Insider Trading MCP — SEC EDGAR insider filings and material events
 *
 * Uses SEC EDGAR full-text search (efts.sec.gov) directly (no scraping).
 *
 * Tools:
 * - insider_trades: Recent Form 4 insider transactions for a company
 * - insider_8k: Material events (8-K filings) for a company
 * - insider_13d: Activist investor filings (Schedule 13D/G) for a company
 * - insider_activity_summary: Combined insider activity overview
 *
 * How it selects a company (rewritten 2026-08-31, fleet #739):
 * - The ticker is resolved to a CIK (shared `resolveSecEntity`) and passed to
 *   efts as `ciks=`, so the SERVER selects the company. The previous version
 *   searched the ticker as free text and then kept hits whose `display_names`
 *   contained the ticker string. That filter is unreliable: efts writes the
 *   ticker into display_names for some hits and not others — an NVDA Form 4
 *   reads "NVIDIA CORP  (CIK 0001045810)" with NO ticker, while an NVDA 8-K
 *   reads "NVIDIA CORP  (NVDA)  (CIK 0001045810)". So Form 4 rows were dropped
 *   client-side while the count came from the unfiltered upstream total, and
 *   the tool answered `{total_form4_filings: 3, filings: []}` — a self-
 *   contradicting 200 with no error field.
 * - Counts now report what the tool DELIVERS. `total_*_filings` equals
 *   `filings.length`; the upstream total for the same filter is reported
 *   separately as `matched_*_filings` with a `truncated` flag, so a caller can
 *   still see there is more without being told rows exist that aren't there.
 * - efts caches on a key that OMITS `ciks`, so a filtered request can be served
 *   an unfiltered cached body as a clean 200. Every request carries a negated
 *   nonsense token derived from the CIK (`-zqfc<cik>`) to make the cache key
 *   unique, the echoed `query.query.bool.filter` is checked to confirm the CIK
 *   filter actually ran, and every row is re-checked against the CIK anyway.
 *   Same guard as mcps/sec-contracts.
 * - `forms` filters efts' ROOT form. Schedule 13D/G root forms are
 *   "SCHEDULE 13D" / "SCHEDULE 13G" — the older "SC 13D" tokens this pack used
 *   match nothing and returned 0 hits for every company, silently.
 * - `dateRange=custom` with only `startdt` is ignored by efts; both bounds are
 *   always sent.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Insider Trading');
}

const EFTS_BASE = 'https://efts.sec.gov/LATEST/search-index';
const UA = 'Pipeworx/1.0 (support@pipeworx.io)';
const EFTS_PAGE = 100; // efts returns up to 100 hits per page; `from` walks pages
const MAX_LIMIT = 200;

interface EdgarHit {
  _source: {
    ciks: string[];
    display_names: string[];
    file_date: string;
    form: string;
    adsh: string;
    file_type: string;
    file_description: string;
    items?: string[];
    period_ending?: string;
  };
}

interface EdgarSearchResult {
  hits: {
    total: { value: number };
    hits: EdgarHit[];
  };
  query?: { query?: { bool?: { filter?: unknown[] } } };
}

function padCik(cik: string): string {
  return cik.replace(/\D/g, '').padStart(10, '0');
}

const dayStart = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * One efts page for `forms` filed by `cikPadded` in the window. The negated
 * `-zqfc<cik>` token is a must_not that matches no document; its only job is to
 * put the CIK into efts' response-cache key, which efts itself does not do.
 */
async function eftsPage(
  cikPadded: string,
  forms: string,
  startdt: string,
  enddt: string,
  from: number,
): Promise<EdgarSearchResult> {
  const params = new URLSearchParams({
    q: ` -zqfc${cikPadded.replace(/\D/g, '')}`,
    forms,
    ciks: cikPadded,
    dateRange: 'custom',
    startdt,
    enddt,
  });
  if (from > 0) params.set('from', String(from));

  const res = await pwFetch(`${EFTS_BASE}?${params}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw await httpError(res, 'SEC EDGAR search error');
  return res.json() as Promise<EdgarSearchResult>;
}

/** Did the CIK filter we asked for actually run? efts always answers 200. */
function cikFilterRan(result: EdgarSearchResult, cikPadded: string): boolean {
  const filters = result.query?.query?.bool?.filter;
  if (!Array.isArray(filters)) return false;
  return filters.some((f) => {
    const terms = (f as { terms?: Record<string, unknown> })?.terms;
    const ciks = terms?.ciks;
    return Array.isArray(ciks) && ciks.some((c) => padCik(String(c)) === cikPadded);
  });
}

interface Fetched {
  hits: EdgarHit[];
  matchedTotal: number;
  filterRan: boolean;
}

/** Walk efts pages until `limit` rows are held or the result set is exhausted. */
async function eftsFetch(
  cikPadded: string,
  forms: string,
  days: number,
  limit: number,
): Promise<Fetched> {
  const startdt = dayStart(days);
  const enddt = today();
  const want = Math.min(Math.max(1, limit), MAX_LIMIT);

  const first = await eftsPage(cikPadded, forms, startdt, enddt, 0);
  const filterRan = cikFilterRan(first, cikPadded);
  const matchedTotal = first.hits.total.value;
  const hits = [...first.hits.hits];

  for (let from = EFTS_PAGE; hits.length < want && from < matchedTotal; from += EFTS_PAGE) {
    const page = await eftsPage(cikPadded, forms, startdt, enddt, from);
    if (!page.hits.hits.length) break;
    hits.push(...page.hits.hits);
  }

  // Re-check every row against the CIK regardless: efts has been observed
  // serving an unfiltered cached body for a filtered request.
  const kept = hits.filter((h) => (h._source.ciks ?? []).some((c) => padCik(c) === cikPadded));
  return { hits: kept.slice(0, want), matchedTotal, filterRan };
}

/** Ticker / company name / CIK → SEC identity, or a caller-readable refusal. */
async function resolveCompany(query: string) {
  const q = String(query ?? '').trim();
  if (!q) {
    return {
      ok: false as const,
      body: {
        found: false,
        reason: 'missing_ticker',
        hint: 'Pass a US-listed ticker such as {"ticker":"NVDA"}, or the listed company name ("NVIDIA Corp").',
      },
    };
  }
  if (/^\d{1,10}$/.test(q)) {
    return { ok: true as const, cik: padCik(q), ticker: q.toUpperCase(), company_name: null as string | null };
  }
  try {
    const ent = await resolveSecEntity(q, { headers: { 'User-Agent': UA } });
    return { ok: true as const, cik: ent.cik_padded, ticker: ent.ticker, company_name: ent.company_name };
  } catch {
    return {
      ok: false as const,
      body: {
        found: false,
        ticker: q.toUpperCase(),
        reason: 'unresolved_company',
        hint: `No US-listed SEC filer matches "${q}". Form 4 / 8-K / 13D data exists only for SEC registrants — pass a US-listed ticker ("NVDA") or the exact registrant name. For a non-US issuer try edgar_search_filings, or dart_kr / companies-house for local registries.`,
      },
    };
  }
}

/** efts sometimes omits the ticker from display_names, so pick by CIK. */
function counterpartyName(h: EdgarHit, issuerCik: string): string {
  const names = h._source.display_names ?? [];
  const ciks = h._source.ciks ?? [];
  for (let i = 0; i < names.length; i++) {
    if (padCik(ciks[i] ?? '') !== issuerCik) return names[i];
  }
  return names[0] ?? 'Unknown';
}

function filingUrl(h: EdgarHit): string {
  const cik = (h._source.ciks?.[0] ?? '').replace(/^0+/, '');
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${h._source.adsh.replace(/-/g, '')}/${h._source.adsh}-index.htm`;
}

// Map 8-K item codes to descriptions
const ITEM_DESCRIPTIONS: Record<string, string> = {
  '1.01': 'Entry into Material Agreement',
  '1.02': 'Termination of Material Agreement',
  '1.03': 'Bankruptcy or Receivership',
  '2.01': 'Completion of Acquisition/Disposition',
  '2.02': 'Results of Operations and Financial Condition',
  '2.03': 'Creation of Direct Financial Obligation',
  '2.04': 'Triggering Events (Acceleration of Obligations)',
  '2.05': 'Costs of Exit/Disposal Activities',
  '2.06': 'Material Impairments',
  '3.01': 'Notice of Delisting',
  '3.02': 'Unregistered Sales of Equity',
  '3.03': 'Material Modification of Rights',
  '4.01': 'Changes in Registrant Certifying Accountant',
  '4.02': 'Non-Reliance on Previously Issued Financials',
  '5.01': 'Changes in Control',
  '5.02': 'Departure/Election of Directors/Officers',
  '5.03': 'Amendments to Articles/Bylaws',
  '5.07': 'Submission of Matters to Vote',
  '7.01': 'Regulation FD Disclosure',
  '8.01': 'Other Events',
  '9.01': 'Financial Statements and Exhibits',
};

/** Shared envelope: the count IS the row count; upstream's total is separate. */
function envelope(
  countKey: string,
  matchedKey: string,
  ident: { cik: string; ticker: string; company_name: string | null },
  days: number,
  fetched: Fetched,
  rows: unknown[],
) {
  return {
    ticker: ident.ticker.toUpperCase(),
    cik: ident.cik.replace(/^0+/, ''),
    ...(ident.company_name ? { company_name: ident.company_name } : {}),
    period: `last ${days} days`,
    [countKey]: rows.length,
    [matchedKey]: fetched.matchedTotal,
    truncated: fetched.matchedTotal > rows.length,
    ...(fetched.filterRan ? {} : { upstream_filter_unconfirmed: true }),
    filings: rows,
  };
}

async function getInsiderTrades(ticker: string, days = 365, limit = 20) {
  const ident = await resolveCompany(ticker);
  if (!ident.ok) return ident.body;

  const fetched = await eftsFetch(ident.cik, '4', days, limit);
  const rows = fetched.hits.map((h) => ({
    date: h._source.file_date,
    filer: counterpartyName(h, ident.cik),
    form: h._source.form,
    accession: h._source.adsh,
    filing_url: filingUrl(h),
  }));

  return envelope('total_form4_filings', 'matched_form4_filings', ident, days, fetched, rows);
}

async function get8kFilings(ticker: string, days = 180, limit = 15) {
  const ident = await resolveCompany(ticker);
  if (!ident.ok) return ident.body;

  const fetched = await eftsFetch(ident.cik, '8-K', days, limit);
  const rows = fetched.hits.map((h) => ({
    date: h._source.file_date,
    company: h._source.display_names[0] ?? 'Unknown',
    items: (h._source.items ?? []).map((code) => ({
      code,
      description: ITEM_DESCRIPTIONS[code] ?? code,
    })),
    accession: h._source.adsh,
    filing_url: filingUrl(h),
  }));

  return envelope('total_8k_filings', 'matched_8k_filings', ident, days, fetched, rows);
}

async function get13dFilings(ticker: string, days = 365, limit = 10) {
  const ident = await resolveCompany(ticker);
  if (!ident.ok) return ident.body;

  // Root form tokens, not the display forms: "SCHEDULE 13D" covers 13D and
  // 13D/A. The legacy "SC 13D" spelling matches zero documents.
  const fetched = await eftsFetch(ident.cik, 'SCHEDULE 13D,SCHEDULE 13G', days, limit);
  const rows = fetched.hits.map((h) => ({
    date: h._source.file_date,
    filer: counterpartyName(h, ident.cik),
    form: h._source.form,
    accession: h._source.adsh,
    filing_url: filingUrl(h),
  }));

  return {
    ...envelope('total_13d_filings', 'matched_13d_filings', ident, days, fetched, rows),
    description:
      'Schedule 13D/G filings indicate ownership of 5%+ of a company. 13D signals activist intent; 13G signals passive investment.',
  };
}

async function activitySummary(ticker: string) {
  const ident = await resolveCompany(ticker);
  if (!ident.ok) return ident.body;

  // Fetch exactly what the overview shows, so each count below is the length of
  // the array beside it rather than a larger fetch that was then sliced.
  const [trades, events, activists] = await Promise.all([
    eftsFetch(ident.cik, '4', 90, 5).catch(() => null),
    eftsFetch(ident.cik, '8-K', 90, 3).catch(() => null),
    eftsFetch(ident.cik, 'SCHEDULE 13D,SCHEDULE 13G', 365, 3).catch(() => null),
  ]);

  const tradeRows = (trades?.hits ?? []).map((h) => ({
    date: h._source.file_date,
    filer: counterpartyName(h, ident.cik),
    form: h._source.form,
    accession: h._source.adsh,
    filing_url: filingUrl(h),
  }));
  const eventRows = (events?.hits ?? []).map((h) => ({
    date: h._source.file_date,
    company: h._source.display_names[0] ?? 'Unknown',
    items: (h._source.items ?? []).map((code) => ({ code, description: ITEM_DESCRIPTIONS[code] ?? code })),
    accession: h._source.adsh,
    filing_url: filingUrl(h),
  }));
  const activistRows = (activists?.hits ?? []).map((h) => ({
    date: h._source.file_date,
    filer: counterpartyName(h, ident.cik),
    form: h._source.form,
    accession: h._source.adsh,
    filing_url: filingUrl(h),
  }));

  return {
    ticker: ident.ticker.toUpperCase(),
    cik: ident.cik.replace(/^0+/, ''),
    ...(ident.company_name ? { company_name: ident.company_name } : {}),
    // Each count is the length of the array beside it. Where the upstream set is
    // larger than what is returned, `*_matched` says so rather than the count
    // quietly overstating the rows. Call insider_trades / insider_8k /
    // insider_13d with a `limit` to page past the overview's fixed few rows.
    summary: {
      insider_trades_90d: tradeRows.length,
      insider_trades_90d_matched: trades?.matchedTotal ?? 0,
      material_events_90d: eventRows.length,
      material_events_90d_matched: events?.matchedTotal ?? 0,
      activist_filings_1y: activistRows.length,
      activist_filings_1y_matched: activists?.matchedTotal ?? 0,
      ...(trades === null || events === null || activists === null
        ? { partial: true, note: 'One or more EDGAR sub-queries failed; the missing sections read as 0.' }
        : {}),
    },
    recent_insider_trades: tradeRows,
    recent_8k_events: eventRows,
    activist_filings: activistRows,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'insider_trades',
    description:
      'SEC Form 4 insider transaction filings for a US-listed company: filing date, the officer/director/10%-owner who filed, and a link to the filing on EDGAR. Answers who at a company has been buying or selling its stock recently. Ticker or company name is resolved to a CIK, so results are that issuer\'s filings.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker: { type: 'string', description: 'Stock ticker ("AAPL", "NVDA"), company name ("NVIDIA Corp"), or CIK' },
        days: { type: 'number', description: 'Look back period in days (default: 365)' },
        limit: { type: 'number', description: 'Max filings to return (default: 20, max 200)' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'insider_8k',
    description:
      'SEC Form 8-K material event filings for a US-listed company, with the 8-K item codes decoded (earnings release, acquisition completed, officer departure, material agreement, delisting notice…). Answers what significant corporate events a company has disclosed and when.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker: { type: 'string', description: 'Stock ticker ("AAPL"), company name, or CIK' },
        days: { type: 'number', description: 'Look back period in days (default: 180)' },
        limit: { type: 'number', description: 'Max filings to return (default: 15, max 200)' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'insider_13d',
    description:
      'SEC Schedule 13D and 13G beneficial-ownership filings naming a US-listed company: which fund or investor crossed 5% ownership, on what date, and a link to the filing. 13D signals activist intent, 13G passive. Answers who has accumulated a large stake in a company.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker: { type: 'string', description: 'Stock ticker ("AAPL"), company name, or CIK' },
        days: { type: 'number', description: 'Look back period in days (default: 365)' },
        limit: { type: 'number', description: 'Max filings to return (default: 10, max 200)' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'insider_activity_summary',
    description:
      'One-call SEC filing overview for a US-listed company: Form 4 insider transactions and 8-K material events from the last 90 days plus Schedule 13D/G stake filings from the last year, with counts and the most recent rows of each. Answers what has been happening at a company lately, for quick due diligence.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker: { type: 'string', description: 'Stock ticker ("AAPL", "TSLA", "NVDA"), company name, or CIK' },
      },
      required: ['ticker'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'insider_trades':
      return getInsiderTrades(args.ticker as string, (args.days as number) ?? 365, (args.limit as number) ?? 20);
    case 'insider_8k':
      return get8kFilings(args.ticker as string, (args.days as number) ?? 180, (args.limit as number) ?? 15);
    case 'insider_13d':
      return get13dFilings(args.ticker as string, (args.days as number) ?? 365, (args.limit as number) ?? 10);
    case 'insider_activity_summary':
      return activitySummary(args.ticker as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
