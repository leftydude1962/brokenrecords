// News watcher: once a day, asks Perplexity's web-search model which world records were
// newly set or ratified, then checks each claim before anything reaches the site.
//
// A claim goes live by itself only when ALL of these hold:
//   1. It updates a record we already track (matched by slug).
//   2. It uses the same unit as that record.
//   3. It beats the current value in the right direction.
//   4. It is within 25% of the current value (catches unit and parsing mistakes).
//   5. At least two DIFFERENT websites among the search citations back it.
// Everything else waits in the candidates table for review.
import { createClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("PERPLEXITY_API_KEY") ?? Deno.env.get("PERPLEXITY_AI_KEY");
const AUTO_PUBLISH = (Deno.env.get("NEWS_AUTO_PUBLISH") ?? "true") !== "false";
const ENDPOINT = "https://api.perplexity.ai/v1/sonar";

// Categories are grouped so one search covers related areas. 10 searches a day, one per
// scheduled call, spaced a few minutes apart.
const GROUPS: Record<string, string[]> = {
  athletics: ["sprinting", "marathon", "athletics"],
  water_ice: ["swimming", "speed-skating", "olympics"],
  baseball_football: ["baseball", "football"],
  basketball_hockey: ["basketball", "hockey"],
  soccer_tennis_golf: ["soccer", "tennis", "golf"],
  music_movies: ["music", "movies"],
  earth: ["weather", "nature", "structures", "buildings", "bridges"],
  people_speed_space: ["people", "animals", "speed", "space"],
  college_motorsports: ["college-sports", "motorsports"],
  money_internet_games: ["money", "internet", "games"],
};

type Rec = { id: string; slug: string; title: string; holder: string | null; value_numeric: number | null; value_text: string | null; unit: string | null; better_direction: "higher" | "lower" | null; achieved_on: string | null; category_id: string; location: string | null; governing_body: string | null };
type Item = { record_slug: string | null; title: string; holder: string; value_numeric: number; unit: string; value_text: string; achieved_on: string | null; category_slug: string; source_urls: string[] };

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          record_slug: { type: ["string", "null"] },
          title: { type: "string" },
          holder: { type: "string" },
          value_numeric: { type: "number" },
          unit: { type: "string" },
          value_text: { type: "string" },
          achieved_on: { type: ["string", "null"] },
          category_slug: { type: "string" },
          source_urls: { type: "array", items: { type: "string" } },
        },
        required: ["record_slug", "title", "holder", "value_numeric", "unit", "value_text", "achieved_on", "category_slug", "source_urls"],
      },
    },
  },
  required: ["items"],
};

// "www.nbcsports.com" and "nbcsports.com/x" count as one website.
function site(url: string): string | null {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const p = h.split(".");
    const twoPartTld = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(p.slice(-2).join("."));
    return p.slice(twoPartTld ? -3 : -2).join(".");
  } catch { return null; }
}

function beats(newV: number, oldV: number, dir: string | null) {
  return dir === "lower" ? newV < oldV : newV > oldV;
}

async function askPerplexity(categories: string[], records: Rec[], recency: string) {
  const list = records.map((r) => `${r.slug} | ${r.title} | ${r.holder} | ${r.value_numeric} ${r.unit}`).join("\n");
  const system =
    "You track official world records. Report only records that were newly SET or officially RATIFIED in the requested time window, " +
    "recognized by the sport's governing body or by an authoritative organization, and reported by reputable outlets. " +
    "Never report a record that is merely threatened, approached, or tied unless it is officially shared. Never invent values. " +
    "If nothing qualifies, return an empty items list.";
  const user =
    `Time window: the past ${recency}. Areas: ${categories.join(", ")}.\n\n` +
    `Records we already track (slug | title | holder | value unit):\n${list}\n\n` +
    "For each qualifying new record: set record_slug to the matching slug from the list if it is a new value for a record we track, otherwise null. " +
    "Use the SAME unit as the tracked record (times in seconds 's', distances in metres 'm', speeds in 'km/h', counts as the plural noun used above). " +
    "category_slug must be one of: " + categories.join(", ") + ". achieved_on as YYYY-MM-DD or null. " +
    "source_urls: the URLs of the articles you relied on.";
  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      search_recency_filter: recency,
      response_format: { type: "json_schema", json_schema: { name: "records", schema: SCHEMA } },
    }),
    signal: AbortSignal.timeout(110_000),
    });
    if (res.status !== 429) break;
    // Rate limited: wait 5, 10, then 20 seconds before trying again.
    await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
  }
  const text = await res!.text();
  if (!res!.ok) throw new Error(`Perplexity ${res!.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  const content = j?.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content.replace(/^```(json)?|```$/g, "").trim());
  const cited = new Set<string>([...(j.citations ?? []), ...((j.search_results ?? []).map((s: { url: string }) => s.url))]);
  return { items: (parsed.items ?? []) as Item[], cited, cost: Number(j?.usage?.cost?.total_cost ?? 0) };
}

Deno.serve(async (req) => {
  if (!KEY) return Response.json({ error: "Perplexity key secret is not set" }, { status: 500 });
  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const recency = ["day", "week", "month"].includes(body?.recency) ? body.recency : "day";
  const groupNames: string[] = Array.isArray(body?.groups) ? body.groups.filter((g: string) => g in GROUPS) : Object.keys(GROUPS);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // The trigger key is public, so each group can run for real at most once every 6 hours.
  const source = `news:${groupNames.join("+")}`;
  if (!dryRun) {
    const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const { data: recent } = await sb.from("sync_runs").select("id").eq("source", source).eq("dry_run", false).gt("started_at", since).limit(1);
    if (recent?.length) return Response.json({ error: "rate_limited", detail: `${source} ran in the last 6 hours.` }, { status: 429 });
  }
  const { data: run } = await sb.from("sync_runs").insert({ source, dry_run: dryRun }).select("id").single();

  const { data: cats } = await sb.from("categories").select("id,slug");
  const catId = new Map((cats ?? []).map((c) => [c.slug, c.id]));
  const { data: allRecs } = await sb.from("records").select("id,slug,title,holder,value_numeric,value_text,unit,better_direction,achieved_on,category_id,location,governing_body").eq("status", "published");
  const bySlug = new Map((allRecs ?? []).map((r) => [r.slug, r as Rec]));

  // One group at a time: Perplexity limits how many searches can run at once.
  const results = [];
  for (const g of groupNames) results.push(await (async () => {
    const slugs = GROUPS[g];
    const ids = new Set(slugs.map((s) => catId.get(s)).filter(Boolean));
    const recs = (allRecs ?? []).filter((r) => ids.has(r.category_id)) as Rec[];
    try {
      const { items, cited, cost } = await askPerplexity(slugs, recs, recency);
      const outcomes = [];
      for (const it of items) outcomes.push(await handle(sb, it, cited, bySlug, catId, dryRun));
      return { group: g, found: items.length, cost, outcomes };
    } catch (e) {
      return { group: g, error: (e as Error).message };
    }
  })());

  const totalCost = results.reduce((s, r) => s + (("cost" in r && r.cost) || 0), 0);
  if (run?.id) await sb.from("sync_runs").update({ finished_at: new Date().toISOString(), stats: { recency, totalCost, results } }).eq("id", run.id);
  return Response.json({ dryRun, recency, autoPublish: AUTO_PUBLISH, totalCost, results });
});

async function handle(sb: ReturnType<typeof createClient>, it: Item, cited: Set<string>, bySlug: Map<string, Rec>, catId: Map<string, string>, dryRun: boolean) {
  // Only URLs that appeared in the actual search results count. The model's own list can't add sources.
  const urls = [...new Set((it.source_urls ?? []).filter((u) => cited.has(u)))];
  const fallback = urls.length ? urls : [...cited];
  const sites = new Set(fallback.map(site).filter(Boolean));
  const rec = it.record_slug ? bySlug.get(it.record_slug) : undefined;
  const oldV = rec?.value_numeric == null ? null : Number(rec.value_numeric);

  const checks = {
    matched_record: rec?.slug ?? null,
    same_unit: !!rec && rec.unit === it.unit,
    beats_current: !!rec && oldV != null && beats(it.value_numeric, oldV, rec.better_direction),
    within_25_percent: !!rec && oldV != null && oldV !== 0 && Math.abs(it.value_numeric - oldV) / Math.abs(oldV) <= 0.25,
    independent_sites: sites.size,
    two_sites: sites.size >= 2,
  };
  const pass = checks.matched_record && checks.same_unit && checks.beats_current && checks.within_25_percent && checks.two_sites;
  const summary = { title: it.title, holder: it.holder, value: `${it.value_numeric} ${it.unit}`, checks, pass };
  if (dryRun) return summary;

  // Skip claims we have already queued or published.
  let dupQ = sb.from("candidates").select("id").eq("proposed_value_numeric", it.value_numeric).eq("proposed_holder", it.holder).in("status", ["pending", "auto_published", "approved", "rejected"]).limit(1);
  dupQ = rec ? dupQ.eq("record_id", rec.id) : dupQ.is("record_id", null).eq("category_guess", it.category_slug);
  const { data: dup } = await dupQ;
  if (dup?.length) return { ...summary, status: "already_seen" };
  if (rec && oldV === it.value_numeric) return { ...summary, status: "unchanged" };

  const publish = pass && AUTO_PUBLISH && rec;
  const { error: cErr } = await sb.from("candidates").insert({
    record_id: rec?.id ?? null,
    proposed_holder: it.holder,
    proposed_value_numeric: it.value_numeric,
    proposed_value_text: it.value_text,
    unit: it.unit,
    category_guess: it.category_slug,
    source_urls: fallback.slice(0, 8),
    claude_json: { ...it, model: "perplexity/sonar" },
    checks_passed: checks,
    status: publish ? "auto_published" : "pending",
  });
  if (cErr) return { ...summary, status: "error", error: cErr.message };
  if (!publish) return { ...summary, status: "queued_for_review" };

  // Keep the old holder as a history page, then move the record to the new value.
  const oldYear = rec.achieved_on?.slice(0, 4) ?? "previous";
  const histSlug = `${rec.slug}-${oldYear}-${crypto.randomUUID().slice(0, 4)}`;
  const { data: oldSources } = await sb.from("record_sources").select("url,publisher,license").eq("record_id", rec.id);
  const { data: hist, error: hErr } = await sb.from("records").insert({
    slug: histSlug, category_id: rec.category_id, title: `${rec.title} (${oldYear})`, holder: rec.holder,
    value_numeric: rec.value_numeric, value_text: rec.value_text, unit: rec.unit, better_direction: rec.better_direction,
    achieved_on: rec.achieved_on, location: rec.location, governing_body: rec.governing_body, status: "superseded",
  }).select("id").single();
  if (hErr) return { ...summary, status: "error", error: hErr.message };
  if (oldSources?.length) await sb.from("record_sources").insert(oldSources.map((s) => ({ ...s, record_id: hist.id })));

  const now = new Date().toISOString();
  const { error: uErr } = await sb.from("records").update({
    holder: it.holder, value_numeric: it.value_numeric, value_text: it.value_text, achieved_on: it.achieved_on,
    last_verified_at: now, updated_at: now,
  }).eq("id", rec.id);
  if (uErr) return { ...summary, status: "error", error: uErr.message };
  await sb.from("record_sources").delete().eq("record_id", rec.id);
  await sb.from("record_sources").insert(fallback.slice(0, 4).map((u) => ({ record_id: rec.id, url: u, publisher: site(u), license: null })));
  return { ...summary, status: "published", history: histSlug };
}
