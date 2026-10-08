// record-recheck: confirms that a published record still stands, using a web search.
//
// Why: records.last_checked_at should only be set after a real check. The sync jobs set
// last_verified_at without searching each record, so that date is not a check.
//
// For each record it:
//   1. Asks Perplexity (model "sonar", which searches the web) whether the stored holder and figure still stand.
//   2. If the answer is a high-confidence "still holds", sets records.last_checked_at to now.
//   3. Otherwise (changed, unclear, or low confidence) it adds a row to candidates for review.
//      The live record is never changed by this function, and last_checked_at is not set.
//
// Body options:
//   {"limit": 5}              at most this many records (default 5, max 10). Oldest or never-checked first.
//   {"slugs": ["mens-100m"]}  only these records (max 10)
// Secret: PERPLEXITY_API_KEY (or PERPLEXITY_AI_KEY), already used by news-watcher.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("PERPLEXITY_API_KEY") ?? Deno.env.get("PERPLEXITY_AI_KEY");
const ENDPOINT = "https://api.perplexity.ai/v1/sonar";
const MODEL = "sonar";

const SCHEMA = {
  type: "object",
  properties: {
    still_holds: { type: "boolean" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    current_holder: { type: ["string", "null"] },
    current_value_text: { type: ["string", "null"] },
    sources: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
  required: ["still_holds", "confidence", "current_holder", "current_value_text", "sources", "note"],
};

type Rec = {
  id: string; slug: string; title: string; holder: string | null; value_numeric: number | null;
  value_text: string | null; unit: string | null; achieved_on: string | null; location: string | null;
};

Deno.serve(async (req) => {
  if (!KEY) return json({ error: "Perplexity key secret is not set" }, 500);
  const body = await req.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(Number(body.limit ?? 5), 10));
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  let q = sb.from("records")
    .select("id,slug,title,holder,value_numeric,value_text,unit,achieved_on,location")
    .eq("status", "published")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (Array.isArray(body.slugs)) q = q.in("slug", body.slugs.slice(0, 10));

  // Skip records already waiting for review, so they do not block the queue.
  const { data: waiting } = await sb.from("candidates").select("record_id,claude_json").eq("status", "pending");
  const skipIds = (waiting ?? []).filter((c) => c.claude_json?.kind === "recheck" && c.record_id).map((c) => c.record_id);
  if (skipIds.length) q = q.not("id", "in", `(${skipIds.join(",")})`);

  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);

  // One at a time, because Perplexity limits how many requests run at once.
  const results: unknown[] = [];
  for (const r of (data ?? []) as Rec[]) {
    results.push(await checkRecord(sb, r).catch((e) => ({ slug: r.slug, error: String(e).slice(0, 300) })));
  }
  return json({ done: results.length, results });
});

async function checkRecord(sb: SupabaseClient, r: Rec) {
  const figure = r.value_text ?? (r.value_numeric != null ? `${r.value_numeric} ${r.unit ?? ""}`.trim() : "unknown");
  const stored = [
    `Record: ${r.title}`,
    `Stored holder: ${r.holder ?? "unknown"}`,
    `Stored figure: ${figure}`,
    r.achieved_on && `Stored date set: ${r.achieved_on}`,
    r.location && `Stored location: ${r.location}`,
  ].filter(Boolean).join("\n");

  const system = [
    "You check whether a world record listed on a records website still stands today.",
    "Search the web for the current record. Compare it with the stored holder, figure and date.",
    "Set still_holds to true only when a current, credible source confirms the stored holder and figure.",
    "If you find a newer record holder, a changed figure, a correction, or you cannot confirm, set still_holds to false or confidence to low.",
    "Never guess. Use confidence high only when at least one source clearly confirms the stored record.",
    "Plain words. No em dashes.",
  ].join(" ");
  const user = `${stored}\n\nReturn still_holds, confidence (high, medium or low), current_holder and current_value_text (null if unchanged or unknown), sources (URLs you relied on, at most 4), and a one-sentence note.`;

  let res: Response | undefined, text = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "recheck", schema: SCHEMA } },
      }),
      signal: AbortSignal.timeout(100_000),
    });
    text = await res.text();
    if (res.status !== 429) break;
    await new Promise((ok) => setTimeout(ok, 8000 * (attempt + 1)));
  }
  res = res!;
  if (res.status === 429) return { slug: r.slug, skipped: "rate limited, try again later" };
  if (!res.ok) throw new Error(`Perplexity ${res.status}: ${text.slice(0, 200)}`);

  const j = JSON.parse(text);
  const out = JSON.parse(j?.choices?.[0]?.message?.content ?? "{}");
  const cost = j?.usage?.cost?.total_cost ?? null;
  const sources: string[] = (out.sources ?? []).filter((u: string) => /^https?:\/\//.test(u)).slice(0, 4);
  const now = new Date().toISOString();

  if (out.still_holds === true && out.confidence === "high") {
    const { error } = await sb.from("records").update({ last_checked_at: now }).eq("id", r.id);
    if (error) throw new Error(error.message);
    return { slug: r.slug, result: "confirmed", note: out.note, cost };
  }

  // Not confirmed: queue for a human to review. The live record is not touched.
  const { error } = await sb.from("candidates").insert({
    record_id: r.id,
    proposed_holder: out.current_holder ?? null,
    proposed_value_text: out.current_value_text ?? null,
    unit: r.unit,
    category_guess: null,
    source_urls: sources,
    claude_json: { ...out, model: MODEL, kind: "recheck" },
    checks_passed: { recheck: true, still_holds: out.still_holds, confidence: out.confidence },
    status: "pending",
  });
  if (error) throw new Error(error.message);
  return { slug: r.slug, result: "queued_for_review", note: out.note, cost };
}

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });
