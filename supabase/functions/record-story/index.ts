// record-story: writes an original 200 to 300 word story for a record page, then checks it.
//
// Why: each record page needs text of its own for search engines. Copying source articles is not
// allowed and would count as duplicate content, so this writes new text from the facts and sources.
//
// For each record it:
//   1. Fetches the text of the record's source pages (up to 3), plus the Wikipedia article about the holder
//      when one exists, and keeps the paragraphs about this record.
//   2. Writer (Claude Haiku 5.5 on KIE) writes three short sections using ONLY the record facts and that
//      source text. No web search, so it cannot pull in unchecked facts.
//   3. Checker (Gemini 3.5 Flash on KIE, a different model) lists any number, name, date or claim in the
//      story that the facts and source text do not support.
//   4. A story with no problems is published. A story with problems is saved but hidden (story.issues),
//      so the page keeps its fact grid until someone fixes or rewrites it.
//   5. A quote is kept only if it appears word for word in the fetched source text.
//
// Body options:
//   {"slugs": ["mens-100m"]}   only these records
//   {"featured": true}         only the featured records
//   {"limit": 5}               at most this many records per call (default 5, max 10)
//   {"redo": true}             rewrite records that already have a story
// Without slugs it picks published records with no story yet.
// Secrets: KIE_TEXT_API_KEY, or KIE_API_KEY when that is not set.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { formatValue, formatMetric } from "./format.ts";

const KEY = Deno.env.get("KIE_TEXT_API_KEY") ?? Deno.env.get("KIE_API_KEY");
const WRITER_MODEL = Deno.env.get("STORY_WRITER_MODEL") ?? "claude-haiku-5-5";
const WRITER_URL = "https://api.kie.ai/claude/v1/messages";
const CHECKER_MODEL = Deno.env.get("STORY_CHECKER_MODEL") ?? "gemini-3-5-flash-openai";
const checkerUrl = () => `https://api.kie.ai/${CHECKER_MODEL}/v1/chat/completions`;
const SOURCE_CHARS = 9000; // per source page, after keeping the relevant paragraphs

type Src = { id: string; url: string; publisher: string | null };
type Rec = {
  id: string; slug: string; title: string; holder: string | null; value_numeric: number | null; value_text: string | null;
  unit: string | null; achieved_on: string | null; location: string | null; governing_body: string | null;
  categories: { name: string } | null; record_sources: Src[];
};
type Section = { heading: string; body: string };

Deno.serve(async (req) => {
  if (!KEY) return json({ error: "KIE key secret is not set" }, 500);
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

  const results: unknown[] = [];
  for (const r of (data ?? []) as unknown as Rec[]) {
    results.push(await writeStory(sb, r).catch(async (e) => {
      // Busy or rate-limited services are temporary; the record is tried again next run.
      const temporary = /\b(429|500|502|503|504)\b|timed? ?out|overloaded|busy/i.test(String(e));
      if (!temporary) await sb.from("records").update({ story_error: String(e).slice(0, 500) }).eq("id", r.id);
      return { slug: r.slug, error: String(e) };
    }));
  }
  return json({ done: results.length, results });
});

async function writeStory(sb: SupabaseClient, r: Rec) {
  const us = formatValue(r), metric = formatMetric(r);
  const usText = `${us.value} ${us.unit}`.trim(), metricText = `${metric.value} ${metric.unit}`.trim();
  const figure = usText + (metricText && metricText !== usText ? ` (${metricText})` : "");
  const facts = [
    `Record: ${r.title}`,
    `Category: ${r.categories?.name ?? ""}`,
    `Holder: ${r.holder ?? "unknown"}`,
    `Figure: ${figure}${r.value_text ? ` (exact: "${r.value_text}")` : ""}`,
    r.achieved_on && `Date set: ${r.achieved_on}`,
    r.location && `Location: ${r.location}`,
    r.governing_body && `Recognized by: ${r.governing_body}`,
  ].filter(Boolean).join("\n");

  // 1. Source text.
  const keywords = [r.holder, r.title, r.value_text, String(r.value_numeric ?? "")].filter(Boolean).join(" ");
  const sources = (await Promise.all(r.record_sources.slice(0, 3).map(async (s) => ({ ...s, text: await sourceText(s.url, keywords) }))))
    .filter((s) => s.text && s.text.length > 200);
  // Add the Wikipedia article about the holder when the record does not already cite it.
  const wikiUrl = await wikipediaFor(r.holder ?? r.title);
  let addedWiki: string | null = null;
  if (wikiUrl && !r.record_sources.some((s) => norm(s.url) === norm(wikiUrl))) {
    const text = await sourceText(wikiUrl, keywords);
    if (text.length > 200) { sources.push({ id: "", url: wikiUrl, publisher: "Wikipedia", text }); addedWiki = wikiUrl; }
  }
  if (!sources.length) throw new Error("no readable source text");
  const sourceBlock = sources.map((s, i) => `[Source ${i + 1}] ${s.publisher ?? new URL(s.url).hostname} (${s.url})\n${s.text}`).join("\n\n");

  // 2. Write.
  const system = [
    "You write short, original record pages for brokenrecords.com, a world records site.",
    "Use ONLY the record facts and the source text you are given. If a detail is not in them, leave it out. Never guess or add outside knowledge.",
    "The record facts are the site's official figures. Use them exactly when you state the record, even if a source rounds them.",
    "Write for a curious general reader. Plain words, short sentences, active voice. No hype, no exclamation marks.",
    "Never use em dashes or en dashes. Use commas or periods instead.",
    "Use US units first, with metric in parentheses, matching the figure given.",
    "Write in your own words. Do not copy sentences from the sources. No citation markers.",
    "Write as a confident reference page. Never mention 'the sources', 'the site', 'this page' or what is unknown or not stated. If there is not enough material for a section, leave that section out.",
  ].join(" ");
  const user = `RECORD FACTS
${facts}

SOURCE TEXT
${sourceBlock}

Write up to three sections, 150 to 280 words in total (two sections is fine when material is thin):
1. How the record was set or measured (heading like "How it was set" or "How it was measured", adapted to the record).
2. About the holder: who or what it is and why it matters (heading like "About ${r.holder ?? "the holder"}").
3. The record before this one, how it compares, or what would beat it (pick what the sources support, heading to match).
Headings: 2 to 6 words, sentence case, no colons.
quote: one sentence or phrase of 5 to 15 words copied exactly from the source text, with its source number. Use null if nothing fits.
conflict: if the sources clearly disagree with the record facts (a different figure, holder or date), say how in one sentence. Otherwise null.
Reply by calling save_story.`;

  const tool = {
    name: "save_story",
    description: "Save the record page story.",
    input_schema: {
      type: "object",
      properties: {
        sections: { type: "array", items: { type: "object", properties: { heading: { type: "string" }, body: { type: "string" } }, required: ["heading", "body"] } },
        quote: { type: ["object", "null"], properties: { text: { type: "string" }, source: { type: "integer" } } },
        conflict: { type: ["string", "null"] },
      },
      required: ["sections", "quote", "conflict"],
    },
  };
  const w = await kie(WRITER_URL, {
    model: WRITER_MODEL, system, max_tokens: 2000, stream: false,
    messages: [{ role: "user", content: user }],
    tools: [tool], tool_choice: { type: "tool", name: "save_story" },
  });
  const blocks: { type: string; input?: unknown; text?: string }[] = w.content ?? [];
  let out = blocks.find((b) => b.type === "tool_use")?.input as { sections?: Section[]; quote?: { text: string; source: number } | null; conflict?: string | null } | undefined;
  if (!out) out = parseJson(blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
  if (!out) throw new Error("writer returned no story");

  const clean = (s: string) => s.replace(/\s*\[\d+(?:,\s*\d+)*\]/g, "").replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();
  const sections = (out.sections ?? []).slice(0, 3).map((s) => ({ heading: clean(s.heading).replace(/[:.]$/, ""), body: clean(s.body) }))
    .filter((s) => s.body.length > 40);
  if (sections.length < 2) throw new Error("story too short");

  // 5. Quote: only if it is really in the source text.
  let quote: { text: string; url: string } | null = null;
  if (out.quote?.text) {
    const qt = clean(out.quote.text).replace(/^["“]|["”]$/g, "");
    const n = qt.split(" ").length;
    const src = sources[(out.quote.source ?? 1) - 1] ?? sources.find((s) => simplify(s.text).includes(simplify(qt)));
    if (n >= 5 && n <= 15 && src && simplify(src.text).includes(simplify(qt))) quote = { text: qt, url: src.url };
  }

  // 3. Check with a second model.
  const storyText = sections.map((s) => `${s.heading}\n${s.body}`).join("\n\n");
  const c = await kie(checkerUrl(), {
    stream: false,
    messages: [
      { role: "system", content: "You are a strict fact checker. You compare a short story against record facts and source text. Reply with JSON only." },
      { role: "user", content: `RECORD FACTS\n${facts}\n\nSOURCE TEXT\n${sourceBlock}\n\nSTORY\n${storyText}\n\nList every number, date, name, ranking or factual claim in the STORY that is NOT supported by the RECORD FACTS or the SOURCE TEXT, or that contradicts them. Ignore wording, style and unit conversions that are correct. Reply exactly as JSON: {"unsupported": ["short description of each problem"]}. Use an empty list when everything is supported.` },
    ],
  });
  const checked = parseJson(c.choices?.[0]?.message?.content ?? "") as { unsupported?: string[] } | null;
  if (!checked || !Array.isArray(checked.unsupported)) throw new Error("checker busy: no usable reply");
  const issues = checked.unsupported.filter((x) => typeof x === "string" && x.trim()).slice(0, 8);

  // 4. Save. Sources get the quote; headlines and dates stay as they are.
  if (addedWiki && !issues.length) {
    await sb.from("record_sources").insert({ record_id: r.id, url: addedWiki, publisher: "Wikipedia", license: "CC BY-SA 4.0", title: decodeURIComponent(addedWiki.split("/wiki/")[1]).replace(/_/g, " ") });
  }
  if (quote && addedWiki && quote.url === addedWiki && issues.length) quote = null;
  for (const s of r.record_sources) {
    await sb.from("record_sources").update({ quote: quote && norm(quote.url) === norm(s.url) ? quote.text : null }).eq("id", s.id);
  }
  const words = sections.reduce((n, s) => n + s.body.split(" ").length, 0);
  const credits = Number(w.credits_consumed ?? 0) + Number(c.credits_consumed ?? 0);
  const story = { sections, quote, conflict: out.conflict ?? null, issues, writer: WRITER_MODEL, checker: CHECKER_MODEL, words, credits };
  if (quote && quote.url === addedWiki && !issues.length) await sb.from("record_sources").update({ quote: quote.text }).eq("record_id", r.id).eq("url", addedWiki);
  await sb.from("records").update({ story, story_at: new Date().toISOString(), story_error: null }).eq("id", r.id);
  return { slug: r.slug, words, published: issues.length === 0, issues, quote: !!quote, conflict: story.conflict, credits };
}

// KIE returns errors as HTTP 200 with {code, msg}; treat those as failures too. Retries busy responses.
async function kie(url: string, payload: unknown) {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    }).catch((e) => ({ ok: false, status: 504, text: async () => String(e) }) as unknown as Response);
    const text = await res.text();
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    const code = typeof j.code === "number" ? j.code : res.status;
    if (res.ok && (code === 200 || j.content || j.choices)) return j as Record<string, any>;
    last = `KIE ${code}: ${String(j.msg ?? text).slice(0, 200)}`;
    if (![429, 500, 502, 503, 504].includes(code)) break;
    await new Promise((ok) => setTimeout(ok, 6000 * (attempt + 1)));
  }
  throw new Error(last);
}

// Readable text of a source page, keeping the paragraphs most about this record.
async function sourceText(url: string, keywords: string): Promise<string> {
  try {
    let text = "";
    const wiki = url.match(/^https?:\/\/(\w+)\.wikipedia\.org\/wiki\/([^#?]+)/);
    if (wiki) {
      const api = `https://${wiki[1]}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${wiki[2]}`;
      const j = await (await fetch(api, { signal: AbortSignal.timeout(15_000) })).json();
      text = Object.values(j?.query?.pages ?? {}).map((p) => (p as { extract?: string }).extract ?? "").join("\n");
    } else {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BrokenRecordsBot/1.0; +https://brokenrecords.com)" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok || !/html|text/.test(res.headers.get("content-type") ?? "")) return "";
      text = (await res.text())
        .replace(/<(script|style|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<\/(p|div|li|h\d|tr|br)>/gi, "\n").replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/&#8220;|&#8221;|&quot;/g, '"');
    }
    const paras = text.split(/\n+/).map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p.length > 60);
    if (paras.join(" ").length <= SOURCE_CHARS) return paras.join("\n");
    // Score paragraphs by how many record words they mention; keep the best, in page order.
    const terms = [...new Set(keywords.toLowerCase().split(/[^a-z0-9.,]+/).filter((t) => t.length > 3 || /\d/.test(t)))];
    const scored = paras.map((p, i) => ({ p, i, s: terms.filter((t) => p.toLowerCase().includes(t)).length + (i < 3 ? 1 : 0) }));
    const keep: typeof scored = [];
    let size = 0;
    for (const x of [...scored].sort((a, b) => b.s - a.s)) {
      if (size + x.p.length > SOURCE_CHARS) continue;
      keep.push(x); size += x.p.length;
    }
    return keep.sort((a, b) => a.i - b.i).map((x) => x.p).join("\n");
  } catch {
    return "";
  }
}

// The English Wikipedia article that best matches a name, or null.
async function wikipediaFor(name: string): Promise<string | null> {
  try {
    const q = name.split(/[,(]/)[0].trim();
    const j = await (await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&srsearch=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10_000) })).json();
    const t: string | undefined = j?.query?.search?.[0]?.title;
    return t ? `https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}` : null;
  } catch {
    return null;
  }
}

function parseJson(s: string): any {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
const simplify = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").toLowerCase();
const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });
