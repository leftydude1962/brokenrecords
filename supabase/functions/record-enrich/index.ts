// record-enrich: makes thin record pages stronger. A record is thin when its sources come from fewer
// than 2 different websites, or when it has no date set.
//
// For each thin record it asks Perplexity (model "sonar", which searches the web) for independent
// pages that state the same holder and figure, and for the date the record was set. Then it:
//   - adds the sources it found from websites the record does not cite yet (up to 5 sources in total),
//   - fills in the date set, but only a full date (YYYY-MM-DD), only when the record has none,
//     and only when the search agrees with the holder and figure on the site,
//   - sets last_checked_at when the search agrees and the record now has 2 or more source websites,
//     because that is a real check against sources.
// It never changes the holder or the figure. When the search disagrees, it changes nothing except the
// enrich_note, which flags the record (enrich_note.flagged = true) for a person or the morning report.
// Each record is done once: records.enriched_at is set after its run.
//
// Body options: {"limit": 8} records per run (max 12). Locked like the other jobs (x-job-secret header).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("PERPLEXITY_API_KEY") ?? Deno.env.get("PERPLEXITY_AI_KEY");
const ENDPOINT = "https://api.perplexity.ai/v1/sonar";
const MAX_SOURCES = 5;

type Rec = {
  id: string; slug: string; title: string; holder: string | null; value_text: string | null; unit: string | null;
  achieved_on: string | null; record_sources: { url: string }[];
};

// "www.espn.com" and "espn.com/x" count as one website.
function site(url: string): string | null {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const p = h.split(".");
    const twoPartTld = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(p.slice(-2).join("."));
    return p.slice(twoPartTld ? -3 : -2).join(".");
  } catch { return null; }
}
const fullDate = (d: unknown) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= new Date().toISOString().slice(0, 10) ? d : null);

Deno.serve(async (req) => {
  if (!(await jobSecretOk(req))) return json({ error: "Not allowed" }, 401);
  if (!KEY) return json({ error: "Perplexity key secret is not set" }, 500);
  const body = await req.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(Number(body.limit ?? 8), 12));
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Read records not yet enriched; keep the thin ones and mark the complete ones as done.
  const { data, error } = await sb.from("records")
    .select("id,slug,title,holder,value_text,unit,achieved_on,record_sources(url)")
    .eq("status", "published").is("enriched_at", null).order("updated_at", { ascending: false }).limit(200);
  if (error) return json({ error: error.message }, 500);
  const all = (data ?? []) as Rec[];
  const thin = (r: Rec) => !r.achieved_on || new Set(r.record_sources.map((s) => site(s.url)).filter(Boolean)).size < 2;
  const complete = all.filter((r) => !thin(r)).map((r) => r.id);
  for (let i = 0; i < complete.length; i += 100) {
    await sb.from("records").update({ enriched_at: new Date().toISOString(), enrich_note: { skipped: "already had a date and 2+ source websites" } }).in("id", complete.slice(i, i + 100));
  }
  const todo = all.filter(thin).slice(0, limit);

  // Four at a time, to stay inside the search service's rate limit.
  const results: unknown[] = [];
  for (let i = 0; i < todo.length; i += 4) {
    results.push(...await Promise.all(todo.slice(i, i + 4).map((r) => enrich(sb, r).catch((e) => ({ slug: r.slug, error: String(e).slice(0, 200) })))));
  }
  const { count: left } = await sb.from("records").select("id", { count: "exact", head: true }).eq("status", "published").is("enriched_at", null);
  return json({ done: results.length, skippedComplete: complete.length, left, results });
});

async function enrich(sb: SupabaseClient, r: Rec) {
  const schema = {
    type: "object",
    properties: {
      agrees: { type: "boolean" }, achieved_on: { type: ["string", "null"] }, year: { type: ["integer", "null"] },
      sources: { type: "array", items: { type: "string" } }, note: { type: "string" },
    },
    required: ["agrees", "achieved_on", "year", "sources", "note"],
  };
  const today = new Date().toISOString().slice(0, 10);
  const user = `World record: "${r.title}". Holder on our site: ${r.holder ?? "unknown"}. Figure: ${r.value_text ?? "unknown"}${r.unit ? ` (${r.unit})` : ""}.\n` +
    "1. Find up to 4 independent, authoritative web pages that state this holder and this figure: governing bodies, Guinness World Records, " +
    "official league or event records, major news outlets, encyclopedias or university and government sites. Each from a different website.\n" +
    "2. Find the date this record was set, as YYYY-MM-DD. If only the year is known, set achieved_on to null and give the year.\n" +
    "3. agrees: true only if credible sources say this holder and figure are correct and still the record today.\n" +
    "Return agrees, achieved_on, year, sources (URLs) and a one-sentence note. Plain words. No em dashes.";
  let res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "system", content: `You check world records against their sources for a records website. Today is ${today}.` }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "enrich", schema } },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.status !== 429) break;
    await new Promise((ok) => setTimeout(ok, 6000 * (attempt + 1)));
  }
  // Rate limited three times: leave the record for the next run.
  if (!res || res.status === 429) return { slug: r.slug, skipped: "rate limited" };
  const text = await res.text();
  if (!res.ok) throw new Error(`Perplexity ${res.status}: ${text.slice(0, 150)}`);
  const j = JSON.parse(text);
  const out = JSON.parse(String(j?.choices?.[0]?.message?.content ?? "{}").replace(/^```(json)?|```$/g, "").trim());

  // Only URLs that appeared in the actual search results count.
  const cited = new Set<string>([...(j.citations ?? []), ...((j.search_results ?? []).map((s: { url: string }) => s.url))]);
  const backed = ((out.sources ?? []) as string[]).filter((u) => /^https?:\/\//.test(u) && cited.has(u));
  const haveSites = new Set(r.record_sources.map((s) => site(s.url)).filter(Boolean));
  const add: string[] = [];
  if (out.agrees === true) {
    for (const u of backed) {
      const s = site(u);
      if (!s || haveSites.has(s) || r.record_sources.length + add.length >= MAX_SOURCES) continue;
      haveSites.add(s);
      add.push(u);
    }
  }
  if (add.length) {
    await sb.from("record_sources").insert(add.map((u) => ({ record_id: r.id, url: u, publisher: site(u), license: null })));
  }
  const date = out.agrees === true && !r.achieved_on ? fullDate(out.achieved_on) : null;
  const now = new Date().toISOString();
  const checked = out.agrees === true && haveSites.size >= 2;
  const note = {
    agrees: out.agrees === true, added: add.length, date_set: date, year: out.year ?? null, note: String(out.note ?? "").slice(0, 300),
    flagged: out.agrees !== true, cost: j?.usage?.cost?.total_cost ?? null,
  };
  const { error } = await sb.from("records").update({
    enriched_at: now, enrich_note: note,
    ...(date ? { achieved_on: date } : {}),
    ...(checked ? { last_checked_at: now } : {}),
  }).eq("id", r.id);
  if (error) throw new Error(error.message);
  return { slug: r.slug, ...note };
}

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });

// Same check as the other scheduled jobs: compares the x-job-secret header with the job_secrets table.
async function jobSecretOk(req: Request): Promise<boolean> {
  const got = req.headers.get("x-job-secret");
  if (!got) return false;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data } = await admin.from("job_secrets").select("value").eq("key", "jobs").maybeSingle();
  return !!data?.value && data.value === got;
}
