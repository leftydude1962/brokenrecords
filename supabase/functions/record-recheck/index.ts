// record-recheck: confirms that a published record still stands, using a web search.
//
// Why: records.last_checked_at should only be set after a real check. The sync jobs set
// last_verified_at without searching each record, so that date is not a check.
//
// For each record it:
//   1. Asks Perplexity (model "sonar", which searches the web) whether the stored holder and figure still stand.
//   2. If the answer is a high-confidence "still holds", sets records.last_checked_at to now.
//   3. Otherwise it saves the answer in candidates, sorted (claude_json.triage) into:
//        new_holder     a different holder is named        -> waits for review
//        figure_update  same holder, a different figure    -> waits for review
//        no_change      same holder, same or no new figure -> closed at once
//        unconfirmed    low confidence, same holder         -> closed at once
//      The live record is never changed by this function, and last_checked_at is not set.
//
// How often: a record is checked again only after 30 days (RECHECK_DAYS). A record with any
// recheck result in the last 30 days is skipped too, so an unclear answer is not repeated
// every few minutes. The daily news check catches new records between rechecks.
//
// Body options:
//   {"limit": 5}              at most this many records (default 5, max 10). Never-checked first, then oldest.
//   {"slugs": ["mens-100m"]}  only these records (max 10)
// Secret: PERPLEXITY_API_KEY (or PERPLEXITY_AI_KEY), already used by news-watcher.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("PERPLEXITY_API_KEY") ?? Deno.env.get("PERPLEXITY_AI_KEY");
const ENDPOINT = "https://api.perplexity.ai/v1/sonar";
const MODEL = "sonar";
const RECHECK_DAYS = 30;

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
  // Locked: only the scheduled jobs may run this (see jobSecretOk at the end of this file).
  if (!(await jobSecretOk(req))) {
    return new Response(JSON.stringify({ error: "Not allowed" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (!KEY) return json({ error: "Perplexity key secret is not set" }, 500);
  const body = await req.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(Number(body.limit ?? 5), 10));
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const cutoff = new Date(Date.now() - RECHECK_DAYS * 86_400_000).toISOString();
  const named = Array.isArray(body.slugs);
  let q = sb.from("records")
    .select("id,slug,title,holder,value_numeric,value_text,unit,achieved_on,location")
    .eq("status", "published")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(named ? 10 : 200);
  if (named) q = q.in("slug", body.slugs.slice(0, 10));
  else q = q.or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`);

  // Skip records waiting for review, or with any recheck result in the last 30 days.
  const { data: recent } = await sb.from("candidates")
    .select("record_id")
    .eq("claude_json->>kind", "recheck")
    .or(`status.eq.pending,created_at.gt.${cutoff}`);
  const skip = new Set((recent ?? []).map((c) => c.record_id).filter(Boolean));

  const { data: found, error } = await q;
  if (error) return json({ error: error.message }, 500);
  const data = ((found ?? []) as Rec[]).filter((r) => named || !skip.has(r.id)).slice(0, limit);
  if (!data.length) return json({ done: 0, note: "Nothing due for a recheck." });

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

  // Not confirmed: sort the answer. Only a named new holder or a new figure waits for review.
  const triage = triageOf(r, out);
  const { error } = await sb.from("candidates").insert({
    record_id: r.id,
    proposed_holder: out.current_holder ?? null,
    proposed_value_text: out.current_value_text ?? null,
    unit: r.unit,
    category_guess: null,
    source_urls: sources,
    claude_json: { ...out, model: MODEL, kind: "recheck", triage },
    checks_passed: { recheck: true, still_holds: out.still_holds, confidence: out.confidence },
    status: triage === "new_holder" || triage === "figure_update" ? "pending" : "rejected",
  });
  if (error) throw new Error(error.message);
  return { slug: r.slug, result: triage, note: out.note, cost };
}

// Words of a name, without case, accents, punctuation and filler words.
function words(s: string | null | undefined): string[] {
  const skip = new Set(["the", "and", "for", "from", "with", "its", "inc", "ltd", "team", "national"]);
  return [...new Set((s ?? "").toLowerCase().normalize("NFKD").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !skip.has(w)))];
}

// Same holder when at least half the words of the shorter name appear in the other.
// Matches the SQL function public.same_holder. Null when a name is empty.
function sameHolder(a: string | null, b: string | null): boolean | null {
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return null;
  const shared = wa.filter((w) => wb.includes(w)).length;
  return shared / Math.min(wa.length, wb.length) >= 0.5;
}

// First number in a figure: "1,295.8 kg (2,856 lb)" -> 1295.8.
function firstNumber(s: string | null | undefined): number | null {
  const m = (s ?? "").match(/[0-9][0-9,]*\.?[0-9]*/);
  return m ? Number(m[0].replace(/,/g, "")) : null;
}

function triageOf(r: Rec, out: { confidence?: string; current_holder?: string | null; current_value_text?: string | null }) {
  if (out.current_holder && sameHolder(r.holder, out.current_holder) === false) return "new_holder";
  const a = firstNumber(r.value_text), b = firstNumber(out.current_value_text);
  if (out.current_value_text && (a == null || b == null || a !== b)) {
    return out.confidence === "low" ? "unconfirmed" : "figure_update";
  }
  return "no_change";
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
