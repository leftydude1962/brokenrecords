// record-draft: researches new record topics so a person can approve them in a batch.
//
// Input rows: candidates with claude_json.kind = "draft" and claude_json.state = "todo".
// Each row holds a topic title, a category slug (category_guess) and better_direction.
// For each row it asks Perplexity (model "sonar", which searches the web) for the CURRENT
// record: holder, figure, date, place, and sources. It writes the answer back to the same
// candidate row and sets state = "done" (or "error").
//
// It NEVER creates or changes a record. Publishing happens only after a person approves.
//
// Body options: {"limit": 3} at most this many topics per call (default 3, max 8).
// Secret: PERPLEXITY_API_KEY (or PERPLEXITY_AI_KEY).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("PERPLEXITY_API_KEY") ?? Deno.env.get("PERPLEXITY_AI_KEY");
const ENDPOINT = "https://api.perplexity.ai/v1/sonar";
const MODEL = "sonar";

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
  if (!KEY) return json({ error: "Perplexity key secret is not set" }, 500);
  const body = await req.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(Number(body.limit ?? 3), 8));
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data, error } = await sb
    .from("candidates")
    .select("id,category_guess,claude_json")
    .eq("status", "pending")
    .eq("claude_json->>kind", "draft")
    .eq("claude_json->>state", "todo")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) return json({ error: error.message }, 500);
  const rows = (data ?? []) as Row[];

  // Claim the rows first, so an overlapping run does not research the same topic twice.
  for (const r of rows) {
    await sb.from("candidates").update({ claude_json: { ...r.claude_json, state: "working" } }).eq("id", r.id);
  }

  // One at a time, because Perplexity limits how many requests run at once.
  const results: unknown[] = [];
  for (const r of rows) {
    results.push(await research(sb, r).catch(async (e) => {
      await sb.from("candidates").update({ claude_json: { ...r.claude_json, state: "error", error: String(e).slice(0, 300) } }).eq("id", r.id);
      return { id: r.id, error: String(e).slice(0, 200) };
    }));
  }
  return json({ done: results.length, results });
});

async function research(sb: SupabaseClient, r: Row) {
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
  const user = `Topic: ${title}\nCategory: ${r.category_guess ?? "unknown"}\nA ${direction} figure is better.${check}\n\nReturn holder, value_numeric, unit, value_text, achieved_on (YYYY-MM-DD, or null if unknown), location, governing_body, definition, confidence, sources (the URLs you relied on, at most 5), and a one-sentence note.`;

  let res: Response | undefined, text = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "draft", schema: SCHEMA } },
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
  const urls = [...new Set(backed.length ? backed : [...cited])].slice(0, 5);
  const sites = new Set(urls.map(site).filter(Boolean));

  const { error } = await sb.from("candidates").update({
    proposed_holder: out.holder ?? null,
    proposed_value_numeric: typeof out.value_numeric === "number" ? out.value_numeric : null,
    proposed_value_text: out.value_text ?? null,
    unit: out.unit ?? null,
    source_urls: urls,
    checks_passed: { confidence: out.confidence, independent_sites: sites.size },
    claude_json: { ...r.claude_json, ...out, state: "done", model: MODEL, cost, researched_at: new Date().toISOString() },
  }).eq("id", r.id);
  if (error) throw new Error(error.message);
  return { id: r.id, title, confidence: out.confidence, sites: sites.size, cost };
}

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });
