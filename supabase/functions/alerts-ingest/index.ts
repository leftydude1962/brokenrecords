// alerts-ingest: reads Keith's Google Alerts RSS feeds every hour and turns real record news into tips.
//
// Feeds live in the alert_feeds table. Every story seen is saved in alert_items (unique by link), so
// nothing is checked or paid for twice. Each run:
//   1. Reads every active feed (Atom XML) and keeps entries not seen before.
//   2. Drops obvious noise by keyword (no "record" in the headline or snippet, stock prices, record labels...).
//   3. Sends the rest to Perplexity in ONE call to sort them: is this a new world record or officially
//      recognized record (not a course, club, team, school or personal record)? It also returns a short
//      key for the record, so five articles about the same feat become one tip.
//   4. Each real one becomes a tip (candidates, kind "draft", source "tip", via "google-alerts").
//      record-draft then researches it and auto-publishes it only if it passes every check.
// Limits: at most MAX_TIPS_PER_RUN tips per run and MAX_TIPS_PER_DAY per day; the rest wait for a later run.
//
// Locked like the other scheduled jobs (x-job-secret header). Body: {"dryRun": true} sorts but saves nothing.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("PERPLEXITY_API_KEY") ?? Deno.env.get("PERPLEXITY_AI_KEY");
const ENDPOINT = "https://api.perplexity.ai/v1/sonar";
const MAX_TIPS_PER_RUN = 8;
const MAX_TIPS_PER_DAY = 30;
const MAX_TRIAGE = 40; // stories sent to the sorter per run

type Entry = { link: string; title: string; snippet: string; published: string | null; feed: string };

Deno.serve(async (req) => {
  if (!(await jobSecretOk(req))) return json({ error: "Not allowed" }, 401);
  if (!KEY) return json({ error: "Perplexity key secret is not set" }, 500);
  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // 1. Read the feeds.
  const { data: feeds } = await sb.from("alert_feeds").select("url").eq("active", true);
  const entries: Entry[] = [];
  for (const f of feeds ?? []) {
    try {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entries.push(...parseAtom(await res.text(), f.url));
      if (!dryRun) await sb.from("alert_feeds").update({ last_read_at: new Date().toISOString(), last_error: null }).eq("url", f.url);
    } catch (e) {
      if (!dryRun) await sb.from("alert_feeds").update({ last_error: String(e).slice(0, 300) }).eq("url", f.url);
    }
  }

  // Same story from two feeds counts once. Then drop anything already in alert_items.
  const byLink = new Map<string, Entry>();
  for (const e of entries) if (!byLink.has(e.link)) byLink.set(e.link, e);
  const links = [...byLink.keys()];
  const seen = new Set<string>();
  for (let i = 0; i < links.length; i += 100) {
    const { data } = await sb.from("alert_items").select("link").in("link", links.slice(i, i + 100));
    for (const r of data ?? []) seen.add(r.link);
    // Stories already sent in by hand or by the tip form.
    const { data: known } = await sb.from("candidates").select("source_urls").overlaps("source_urls", links.slice(i, i + 100));
    for (const c of known ?? []) for (const u of c.source_urls ?? []) seen.add(u);
  }
  const fresh = [...byLink.values()].filter((e) => !seen.has(e.link));

  // 2. Keyword filter.
  const pre = fresh.map((e) => ({ e, why: noise(e) }));
  const toSort = pre.filter((p) => !p.why).map((p) => p.e).slice(0, MAX_TRIAGE);
  const rows: Record<string, unknown>[] = pre.filter((p) => p.why).map((p) => item(p.e, "prefilter", p.why!));
  // Stories past MAX_TRIAGE wait for the next run (not saved), so none are lost.

  // 3. Sort the rest in one call.
  let verdicts: Verdict[] = [];
  let cost: number | null = null;
  if (toSort.length) {
    const out = await triage(toSort);
    verdicts = out.verdicts;
    cost = out.cost;
  }

  // 4. Tips, within the limits, one per record.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count: today } = await sb.from("alert_items").select("id", { count: "exact", head: true })
    .eq("decision", "queued").gt("created_at", since);
  let room = Math.min(MAX_TIPS_PER_RUN, MAX_TIPS_PER_DAY - (today ?? 0));
  const { data: recentKeys } = await sb.from("alert_items").select("story_key")
    .eq("decision", "queued").gt("created_at", new Date(Date.now() - 4 * 86_400_000).toISOString());
  const keys = new Set((recentKeys ?? []).map((r) => r.story_key).filter(Boolean));

  const queued: unknown[] = [];
  toSort.forEach((e, i) => {
    const v = verdicts.find((x) => x.n === i + 1);
    if (!v) { rows.push(item(e, "not_record", "no verdict from the sorter")); return; }
    const key = normKey(v.key);
    if (!v.is_record) { rows.push({ ...item(e, "not_record", v.reason), story_key: key }); return; }
    if (key && keys.has(key)) { rows.push({ ...item(e, "duplicate", `same record as an earlier story (${key})`), story_key: key }); return; }
    // Over the limit: not saved, so the story is sorted again next run when there is room.
    if (room <= 0) return;
    room--;
    if (key) keys.add(key);
    rows.push({ ...item(e, "queued", v.reason), story_key: key, _what: v.what });
    queued.push({ what: v.what, link: e.link });
  });

  if (dryRun) return json({ dryRun: true, read: entries.length, fresh: fresh.length, sorted: toSort.length, cost, rows: rows.map(({ _what, ...r }) => ({ ...r, what: _what })) });

  // Save tips first, then remember every story.
  for (const r of rows) {
    if (r.decision !== "queued") continue;
    const { data: c, error } = await sb.from("candidates").insert({
      record_id: null, category_guess: null, source_urls: [r.link], status: "pending",
      claude_json: {
        kind: "draft", source: "tip", state: "todo", title: r._what, better_direction: "higher", via: "google-alerts",
        tip: { what: r._what, details: `Headline: ${r.title}`, url: r.link, name: null, email: null },
      },
    }).select("id").single();
    if (error) { r.decision = "error"; r.reason = error.message; } else r.candidate_id = c.id;
  }
  const save = rows.map(({ _what, ...r }) => r);
  for (let i = 0; i < save.length; i += 200) {
    await sb.from("alert_items").upsert(save.slice(i, i + 200), { onConflict: "link", ignoreDuplicates: true });
  }
  await sb.from("sync_runs").insert({
    source: "alerts-ingest", dry_run: false, started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    stats: { read: entries.length, fresh: fresh.length, sorted: toSort.length, queued: queued.length, cost },
  });
  return json({ read: entries.length, fresh: fresh.length, sorted: toSort.length, queued, cost });
});

