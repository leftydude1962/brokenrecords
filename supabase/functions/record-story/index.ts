// record-story: writes an original 200 to 300 word story for a record page, through Perplexity.
//
// Why: each record page needs text of its own for search engines. Copying source articles is not
// allowed and would count as duplicate content, so this writes new text from the facts and sources.
//
// For each record it:
//   1. Sends the record's facts and source links to Perplexity (model "sonar", which searches the web).
//   2. Gets back three short sections, plus one short quote from a source and the sources it used.
//   3. Checks the quote word for word against the source page. A quote that is not found is dropped.
//   4. Saves the story in records.story, and the headline, date and quote on record_sources.
//
// Body options:
//   {"slugs": ["mens-100m"]}   only these records
//   {"featured": true}         only the featured records
//   {"limit": 5}               at most this many records per call (default 5, max 10)
//   {"redo": true}             rewrite records that already have a story
// Without slugs it picks published records with no story yet.
// Secret: PERPLEXITY_API_KEY (or PERPLEXITY_AI_KEY).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { formatValue, formatMetric } from "./format.ts";

const KEY = Deno.env.get("PERPLEXITY_API_KEY") ?? Deno.env.get("PERPLEXITY_AI_KEY");
const ENDPOINT = "https://api.perplexity.ai/v1/sonar";
const MODEL = "sonar";

const SCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: { type: "object", properties: { heading: { type: "string" }, body: { type: "string" } }, required: ["heading", "body"] },
    },
    quote: {
      type: ["object", "null"],
      properties: { text: { type: "string" }, url: { type: "string" } },
      required: ["text", "url"],
    },
    sources_used: { type: "array", items: { type: "string" } },
    conflict: { type: ["string", "null"] },
  },
  required: ["sections", "quote", "sources_used", "conflict"],
};

type Rec = {
  id: string; slug: string; title: string; holder: string | null; value_numeric: number | null; value_text: string | null;
  unit: string | null; achieved_on: string | null; location: string | null; governing_body: string | null;
  categories: { name: string } | null; record_sources: { id: string; url: string; publisher: string | null }[];
};

Deno.serve(async (req) => {
  if (!KEY) return json({ error: "Perplexity key secret is not set" }, 500);
  const body = await req.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(Number(body.limit ?? 5), 10));
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  let q = sb.from("records")
    .select("id,slug,title,holder,value_numeric,value_text,unit,achieved_on,location,governing_body,categories(name),record_sources(id,url,publisher)")
    .eq("status", "published").limit(limit);
  if (Array.isArray(body.slugs)) q = q.in("slug", body.slugs.slice(0, 10));
  if (body.featured === true) q = q.eq("featured", true);
  if (body.redo !== true) q = q.is("story", null).is("story_error", null);
  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);

  // One at a time: Perplexity limits how many requests run at once.
  const results: unknown[] = [];
  for (const r of (data ?? []) as unknown as Rec[]) {
    results.push(await writeStory(sb, r).catch(async (e) => {
      // A rate limit is temporary, so it is not saved as an error; the record is tried again next run.
      if (!String(e).includes("Perplexity 429")) await sb.from("records").update({ story_error: String(e).slice(0, 500) }).eq("id", r.id);
      return { slug: r.slug, error: String(e) };
    }));
  }
  return json({ done: results.length, results });
});

