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
// Tips from the public /tip form (claude_json.source = "tip") are free text, so for those it
// also asks for a clean title, the category, which direction is better, and whether the tip
// describes a real, reported record (is_record). The visitor's link is given to the search.
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
  return json({ done: results.length, results });
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