const item = (e: Entry, decision: string, reason: string) => ({
  link: e.link, feed_url: e.feed, title: e.title.slice(0, 300), snippet: e.snippet.slice(0, 600),
  published_at: e.published, decision, reason: String(reason ?? "").slice(0, 300),
});

// Headlines that are about something else even though they say "record".
function noise(e: Entry): string | null {
  const t = `${e.title} ${e.snippet}`.toLowerCase();
  if (!/record/.test(t)) return "no 'record' in the story";
  if (/records? (are|were) (made|meant) to be broken|record label|record store|vinyl|for the record|on the record|off the record|criminal record|track record|medical record|public record|record player/.test(t)
      && !/world record|guinness/.test(t)) return "'record' used in another sense";
  if (/\b(stock|shares|nasdaq|dow jones|s&p 500|earnings|revenue|quarterly)\b/.test(t) && !/world record|guinness/.test(t)) return "business record, not a world record";
  if (/youtube\.com|tiktok\.com|instagram\.com|facebook\.com/.test(e.link)) return "video or social post, not a news source";
  return null;
}

type Verdict = { n: number; is_record: boolean; what: string; key: string; reason: string };

async function triage(list: Entry[]): Promise<{ verdicts: Verdict[]; cost: number | null }> {
  const lines = list.map((e, i) => `${i + 1}. ${e.title}\n   ${e.snippet}`).join("\n");
  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            n: { type: "integer" }, is_record: { type: "boolean" }, what: { type: "string" },
            key: { type: "string" }, reason: { type: "string" },
          },
          required: ["n", "is_record", "what", "key", "reason"],
        },
      },
    },
    required: ["items"],
  };
  const system = "You sort news headlines for a world records website. Judge only from the headline and snippet given. Plain words. No em dashes.";
  const user =
    "For each numbered story, decide is_record: true only if it reports a record that was SET or BROKEN recently and is one of: " +
    "a world record; an all-time national record in a major sport; an officially recognized record (Guinness World Records, a sport's governing body); " +
    "or an all-time record in nature, weather, science, space, money or culture (for example the latest-forming hurricane on record, the most expensive painting sold). " +
    "False for: course, meet, club, team, franchise, school, league-season or personal records; attempts that failed or are planned; " +
    "records only mentioned in passing; old records recalled in a profile; sales, box office or stock records unless called a world record; and anything vague.\n" +
    "what: one sentence naming the record, the holder and the figure if given, e.g. 'Catherine Debrunner breaks the women's wheelchair marathon world record (1:33:16) at the 2026 Chicago Marathon'.\n" +
    "key: a short lowercase name for the record itself, the same for every article about the same feat, e.g. 'women wheelchair marathon debrunner'.\n" +
    "reason: a few words.\n\n" + lines;
  const send = (extra: Record<string, unknown>) => fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonar", ...extra,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "sort", schema } },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  // No web search is needed to sort headlines; fall back if the option is not accepted.
  let res = await send({ disable_search: true });
  if (res.status === 400) res = await send({});
  const text = await res.text();
  if (!res.ok) throw new Error(`Perplexity ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  const out = JSON.parse(String(j?.choices?.[0]?.message?.content ?? "{}").replace(/^```(json)?|```$/g, "").trim());
  return { verdicts: (out.items ?? []) as Verdict[], cost: j?.usage?.cost?.total_cost ?? null };
}

const normKey = (s: string | null | undefined) => (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ").sort().join(" ").slice(0, 120);

// Minimal Atom reader for Google Alerts feeds.
function parseAtom(xml: string, feed: string): Entry[] {
  const out: Entry[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const raw = decode(e.match(/<link href="([^"]+)"/)?.[1] ?? "");
    let link = raw;
    try { link = new URL(raw).searchParams.get("url") ?? raw; } catch { /* keep raw */ }
    const title = clean(e.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const snippet = clean(e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? "");
    const published = e.match(/<published>([^<]+)<\/published>/)?.[1] ?? null;
    if (/^https?:\/\//.test(link) && title) out.push({ link, title, snippet, published, feed });
  }
  return out;
}
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
// Entities are double-encoded in these feeds (&amp;#39;), so decode twice, then drop tags.
const clean = (s: string) => decode(decode(s)).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });

// Same check as the other scheduled jobs: compares the x-job-secret header with the job_secrets table.
async function jobSecretOk(req: Request): Promise<boolean> {
  const got = req.headers.get("x-job-secret");
  if (!got) return false;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data } = await admin.from("job_secrets").select("value").eq("key", "jobs").maybeSingle();
  return !!data?.value && data.value === got;
}

export type { SupabaseClient };
