// site-stats: yesterday's visitor numbers for brokenrecords.com from Cloudflare, run by cron
// at 11:55 UTC (before the 7 AM Central morning report). Saves one sync_runs row with
// source 'site-stats'; the morning report reads the newest one.
//
// Two kinds of numbers:
//   humans: Cloudflare Web Analytics (the beacon script in Base.astro). Counts only real
//           browsers that run JavaScript, with Cloudflare's bot filter on. This is the real
//           audience number.
//   edge:   every page Cloudflare served, crawlers included (the number in Cloudflare's
//           "10,000 pageviews" email). Shown only for comparison.
//
// "Yesterday" is the previous calendar day in America/Chicago.
//
// Locked like mail-jobs: the request must carry the x-job-secret header (cron reads it from
// job_secrets). Body (JSON, all optional):
//   { "dryRun": true }   compute and return, write nothing
//   { "daysAgo": 2 }     report an earlier day instead of yesterday (1 = yesterday)
//
// Secret: CLOUDFLARE_ANALYTICS_TOKEN, an API token with Account > Account Analytics > Read
// (required) and Zone > Analytics > Read + Zone > Zone > Read for brokenrecords.com
// (only for the edge comparison).
import { createClient } from "npm:@supabase/supabase-js@2";

const ACCOUNT = "f60022de828a50b44c61e552f8fd5281"; // Mohr Creative Group
const HOST = "brokenrecords.com";
const TZ = "America/Chicago";
const TOKEN = Deno.env.get("CLOUDFLARE_ANALYTICS_TOKEN");

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });

// Minutes to add to UTC to get Chicago time at instant d (for example -360 in winter).
function tzOffset(d: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - d.getTime()) / 60000);
}

// Chicago calendar date (YYYY-MM-DD) n days before today, and the UTC instant of its midnight.
function chicagoDay(daysAgo: number): { day: string; start: Date } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d - daysAgo); // midnight on the wall clock, as if it were UTC
  let start = new Date(wall - tzOffset(new Date(wall + 12 * 3600_000)) * 60000);
  start = new Date(wall - tzOffset(start) * 60000); // second pass fixes the DST-change days
  return { day: new Date(wall).toISOString().slice(0, 10), start };
}

async function cf(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`Cloudflare ${path} HTTP ${r.status}`);
  return j;
}

async function gql(query: string) {
  const j = await cf("/graphql", { method: "POST", body: JSON.stringify({ query }) });
  if (j.errors?.length) throw new Error(j.errors.map((e: { message: string }) => e.message).join("; ").slice(0, 400));
  return j.data;
}

type Row = { count: number; sum?: { visits?: number }; dimensions?: Record<string, string> };

// Web Analytics numbers for one window. withBot=false drops the bot filter if the API rejects it.
async function humans(s: string, e: string, withBot: boolean) {
  const f = `{datetime_geq:${JSON.stringify(s)}, datetime_lt:${JSON.stringify(e)}, requestHost:${JSON.stringify(HOST)}${withBot ? ", bot:0" : ""}}`;
  const group = (alias: string, dim: string, limit: number) =>
    `${alias}: rumPageloadEventsAdaptiveGroups(limit:${limit}, filter:${f}, orderBy:[count_DESC]) { count sum { visits } dimensions { ${dim} } }`;
  const data = await gql(`{ viewer { accounts(filter:{accountTag:${JSON.stringify(ACCOUNT)}}) {
    total: rumPageloadEventsAdaptiveGroups(limit:1, filter:${f}) { count sum { visits } }
    ${group("pages", "requestPath", 8)}
    ${group("referers", "refererHost", 8)}
    ${group("countries", "countryName", 6)}
    ${group("devices", "deviceType", 4)}
    ${group("hours", "datetimeHour", 200)}
  } } }`);
  const a = data.viewer.accounts[0] ?? {};
  const list = (rows: Row[] | undefined, dim: string) =>
    (rows ?? []).map((r) => ({ [dim]: r.dimensions?.[dim] || "(none)", pageviews: r.count, visits: r.sum?.visits ?? 0 }));
  const t: Row | undefined = a.total?.[0];
  return {
    visits: t?.sum?.visits ?? 0,
    pageviews: t?.count ?? 0,
    top_pages: list(a.pages, "requestPath"),
    top_referrers: list(a.referers, "refererHost").filter((r) => r.refererHost !== HOST && r.refererHost !== `www.${HOST}`),
    countries: list(a.countries, "countryName"),
    devices: list(a.devices, "deviceType"),
    hours: (a.hours ?? []) as Row[],
  };
}

async function edge(s: string, e: string) {
  const z = await cf(`/zones?name=${HOST}`);
  const zoneId = z.result?.[0]?.id;
  if (!zoneId) throw new Error(`zone lookup failed: ${JSON.stringify(z.errors ?? z).slice(0, 200)}`);
  const data = await gql(`{ viewer { zones(filter:{zoneTag:${JSON.stringify(zoneId)}}) {
    httpRequests1hGroups(limit:48, filter:{datetime_geq:${JSON.stringify(s)}, datetime_lt:${JSON.stringify(e)}}) { sum { requests pageViews } }
  } } }`);
  const rows = data.viewer.zones[0]?.httpRequests1hGroups ?? [];
  return rows.reduce(
    (acc: { pageviews: number; requests: number }, r: { sum: { requests: number; pageViews: number } }) =>
      ({ pageviews: acc.pageviews + r.sum.pageViews, requests: acc.requests + r.sum.requests }),
    { pageviews: 0, requests: 0 },
  );
}

async function collect(daysAgo: number) {
  if (!TOKEN) throw new Error("CLOUDFLARE_ANALYTICS_TOKEN is not set");
  const day = chicagoDay(daysAgo);
  const end = chicagoDay(daysAgo - 1).start;
  const weekStart = chicagoDay(daysAgo + 6).start;
  const s = day.start.toISOString(), e = end.toISOString();
  const notes: string[] = [];

  let withBot = true;
  let y;
  try { y = await humans(s, e, true); }
  catch (err) {
    if (!/bot/i.test(String(err))) throw err;
    withBot = false;
    notes.push("Web Analytics bot filter not accepted by the API; human numbers include any bots that run JavaScript.");
    y = await humans(s, e, false);
  }

  // Daily visits for the 7 Chicago days ending on the report day, from hourly buckets.
  const w = await humans(weekStart.toISOString(), e, withBot);
  const byDay = new Map<string, { visits: number; pageviews: number }>();
  for (let i = 6; i >= 0; i--) byDay.set(chicagoDay(daysAgo + i).day, { visits: 0, pageviews: 0 });
  for (const h of w.hours) {
    const t = new Date(h.dimensions?.datetimeHour ?? "");
    const local = new Date(t.getTime() + tzOffset(t) * 60000).toISOString().slice(0, 10);
    const b = byDay.get(local);
    if (b) { b.visits += h.sum?.visits ?? 0; b.pageviews += h.count; }
  }

  let edgeStats: { pageviews: number; requests: number } | { error: string };
  try { edgeStats = await edge(s, e); }
  catch (err) { edgeStats = { error: String((err as Error).message ?? err).slice(0, 300) }; }

  const { hours: _h, ...humansOut } = y;
  return {
    day: day.day,
    window: { start: s, end: e, time_zone: TZ },
    humans: humansOut,
    last_7_days: [...byDay].map(([d, v]) => ({ day: d, ...v })),
    edge: edgeStats,
    notes,
  };
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: secret } = await sb.from("job_secrets").select("value").eq("key", "jobs").maybeSingle();
  if (!secret?.value || req.headers.get("x-job-secret") !== secret.value) return json({ error: "Not allowed" }, 401);

  const dryRun = body.dryRun === true;
  const daysAgo = Number.isInteger(body.daysAgo) && body.daysAgo >= 1 && body.daysAgo <= 30 ? body.daysAgo : 1;
  const started = new Date().toISOString();
  try {
    const stats = await collect(daysAgo);
    if (!dryRun) await sb.from("sync_runs").insert({ source: "site-stats", dry_run: false, started_at: started, finished_at: new Date().toISOString(), stats });
    return json({ ok: true, dryRun, stats });
  } catch (e) {
    const error = String((e as Error).message ?? e).slice(0, 400);
    if (!dryRun) await sb.from("sync_runs").insert({ source: "site-stats", dry_run: false, started_at: started, finished_at: new Date().toISOString(), error });
    return json({ ok: false, error }, 500);
  }
});