async function writeStory(sb: SupabaseClient, r: Rec) {
  const us = formatValue(r), metric = formatMetric(r);
  const figure = `${us.value} ${us.unit}`.trim() + (metric.value && `${metric.value} ${metric.unit}`.trim() !== `${us.value} ${us.unit}`.trim() ? ` (${metric.value} ${metric.unit})`.replace(" )", ")") : "");
  const facts = [
    `Record: ${r.title}`,
    `Category: ${r.categories?.name ?? ""}`,
    `Holder: ${r.holder ?? "unknown"}`,
    `Figure: ${figure}${r.value_text ? ` (stored as "${r.value_text}")` : ""}`,
    r.achieved_on && `Date set: ${r.achieved_on}`,
    r.location && `Location: ${r.location}`,
    r.governing_body && `Recognized by: ${r.governing_body}`,
    `Sources: ${r.record_sources.map((s) => s.url).join(" , ")}`,
  ].filter(Boolean).join("\n");

  const system = [
    "You write short, original record pages for brokenrecords.com, a world records site.",
    "Write for a curious general reader. Plain words, short sentences, active voice. No hype, no exclamation marks.",
    "Never use em dashes or en dashes. Use commas or periods instead.",
    "Use US units first, with metric in parentheses, matching the figure given.",
    "Only state facts you can support from the given sources or your web search. Do not invent numbers, dates, names or quotes.",
    "Do not copy sentences from sources. Write everything in your own words. Do not include citation markers like [1].",
    "If your search shows the stored figure, holder or date is wrong or outdated, explain briefly in 'conflict'. Otherwise set it to null.",
  ].join(" ");
  const user = `${facts}

Write three sections, 200 to 300 words in total:
1. A section about how the record was set or measured (heading like "How it was set" or "How it was measured", adapt to the record).
2. A section about the holder: who or what it is and why it matters (heading like "About ${r.holder ?? "the holder"}").
3. A section about the record before this one, how it compares, or what could break it next (pick the most interesting, heading to match).
Headings: 2 to 6 words, sentence case, no colons.
Quote: one short sentence or phrase (5 to 15 words) copied exactly, word for word, from one source page, with that page's URL. If you are not sure of the exact wording, set quote to null.
sources_used: the URLs you relied on most, best first, at most 4.`;

  // Up to 3 tries when Perplexity says "too many requests", waiting longer each time.
  let res: Response | undefined, text = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "story", schema: SCHEMA } },
      }),
      signal: AbortSignal.timeout(100_000),
    });
    text = await res.text();
    if (res.status !== 429) break;
    await new Promise((ok) => setTimeout(ok, 8000 * (attempt + 1)));
  }
  res = res!;
  if (!res.ok) throw new Error(`Perplexity ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  const out = JSON.parse(j?.choices?.[0]?.message?.content ?? "{}");
  const searchResults: { title?: string; url: string; date?: string }[] = j?.search_results ?? [];

  const clean = (s: string) => s.replace(/\s*\[\d+(?:,\s*\d+)*\]/g, "").replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();
  const sections = (out.sections ?? []).slice(0, 3).map((s: { heading: string; body: string }) => ({
    heading: clean(s.heading).replace(/[:.]$/, ""), body: clean(s.body),
  })).filter((s: { body: string }) => s.body.length > 40);
  if (sections.length < 2) throw new Error("story too short");

  // Keep the quote only if it appears word for word on the page it came from.
  let quote: { text: string; url: string } | null = null;
  if (out.quote?.text && out.quote?.url) {
    const qt = clean(out.quote.text).replace(/^["“]|["”]$/g, "");
    const words = qt.split(" ").length;
    if (words >= 4 && words <= 15 && await pageContains(out.quote.url, qt)) quote = { text: qt, url: out.quote.url };
  }

  // Source cards: add headline and date where the search found them; add up to 2 new cited sources.
  const meta = (u: string) => searchResults.find((s) => norm(s.url) === norm(u));
  for (const s of r.record_sources) {
    const m = meta(s.url);
    await sb.from("record_sources").update({
      title: m?.title ?? null,
      published_on: m?.date && /^\d{4}-\d{2}-\d{2}/.test(m.date) ? m.date.slice(0, 10) : null,
      quote: quote && norm(quote.url) === norm(s.url) ? quote.text : null,
    }).eq("id", s.id);
  }
  const have = new Set(r.record_sources.map((s) => norm(s.url)));
  const extra = (out.sources_used ?? []).filter((u: string) => /^https?:\/\//.test(u) && !have.has(norm(u))).slice(0, 2);
  for (const u of extra) {
    const m = meta(u);
    await sb.from("record_sources").insert({
      record_id: r.id, url: u, publisher: new URL(u).hostname.replace(/^www\./, ""),
      title: m?.title ?? null, published_on: m?.date && /^\d{4}-\d{2}-\d{2}/.test(m.date) ? m.date.slice(0, 10) : null,
      quote: quote && norm(quote.url) === norm(u) ? quote.text : null,
    });
  }

  const story = { sections, quote, conflict: out.conflict ?? null, model: MODEL, words: sections.reduce((n: number, s: { body: string }) => n + s.body.split(" ").length, 0) };
  await sb.from("records").update({ story, story_at: new Date().toISOString(), story_error: null }).eq("id", r.id);
  return { slug: r.slug, words: story.words, quote: !!quote, conflict: story.conflict, cost: j?.usage?.cost?.total_cost ?? null };
}

const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();

async function pageContains(url: string, phrase: string) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BrokenRecordsBot/1.0; +https://brokenrecords.com)" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return false;
    const page = (await res.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
    const simplify = (s: string) => s.replace(/&#8217;|&rsquo;|’|‘/g, "'").replace(/&#8220;|&#8221;|&quot;|“|”/g, '"').replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").toLowerCase();
    return simplify(page).includes(simplify(phrase).replace(/^"|"$/g, ""));
  } catch {
    return false;
  }
}

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });
