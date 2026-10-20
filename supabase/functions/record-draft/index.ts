// record-draft: researches new record topics so a person can approve them in a batch.
//
// Input rows: candidates with claude_json.kind = "draft" and claude_json.state = "todo".
// Each row holds a topic title, a category slug (category_guess) and better_direction.
// For each row it asks Perplexity (model "sonar", which searches the web) for the CURRENT
// record: holder, figure, date, place, and sources. It writes the answer back to the same
// candidate row and sets state = "done" (or "error").
//
// Topic drafts never create or change a record: they publish only after a person approves.
// Tips can go live by themselves, but only when they pass every check below.
//
// Tips from the public /tip form (claude_json.source = "tip") are free text, so for those it
// also asks for a clean title, the category, which direction is better, and whether the tip
// describes a real, reported record (is_record). The visitor's link is given to the search.
//
// Automatic publishing of tips (autoDecideTips, at the end of this file): a researched tip goes
// live with no review only when ALL of these hold:
//   1. The research says it is a real record (is_record) with high confidence.
//   2. It has a holder, a numeric figure, a unit, a title and a real category.
//   3. At least 2 independent websites back it, not counting the visitor's own link.
//   4. Either no record on the site looks like it (it is published as a new record), or one record
//      clearly matches (same unit) and the tip beats it, by no more than 25%, and is not the same
//      feat reported again. Then that record is updated and the old holder is kept as history.
//   5. Fewer than AUTO_DAILY_CAP tips went live automatically in the last 24 hours.
// Anything else waits in the Tips tab on /admin with the reason. Every automatic publish emails
// the owner (ADMIN_EMAIL) and, if they left an email, the visitor.
//
// Body options: {"limit": 3} at most this many topics per call (default 3, max 8).
// Secret: PERPLEXITY_API_KEY (or PERPLEXITY_AI_KEY).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("PERPLEXITY_API_KEY") ?? Deno.env.get("PERPLEXITY_AI_KEY");
const ENDPOINT = "https://api.perplexity.ai/v1/sonar";
const MODEL = "sonar";
const AUTO_DAILY_CAP = 25;
const ADMIN_EMAIL = "info@mohrcreativegroup.com";
const SITE = "https://brokenrecords.com";

const SCHEMA = {
  type: "object",
  properties: {
    holder: { type: "string" },
    value_numeric: { type: ["number", "null"] },
    unit: { type: "string" },
    value_text: { type: "string" },
    achieved_on: { type: ["string", "null"] },
    location: { type: ["string", "null"] },
    governing_body: { type: ["string", "null"] },
    definition: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    sources: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
  required: ["holder", "value_numeric", "unit", "value_text", "achieved_on", "location", "governing_body", "definition", "confidence", "sources", "note"],
};

// Extra fields asked for tips only.
const TIP_SCHEMA = {
  ...SCHEMA,
  properties: {
    ...SCHEMA.properties,
    title: { type: "string" },
    category_slug: { type: "string" },
    better_direction: { type: "string", enum: ["higher", "lower"] },
    is_record: { type: "boolean" },
  },
  required: [...SCHEMA.required, "title", "category_slug", "better_direction", "is_record"],
};

type Row = { id: string; category_guess: string | null; claude_json: Record<string, unknown> };

// "www.espn.com" and "espn.com/x" count as one website.
function site(url: string): string | null {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const p = h.split(".");
    const twoPartTld = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(p.slice(-2).join("."));
    return p.slice(twoPartTld ? -3 : -2).join(".");
  } catch { return null; }
}

Deno.serve(async (req) => {
  // Locked: only the scheduled jobs may run this (see jobSecretOk at the end of this file).
  if (!(await jobSecretOk(req))) {
    return new Response(JSON.stringify({ error: "Not allowed" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (!KEY) return json({ error: "Perplexity key secret is not set" }, 500);
  const body = await req.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(Number(body.limit ?? 3), 8));
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Visitor and news tips go first, so a big batch of planned topics never delays a fresh tip.
  const queue = () => sb
    .from("candidates")
    .select("id,category_guess,claude_json")
    .eq("status", "pending")
    .eq("claude_json->>kind", "draft")
    .eq("claude_json->>state", "todo")
    .order("created_at", { ascending: true });
  const { data: tips, error } = await queue().eq("claude_json->>source", "tip").limit(limit);
  if (error) return json({ error: error.message }, 500);
  let rows = (tips ?? []) as Row[];
  if (rows.length < limit) {
    const { data: rest, error: e2 } = await queue().is("claude_json->>source", null).limit(limit - rows.length);
    if (e2) return json({ error: e2.message }, 500);
    rows = rows.concat((rest ?? []) as Row[]);
  }

  // Claim the rows first, so an overlapping run does not research the same topic twice.
  for (const r of rows) {
    await sb.from("candidates").update({ claude_json: { ...r.claude_json, state: "working" } }).eq("id", r.id);
  }

  // Category slugs a tip can be filed under (categories that hold records, not the top-level sections).
  let cats: string[] = [];
  if (rows.some((r) => r.claude_json.source === "tip")) {
    const { data: c } = await sb.from("categories").select("slug,parent_id").not("parent_id", "is", null);
    // Old category names merged into "architecture" are left out (see MERGED_CATEGORIES in src/lib/data.ts).
    cats = (c ?? []).map((x) => x.slug).filter((x) => !["buildings", "bridges", "structures"].includes(x));
  }

  // One at a time, because Perplexity limits how many requests run at once.
  const results: unknown[] = [];
  for (const r of rows) {
    results.push(await research(sb, r, cats).catch(async (e) => {
      await sb.from("candidates").update({ claude_json: { ...r.claude_json, state: "error", error: String(e).slice(0, 300) } }).eq("id", r.id);
      return { id: r.id, error: String(e).slice(0, 200) };
    }));
  }
  // Tips that are researched but not yet decided (just now, or in an earlier run) get the
  // automatic check: publish when everything holds up, otherwise leave them for review.
  const auto = await autoDecideTips(sb).catch((e) => ({ error: String(e).slice(0, 200) }));
  const batch = await autoDecideBatch(sb).catch((e) => ({ error: String(e).slice(0, 200) }));
  return json({ done: results.length, results, auto, batch });
});

async function research(sb: SupabaseClient, r: Row, cats: string[]) {
  const title = String(r.claude_json.title ?? "");
  const direction = String(r.claude_json.better_direction ?? "higher");
  const today = new Date().toISOString().slice(0, 10);

  const system = [
    "You research world records for a records website. Today is " + today + ".",
    "Search the web and find the CURRENT record, as it stands today, for the topic given.",
    "Prefer authoritative sources: governing bodies, official league or tournament records, Guinness World Records, speedrun.com leaderboards, and reputable news outlets.",
    "If the topic has several common definitions, use the most widely cited one and state it in 'definition'.",
    "value_numeric rules: times in seconds (unit 's'), distances and heights in metres ('m'), speeds in 'km/h', masses in 'kg', money in US dollars ('USD'), ages in years ('years'), counts as a plural noun (e.g. 'goals', 'titles').",
    "value_text is the figure as a reader would expect to see it, e.g. '3:42.66', '8,849 m (29,032 ft)', '$2.5 billion', '14 titles'.",
    "Use confidence 'high' only when at least two independent sources agree on the holder and the figure. Never guess. Plain words. No em dashes.",
  ].join(" ");
  // Second pass: show the first answer and ask for it to be confirmed or corrected.
  const p1 = r.claude_json.pass1 as Record<string, unknown> | undefined;
  const check = p1
    ? `\n\nA first search answered: holder "${p1.holder ?? "unknown"}", figure "${p1.value_text ?? "unknown"}", date ${p1.achieved_on ?? "unknown"}. ` +
      "That answer was not well supported. Check it against at least two independent, authoritative sources. Correct anything that is wrong or out of date. " +
      "If you cannot find two independent sources that agree, set confidence to 'low'. If the topic has no clear single record, say so in the note and set confidence to 'low'."
    : "";
  const tip = r.claude_json.source === "tip" ? (r.claude_json.tip as Record<string, string | null>) : null;
  const user = tip
    ? `A visitor sent this tip about a world record that was set or broken.\n` +
      `Tip: ${tip.what}\n` + (tip.details ? `Details: ${tip.details}\n` : "") + `Where it was reported: ${tip.url}\n` +
      `Visitor's category guess: ${r.category_guess ?? "none"}\n\n` +
      "Check the tip against the reported link and other sources. Visitors can be wrong or joking. " +
      "Set is_record to true only if credible sources report a real record (a world record or an officially recognized record) " +
      "matching the tip. A personal best, a local or school record, a rumor or an attempt that failed is not a record. " +
      "Stunt records are out of scope: records staged mainly to set a record, such as the most of something done in one minute or one hour, the largest of something assembled, built, cooked or poured for an event, mass-participation gatherings, and novelty body records (longest nails, most piercings, most tattoos). Competition results in sports, and records in nature, animals, science, space, engineering, money and culture, are in scope. If the tip is a stunt record, set is_record to false and start the note with 'Stunt record:'. " +
      "Weather and climate records count only as all-time records for the whole world or for a whole country, for example the highest temperature ever recorded in Canada. Leave out daily, monthly or seasonal records (a record high for a date), and weather records for a city, town, state, province or region. If the tip is one of those, set is_record to false and start the note with 'Local or daily weather:'. " +
      "If the tip is real but the details are wrong, report the correct details. " +
      "If the tip's claim is false or not a record, set is_record to false and confidence to low, and say why in the note. " +
      "Never answer a false tip with a different record on the same topic.\n" +
      "title: a short record title in this style: 'Heaviest pumpkin', 'Men's 100 m', 'Most expensive guitar sold at auction'. No holder name in the title.\n" +
      `category_slug: the best fit from this list: ${cats.join(", ")}.\n` +
      "better_direction: 'lower' for times and other records where less is better, otherwise 'higher'.\n\n" +
      "Return title, category_slug, better_direction, is_record, holder, value_numeric, unit, value_text, achieved_on (YYYY-MM-DD, or null if unknown), location, governing_body, definition, confidence, sources (the URLs you relied on, at most 5), and a one-sentence note."
    : `Topic: ${title}\nCategory: ${r.category_guess ?? "unknown"}\nA ${direction} figure is better.${check}\n\nReturn holder, value_numeric, unit, value_text, achieved_on (YYYY-MM-DD, or null if unknown), location, governing_body, definition, confidence, sources (the URLs you relied on, at most 5), and a one-sentence note.`;

  let res: Response | undefined, text = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "draft", schema: tip ? TIP_SCHEMA : SCHEMA } },
      }),
      signal: AbortSignal.timeout(100_000),
    });
    text = await res.text();
    if (res.status !== 429) break;
    await new Promise((ok) => setTimeout(ok, 8000 * (attempt + 1)));
  }
  res = res!;
  if (res.status === 429) {
    // Put it back in the queue for the next run.
    await sb.from("candidates").update({ claude_json: { ...r.claude_json, state: "todo" } }).eq("id", r.id);
    return { id: r.id, skipped: "rate limited" };
  }
  if (!res.ok) throw new Error(`Perplexity ${res.status}: ${text.slice(0, 200)}`);

  const j = JSON.parse(text);
  const out = JSON.parse(String(j?.choices?.[0]?.message?.content ?? "{}").replace(/^```(json)?|```$/g, "").trim());
  const cost = j?.usage?.cost?.total_cost ?? null;

  // Only URLs that appeared in the actual search results count as sources.
  const cited = new Set<string>([...(j.citations ?? []), ...((j.search_results ?? []).map((s: { url: string }) => s.url))]);
  const claimed: string[] = (out.sources ?? []).filter((u: string) => /^https?:\/\//.test(u));
  const backed = claimed.filter((u) => cited.has(u));
  // The visitor's link is kept as a source only when the tip checks out.
  const keepTipUrl = tip?.url && out.is_record === true;
  const urls = [...new Set([...(backed.length ? backed : [...cited]), ...(keepTipUrl ? [tip.url] : [])])].slice(0, 5);
  if (tip && !cats.includes(String(out.category_slug ?? ""))) out.category_slug = r.category_guess ?? null;
  const sites = new Set(urls.map(site).filter(Boolean));

  const { error } = await sb.from("candidates").update({
    ...(tip && out.category_slug ? { category_guess: out.category_slug } : {}),
    proposed_holder: out.holder ?? null,
    proposed_value_numeric: typeof out.value_numeric === "number" ? out.value_numeric : null,
    proposed_value_text: out.value_text ?? null,
    unit: out.unit ?? null,
    source_urls: urls,
    checks_passed: { confidence: out.confidence, independent_sites: sites.size },
    // For a tip, keep the visitor's original words in tip.what; out.title is the cleaned-up title.
    claude_json: { ...r.claude_json, ...out, state: "done", model: MODEL, cost, researched_at: new Date().toISOString() },
  }).eq("id", r.id);
  if (error) throw new Error(error.message);
  return { id: r.id, title, confidence: out.confidence, sites: sites.size, cost };
}

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });

// The project's public key reaches every function, so it can't protect one. Each scheduled job
// also sends an x-job-secret header, which cron reads from the job_secrets table when it runs.
// This compares that header with the same table, so the secret never appears in code.
async function jobSecretOk(req: Request): Promise<boolean> {
  const got = req.headers.get("x-job-secret");
  if (!got) return false;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data } = await admin.from("job_secrets").select("value").eq("key", "jobs").maybeSingle();
  return !!data?.value && data.value === got;
}

// ---------- Automatic decision for researched tips ----------

type Tip = {
  id: string; category_guess: string | null; source_urls: string[] | null; proposed_holder: string | null;
  proposed_value_numeric: number | null; proposed_value_text: string | null; unit: string | null;
  claude_json: Record<string, any>;
};
type Live = {
  id: string; slug: string; title: string; holder: string | null; value_numeric: number | null; value_text: string | null;
  unit: string | null; better_direction: string | null; achieved_on: string | null; location: string | null;
  governing_body: string | null; category_id: string; wikidata_id: string | null; last_verified_at: string | null;
};

const STOP = new Set(["the", "and", "for", "from", "with", "most", "world", "record", "largest", "biggest", "longest", "fastest", "highest", "heaviest", "oldest"]);
const titleWords = (s: string) => [...new Set(s.toLowerCase().normalize("NFKD").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
const nameKey = (s: string | null | undefined) => (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

// Words that make a different record: "Women's wheelchair marathon" is not "Women's marathon",
// and "50m butterfly short course" is not the long course record.
const QUALIFIERS = new Set(["wheelchair", "short", "indoor", "junior", "youth", "masters", "senior", "para", "paralympic", "relay",
  "team", "mixed", "tandem", "solo", "unassisted", "assisted", "blind", "female", "male", "girl", "boy", "child", "teen", "amateur",
  "oxygen", "winter", "summer", "living", "single", "double", "underwater", "backwards", "robot", "dog", "cat"]);
const GENDER = (s: string) => /\bwom[ae]n'?s?\b|\bfemale\b|\bgirls?\b/i.test(s) ? "f" : /\bm[ae]n'?s?\b|\bmale\b|\bboys?\b/i.test(s) ? "m" : "";
// Matching ignores bare numbers ("2,000" and "10,000" both split into "000") and gender words; gender is compared on its own.
const FILLER = ["men", "mens", "women", "womens", "ever", "grown", "recorded", "official", "officially", "guinness", "title", "new", "all", "time", "set"];
const matchWords = (s: string) => titleWords(s).filter((w) => !/^\d+$/.test(w) && !FILLER.includes(w));

// Share of the shorter title's words found in the other title. A qualifier word on one side only,
// or a different gender, means a different record (score 0).
function titleScore(a: string, b: string) {
  const wa = matchWords(a), wb = matchWords(b);
  if (!wa.length || !wb.length) return 0;
  const ga = GENDER(a), gb = GENDER(b);
  if (ga && gb && ga !== gb) return 0;
  if (wa.some((w) => QUALIFIERS.has(w) && !wb.includes(w)) || wb.some((w) => QUALIFIERS.has(w) && !wa.includes(w))) return 0;
  const shared = wa.filter((w) => wb.includes(w)).length;
  // A short title inside a long one ("Oldest living person" in "Most tattooed living person by multiple layers")
  // is not a match: at least half of the longer title's words must be shared too.
  if (shared / Math.max(wa.length, wb.length) < 0.5) return Math.min(0.5, shared / Math.min(wa.length, wb.length));
  return shared / Math.min(wa.length, wb.length);
}

async function autoDecideTips(sb: SupabaseClient) {
  const { data } = await sb.from("candidates")
    .select("id,category_guess,source_urls,proposed_holder,proposed_value_numeric,proposed_value_text,unit,claude_json")
    .eq("status", "pending").eq("claude_json->>kind", "draft").eq("claude_json->>source", "tip")
    .eq("claude_json->>state", "done").is("claude_json->>auto_decision", null).limit(10);
  const tips = (data ?? []) as Tip[];
  if (!tips.length) return [];

  const { data: liveRows } = await sb.from("records")
    .select("id,slug,title,holder,value_numeric,value_text,unit,better_direction,achieved_on,location,governing_body,category_id,wikidata_id,last_verified_at")
    .eq("status", "published");
  const live = (liveRows ?? []) as Live[];
  const { data: cats } = await sb.from("categories").select("id,slug").not("parent_id", "is", null);
  const catId = new Map((cats ?? []).map((c) => [c.slug, c.id]));

  const out: unknown[] = [];
  for (const t of tips) {
    const result = await decideTip(sb, t, live, catId).catch((e) => ({ decision: "review", reason: `error: ${String(e).slice(0, 150)}` }));
    await sb.from("candidates").update({
      claude_json: { ...t.claude_json, auto_decision: result.decision, auto_reason: result.reason, auto_at: new Date().toISOString() },
      ...(result.decision === "published" || result.decision === "updated"
        ? { status: "approved", record_id: (result as { recordId?: string }).recordId ?? null }
        : result.decision === "duplicate" ? { status: "rejected" } : {}),
    }).eq("id", t.id);
    out.push({ id: t.id, ...result });
  }
  return out;
}

async function decideTip(sb: SupabaseClient, t: Tip, live: Live[], catId: Map<string, string>) {
  const j = t.claude_json;
  const tip = (j.tip ?? {}) as Record<string, string | null>;
  const review = (reason: string) => ({ decision: "review", reason });

  // Rules 1 to 3.
  if (j.is_record !== true) return review("research does not confirm it as a record");
  if (j.confidence !== "high") return review(`research confidence is ${j.confidence ?? "unknown"}, not high`);
  const title = String(j.title ?? "").trim();
  const value = typeof t.proposed_value_numeric === "number" ? t.proposed_value_numeric : null;
  if (!title || !t.proposed_holder || value == null || !t.unit) return review("missing title, holder, figure or unit");
  const category = t.category_guess && catId.get(t.category_guess);
  if (!category) return review("no category");
  const tipSite = tip.url ? site(tip.url) : null;
  const backing = new Set((t.source_urls ?? []).map(site).filter((x) => x && x !== tipSite));
  if (backing.size < 2) return review(`only ${backing.size} independent source${backing.size === 1 ? "" : "s"} besides the visitor's link`);

  // Rule 5.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await sb.from("candidates").select("id", { count: "exact", head: true })
    .eq("claude_json->>source", "tip").in("claude_json->>auto_decision", ["published", "updated"]).gt("claude_json->>auto_at", since);
  if ((count ?? 0) >= AUTO_DAILY_CAP) return review(`daily limit of ${AUTO_DAILY_CAP} automatic publishes reached`);

  // Rule 4.
  const matches = live.map((r) => ({ r, score: titleScore(title, r.title) })).filter((m) => m.score >= 0.6).sort((a, b) => b.score - a.score);
  const name = (tip.name ?? "").trim() || null;
  if (!matches.length) {
    const rec = await publishNew(sb, t, title, category, name);
    await notify(t, rec.slug, title, "new");
    return { decision: "published", reason: "new record, all checks passed", slug: rec.slug, recordId: rec.id };
  }
  const best = matches[0];
  if (best.score < 0.8 || (matches[1] && matches[1].score >= 0.8)) return review(`may match an existing record (${matches.map((m) => m.r.slug).slice(0, 3).join(", ")})`);
  const cur = best.r;
  if ((cur.unit ?? "") !== t.unit) return review(`matches "${cur.title}" but the unit differs (${cur.unit} vs ${t.unit})`);
  const old = cur.value_numeric == null ? null : Number(cur.value_numeric);
  if (old == null || old === 0) return review(`matches "${cur.title}", which has no figure to compare`);
  // "Egor Kornev (Russia)" and "Egor Kornev" are the same holder.
  const hc = nameKey(cur.holder), ht = nameKey(t.proposed_holder);
  const sameHolder = hc !== "" && ht !== "" && (hc === ht || hc.startsWith(ht + " ") || ht.startsWith(hc + " "));
  if (sameHolder && Math.abs(value - old) / Math.abs(old) < 0.005) return { decision: "duplicate", reason: `already listed as "${cur.title}"`, slug: cur.slug };
  const lower = (cur.better_direction ?? j.better_direction) === "lower";
  const beats = lower ? value < old : value > old;
  if (!beats) return review(`does not beat the current "${cur.title}" (${cur.value_text ?? old})`);
  if (Math.abs(value - old) / Math.abs(old) > 0.25) return review(`beats "${cur.title}" by more than 25%, check the units`);
  if (cur.achieved_on && j.achieved_on && Date.parse(j.achieved_on) < Date.parse(cur.achieved_on)) return review(`dated before the current "${cur.title}"`);
  await updateExisting(sb, t, cur, name);
  await notify(t, cur.slug, cur.title, "update");
  return { decision: "updated", reason: `beat "${cur.title}", all checks passed`, slug: cur.slug, recordId: cur.id };
}

// ---------- Automatic decision for planned topic batches ----------
// Topics Claude queued in a batch (claude_json.batch) publish by themselves only when the research is
// solid: high confidence, a real holder and figure with a unit, 2+ independent websites, a real
// category, and no record on the site that looks like the same topic. Anything else stays pending
// with the reason, for the morning report or a person to decide.
const PLACEHOLDER = /^((unknown|n\/a|none|tbd|unclear|various|multiple)\b|not (established|known|found|available|applicable)\b|no (reliabl|verifi|current|known|clear|single|official))/i;

async function autoDecideBatch(sb: SupabaseClient) {
  const { data } = await sb.from("candidates")
    .select("id,category_guess,source_urls,proposed_holder,proposed_value_numeric,proposed_value_text,unit,claude_json")
    .eq("status", "pending").eq("claude_json->>kind", "draft").is("claude_json->>source", null)
    .not("claude_json->>batch", "is", null)
    .eq("claude_json->>state", "done").is("claude_json->>auto_decision", null).limit(8);
  const rows = (data ?? []) as Tip[];
  if (!rows.length) return [];
  const { data: liveRows } = await sb.from("records").select("id,slug,title").eq("status", "published");
  const live = (liveRows ?? []) as { id: string; slug: string; title: string }[];
  const { data: cats } = await sb.from("categories").select("id,slug").not("parent_id", "is", null);
  const catId = new Map((cats ?? []).map((c) => [c.slug, c.id]));

  const out: unknown[] = [];
  for (const t of rows) {
    const j = t.claude_json;
    const title = String(j.title ?? "").trim();
    const sites = new Set((t.source_urls ?? []).map(site).filter(Boolean));
    const category = t.category_guess ? (catId.get(t.category_guess) as string | undefined) : undefined;
    const match = live.map((r) => ({ r, s: titleScore(title, r.title) })).filter((m) => m.s >= 0.6).sort((a, b) => b.s - a.s)[0];
    const num = t.proposed_value_numeric == null ? NaN : Number(t.proposed_value_numeric);
    let reason: string | null =
      j.confidence !== "high" ? `research confidence is ${j.confidence ?? "unknown"}, not high`
      : !t.proposed_holder || PLACEHOLDER.test(t.proposed_holder) ? "no real holder"
      : !t.proposed_value_text || PLACEHOLDER.test(t.proposed_value_text) ? "no real figure"
      : !Number.isFinite(num) || !t.unit ? "no numeric figure or unit"
      : !category ? "no category"
      : sites.size < 2 ? `only ${sites.size} independent source${sites.size === 1 ? "" : "s"}`
      : match ? `may duplicate "${match.r.title}" (${match.r.slug})`
      : null;
    let decision = "review", slug: string | undefined, recordId: string | undefined;
    if (!reason) reason = scaleProblem(t.proposed_value_text!, num, t.unit!);
    let challenge: Record<string, unknown> | undefined;
    if (!reason) {
      challenge = await challengeIt(title, t.proposed_holder!, t.proposed_value_text!, String(j.better_direction ?? "higher"));
      // A failed search (rate limit, timeout) is retried on the next run instead of being held.
      if (String(challenge.note ?? "").startsWith("challenge search failed")) continue;
      if (challenge.agrees !== true) reason = `second search disagrees: ${String(challenge.note ?? "").slice(0, 200)}`;
    }
    if (!reason) {
      // One bad row must not block the rest of the queue: a failed insert is held with the error.
      try {
        const rec = await publishNew(sb, t, title, category!, null);
        decision = "published"; slug = rec.slug; recordId = rec.id;
        live.push({ id: rec.id, slug: rec.slug, title });
      } catch (e) { reason = `publish failed: ${String(e).slice(0, 150)}`; }
    }
    await sb.from("candidates").update({
      claude_json: { ...j, auto_decision: decision, auto_reason: reason ?? "all checks passed", auto_at: new Date().toISOString(), ...(challenge ? { challenge } : {}), ...(slug ? { applied: "new", slug } : {}) },
      ...(decision === "published" ? { status: "approved", record_id: recordId } : {}),
    }).eq("id", t.id);
    out.push({ id: t.id, title, decision, reason, slug });
  }
  return out;
}

// The stored number must match the written figure: "$4.27 trillion" is 4,270,000,000,000 USD, not 4.27,
// and "751.4 km" stored in metres is 751,400. Returns a reason when they disagree, otherwise null.
function scaleProblem(text: string, n: number, unit: string): string | null {
  const m = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(thousand|million|billion|trillion|[kmb]n?\b)?\s*([a-z°³²/]+)?/i);
  if (!m) return null;
  let x = Number(m[1]);
  const word = (m[2] ?? "").toLowerCase();
  const scale: Record<string, number> = { thousand: 1e3, million: 1e6, m: 1e6, mn: 1e6, billion: 1e9, b: 1e9, bn: 1e9, trillion: 1e12 };
  if (unit === "USD" && scale[word]) x *= scale[word];
  else if (word === "thousand") x *= 1e3;
  const tu = (m[3] ?? "").toLowerCase();
  if (unit === "m" && (tu === "km" || word === "k")) x *= 1000;
  if (unit === "kg" && tu === "g") x /= 1000;
  if (unit === "kg" && (tu === "t" || tu === "tonnes" || tu === "tons")) x *= 1000;
  if (/:/.test(text) && unit === "s") return null; // clock times are checked by the reader, not here
  if (!x || !n) return null;
  const r = n / x;
  if (unit === "USD" && (r < 0.9 || r > 1.1)) return `figure "${text}" does not match the stored ${n} USD`;
  if (r > 500 || r < 0.002) return `figure "${text}" does not match the stored ${n} ${unit}`;
  if (unit === "m" && tu === "km" && (r < 0.9 || r > 1.1)) return `figure "${text}" does not match the stored ${n} m`;
  return null;
}

// A second, skeptical search: try to find a record that beats the researched one.
async function challengeIt(title: string, holder: string, value: string, direction: string) {
  const schema = { type: "object", properties: { agrees: { type: "boolean" }, better_holder: { type: ["string", "null"] }, better_value: { type: ["string", "null"] }, note: { type: "string" } }, required: ["agrees", "better_holder", "better_value", "note"] };
  const user = `Claim: the current world record for "${title}" is held by ${holder}, with ${value}. A ${direction} figure is better.\n` +
    "Search for credible sources. Look hard for a different holder or a better figure that is widely accepted as the record today, " +
    "including a more recent record, a larger or faster example, or a wrong figure. Also say false if the holder or figure is wrong. " +
    "Set agrees to true only if the claim is correct and current. Plain words. No em dashes. Return agrees, better_holder, better_value and a one-sentence note.";
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: "You fact-check world records for a records website. Today is " + new Date().toISOString().slice(0, 10) + "." }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "challenge", schema } },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return { agrees: false, note: `challenge search failed (${res.status})` };
  const j = await res.json();
  try {
    return JSON.parse(String(j?.choices?.[0]?.message?.content ?? "{}").replace(/^```(json)?|```$/g, "").trim());
  } catch { return { agrees: false, note: "challenge answer was not readable" }; }
}

async function addSources(sb: SupabaseClient, recordId: string, urls: string[]) {
  const rows = [...new Set(urls)].filter((u) => /^https?:\/\//.test(u)).slice(0, 5)
    .map((u) => ({ record_id: recordId, url: u, publisher: site(u), license: null }));
  if (rows.length) await sb.from("record_sources").insert(rows);
}

// The date column takes a full date only. "1990" or "1990-05" from the research is dropped, not guessed.
const fullDate = (d: unknown) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);

async function publishNew(sb: SupabaseClient, t: Tip, title: string, categoryId: string, name: string | null) {
  const j = t.claude_json;
  const base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "record";
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const { data: taken } = await sb.from("records").select("id").eq("slug", slug).maybeSingle();
    if (!taken) break;
    slug = `${base}-${i}`;
  }
  const now = new Date().toISOString();
  const { data: rec, error } = await sb.from("records").insert({
    slug, category_id: categoryId, title, holder: t.proposed_holder, value_text: t.proposed_value_text, value_numeric: t.proposed_value_numeric,
    unit: t.unit, achieved_on: fullDate(j.achieved_on), location: j.location ?? null, governing_body: j.governing_body ?? null,
    better_direction: j.better_direction === "lower" ? "lower" : "higher", status: "published", tipped_by: name,
    last_verified_at: now, last_checked_at: now, updated_at: now,
    visual_prompt: `A cinematic scene that represents this world record: ${title}. No people's faces.`,
  }).select("id").single();
  if (error) throw new Error(error.message);
  await addSources(sb, rec.id, t.source_urls ?? []);
  return { id: rec.id as string, slug };
}

async function updateExisting(sb: SupabaseClient, t: Tip, cur: Live, name: string | null) {
  const j = t.claude_json;
  const year = cur.achieved_on?.slice(0, 4) ?? "previous";
  const now = new Date().toISOString();
  const { data: hist, error: hErr } = await sb.from("records").insert({
    slug: `${cur.slug}-${year}-${crypto.randomUUID().slice(0, 4)}`, category_id: cur.category_id, title: `${cur.title} (${year})`,
    holder: cur.holder, value_numeric: cur.value_numeric, value_text: cur.value_text, unit: cur.unit, better_direction: cur.better_direction,
    achieved_on: cur.achieved_on, location: cur.location, governing_body: cur.governing_body, wikidata_id: cur.wikidata_id,
    status: "superseded", superseded_by: cur.id, last_verified_at: cur.last_verified_at, featured: false,
  }).select("id").single();
  if (hErr) throw new Error(hErr.message);
  await sb.from("record_sources").update({ record_id: hist.id }).eq("record_id", cur.id);
  await addSources(sb, cur.id, t.source_urls ?? []);
  const { error } = await sb.from("records").update({
    holder: t.proposed_holder, value_text: t.proposed_value_text, value_numeric: t.proposed_value_numeric,
    achieved_on: fullDate(j.achieved_on), location: j.location ?? cur.location, governing_body: j.governing_body ?? cur.governing_body,
    tipped_by: name, last_verified_at: now, last_checked_at: now, updated_at: now,
  }).eq("id", cur.id);
  if (error) throw new Error(error.message);
}

// Emails the owner about every automatic publish, and the visitor if they left an email.
async function notify(t: Tip, slug: string, title: string, kind: "new" | "update") {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return;
  const tip = (t.claude_json.tip ?? {}) as Record<string, string | null>;
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const url = `${SITE}/records/${slug}`;
  const frame = (inner: string) => `<!doctype html><html><body style="margin:0;padding:24px;background:#eceff1;font-family:Georgia,serif;color:#17212b">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px"><tr><td style="padding:28px">
<p style="margin:0 0 16px;font:900 22px Arial,sans-serif"><span style="color:#c98a12">Broken</span> Records</p>${inner}</td></tr></table></body></html>`;
  const emails: unknown[] = [{
    from: "Broken Records <info@brokenrecords.com>", to: [ADMIN_EMAIL],
    subject: `Auto-published from a tip: ${title}`,
    html: frame(`<p style="margin:0 0 12px;font-size:16px">A tip passed every check and went live ${kind === "new" ? "as a new record" : "as an update to an existing record (the old holder is kept as history)"}.</p>
<p style="margin:0 0 6px;font:800 18px Arial,sans-serif"><a href="${url}" style="color:#1d5c8f">${esc(title)}</a></p>
<p style="margin:0 0 12px;font-size:15px">${esc(t.proposed_holder)} · ${esc(t.proposed_value_text)}</p>
<p style="margin:0 0 6px;font-size:14px;color:#4a5866">Visitor wrote: ${esc(tip.what)}${tip.name ? ` (${esc(tip.name)})` : ""}</p>
<p style="margin:0 0 6px;font-size:14px;color:#4a5866">Research: ${esc(t.claude_json.note)}</p>
<p style="margin:12px 0 0;font-size:14px">Nothing to do if it looks right. If not, fix or hide it from <a href="${SITE}/admin" style="color:#1d5c8f">/admin</a> or tell Claude.</p>`),
    text: `A tip went live automatically: ${title}\n${t.proposed_holder} · ${t.proposed_value_text}\n${url}\nVisitor wrote: ${tip.what}\nResearch: ${t.claude_json.note ?? ""}`,
  }];
  if (tip.email) {
    emails.push({
      from: "Broken Records <info@brokenrecords.com>", to: [tip.email], subject: `Your tip is live: ${title}`,
      html: frame(`<p style="margin:0 0 12px;font-size:17px;line-height:1.5">${tip.name ? `Thanks, ${esc(tip.name)}.` : "Thanks for the tip."} We checked it against its sources, and it's now on the site:</p>
<p style="margin:0 0 20px;font:800 19px Arial,sans-serif"><a href="${url}?utm_source=email&utm_medium=tip_live" style="color:#1d5c8f">${esc(title)}</a></p>
${tip.name ? `<p style="margin:0 0 16px;font-size:15px">The record page credits you as "Tipped off by ${esc(tip.name)}." Share it.</p>` : ""}
<p style="margin:0;font-size:15px">Want the week's broken records by email? <a href="${SITE}/alerts" style="color:#1d5c8f">Get record alerts</a>.</p>`),
      text: `Thanks for the tip. It's now on the site: ${title}\n${url}`,
    });
  }
  await fetch("https://api.resend.com/emails/batch", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(emails),
  }).catch(() => {});
}
