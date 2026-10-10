// admin-review: lets the site owner see record corrections and approve, reject or hold them.
//
// Who can call it: only the signed-in Supabase user whose email is ADMIN_EMAIL below.
// The request must carry that user's login token (Authorization: Bearer ...). This function
// checks the token and the email itself, so the admin page is not the only guard.
//
// Actions (JSON body):
//   { action: "list" }
//   { action: "dashboard", days?: 14 }   daily numbers for the dashboard (see admin_dashboard in SQL)
//   { action: "approve", candidate_id, fields: { holder, value_numeric, value_text, unit, achieved_on, location } }
//   { action: "reject", candidate_id }
//   { action: "hold", candidate_id }
//   { action: "tips_list" }                                         tips from /tip with research results
//   { action: "tip_publish", candidate_id, fields, credit }          publish a tip as a new record
//   { action: "tip_update", candidate_id, record_slug, fields, credit }  apply a tip to an existing record
//   { action: "tip_reject", candidate_id }
//
// Approve follows the same steps as the recheck review: the old record is saved as a
// superseded history row, the live record is updated, and last_checked_at is set to now.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ADMIN_EMAIL = "info@mohrcreativegroup.com";
const ALLOWED_ORIGINS = ["https://brokenrecords.com", "https://www.brokenrecords.com"];

const corsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Vary": "Origin",
});

const json = (d: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });

const FIELD_KEYS = ["holder", "value_numeric", "value_text", "unit", "achieved_on", "location"] as const;

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in first." }, 401, origin);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  const email = userData?.user?.email?.toLowerCase();
  if (userErr || !email) return json({ error: "Sign in first." }, 401, origin);
  if (email !== ADMIN_EMAIL) return json({ error: "This account is not allowed here." }, 403, origin);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Send JSON." }, 400, origin);

  try {
    if (body.action === "list") return json(await listPending(sb), 200, origin);
    if (body.action === "dashboard") {
      const days = Math.max(7, Math.min(Number(body.days ?? 14) || 14, 60));
      const { data, error } = await sb.rpc("admin_dashboard", { days });
      if (error) throw new Error(error.message);
      return json(data, 200, origin);
    }

    if (body.action === "tips_list") return json(await listTips(sb), 200, origin);

    const candidateId = typeof body.candidate_id === "string" ? body.candidate_id : "";
    if (!candidateId) return json({ error: "Missing submission." }, 400, origin);

    if (body.action === "tip_publish") return json(await tipPublish(sb, candidateId, body.fields, body.credit === true, email), 200, origin);
    if (body.action === "tip_update") return json(await tipUpdate(sb, candidateId, String(body.record_slug ?? ""), body.fields, body.credit === true, email), 200, origin);
    if (body.action === "tip_reject") {
      const t = await loadTip(sb, candidateId);
      const { error } = await sb.from("candidates").update({
        status: "rejected",
        claude_json: { ...t.claude_json, reviewed_by: email, reviewed_at: new Date().toISOString() },
      }).eq("id", candidateId);
      if (error) throw new Error(error.message);
      return json({ ok: true }, 200, origin);
    }

    if (body.action === "reject") return json(await setStatus(sb, candidateId, "rejected", email), 200, origin);
    if (body.action === "hold") return json(await hold(sb, candidateId, email), 200, origin);
    if (body.action === "approve") return json(await approve(sb, candidateId, body.fields, email), 200, origin);

    return json({ error: "Unknown action." }, 400, origin);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e).slice(0, 300) }, 400, origin);
  }
});

async function listPending(sb: SupabaseClient) {
  const { data, error } = await sb
    .from("candidates")
    .select("id,created_at,proposed_value_text,source_urls,claude_json,records(id,slug,title,holder,value_numeric,value_text,unit,achieved_on,location)")
    .eq("status", "pending")
    .eq("claude_json->>kind", "submission")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return { items: data ?? [] };
}

async function setStatus(sb: SupabaseClient, id: string, status: "rejected", reviewer: string) {
  const c = await loadSubmission(sb, id);
  const { error } = await sb
    .from("candidates")
    .update({ status, claude_json: { ...c.claude_json, reviewed_by: reviewer, reviewed_at: new Date().toISOString() } })
    .eq("id", id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

async function hold(sb: SupabaseClient, id: string, reviewer: string) {
  const c = await loadSubmission(sb, id);
  const { error } = await sb
    .from("candidates")
    .update({ claude_json: { ...c.claude_json, held_by: reviewer, held_at: new Date().toISOString() } })
    .eq("id", id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

async function approve(sb: SupabaseClient, id: string, rawFields: unknown, reviewer: string) {
  const c = await loadSubmission(sb, id);
  const fields = (rawFields && typeof rawFields === "object" ? rawFields : {}) as Record<string, unknown>;

  // Only accept the known record fields. Blank strings become null.
  const update: Record<string, unknown> = {};
  for (const k of FIELD_KEYS) {
    if (!(k in fields)) continue;
    const v = fields[k];
    if (v === "" || v === undefined) update[k] = null;
    else if (k === "value_numeric") {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error("The numeric value must be a number.");
      update[k] = n;
    } else if (k === "achieved_on") {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("Date must look like 2026-10-03.");
      update[k] = v;
    } else {
      update[k] = String(v).slice(0, 500);
    }
  }
  if (!update.holder && !update.value_text && update.value_numeric == null) {
    throw new Error("Enter a holder or a figure before approving.");
  }

  const { data: rec, error: recErr } = await sb
    .from("records")
    .select("*")
    .eq("id", c.record_id)
    .single();
  if (recErr || !rec) throw new Error("The record for this submission was not found.");

  // 1. Save the old record as history.
  const stamp = new Date().getFullYear();
  const hex = crypto.randomUUID().slice(0, 4);
  const { error: histErr } = await sb.from("records").insert({
    slug: `${rec.slug}-${stamp}-${hex}`,
    category_id: rec.category_id,
    title: rec.title,
    holder: rec.holder,
    value_numeric: rec.value_numeric,
    value_text: rec.value_text,
    unit: rec.unit,
    better_direction: rec.better_direction,
    achieved_on: rec.achieved_on,
    location: rec.location,
    governing_body: rec.governing_body,
    wikidata_id: rec.wikidata_id,
    status: "superseded",
    superseded_by: rec.id,
    last_verified_at: rec.last_verified_at,
    featured: false,
  });
  if (histErr) throw new Error(histErr.message);

  // 2. Update the live record. The date of the check is now, because a person confirmed it.
  const { error: updErr } = await sb
    .from("records")
    .update({ ...update, last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", rec.id);
  if (updErr) throw new Error(updErr.message);

  // 3. Close the submission.
  const { error: candErr } = await sb
    .from("candidates")
    .update({
      status: "approved",
      claude_json: { ...c.claude_json, applied_fields: update, reviewed_by: reviewer, reviewed_at: new Date().toISOString() },
    })
    .eq("id", id);
  if (candErr) throw new Error(candErr.message);

  return { ok: true, slug: rec.slug };
}

async function loadSubmission(sb: SupabaseClient, id: string) {
  const { data, error } = await sb
    .from("candidates")
    .select("id,record_id,status,claude_json")
    .eq("id", id)
    .single();
  if (error || !data) throw new Error("Submission not found.");
  if (data.status !== "pending") throw new Error("This submission was already decided.");
  if (data.claude_json?.kind !== "submission") throw new Error("This is not a correction submission.");
  return data as { id: string; record_id: string; status: string; claude_json: Record<string, unknown> };
}

// ---------- Tips from the public /tip form ----------

type Tip = { id: string; category_guess: string | null; source_urls: string[] | null; claude_json: Record<string, unknown> };

// "www.espn.com/x" -> "espn.com". Used as the publisher shown next to each source.
function site(url: string): string | null {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const p = h.split(".");
    const twoPartTld = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(p.slice(-2).join("."));
    return p.slice(twoPartTld ? -3 : -2).join(".");
  } catch { return null; }
}

const STOP = new Set(["the", "and", "for", "from", "with", "most", "world", "record", "largest", "biggest", "longest", "fastest", "highest", "heaviest", "oldest"]);
const words = (s: string) => [...new Set(s.toLowerCase().normalize("NFKD").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))];

// Published records whose titles share most of their words with the tip's title.
function similar(title: string, recs: { slug: string; title: string; holder: string | null; value_text: string | null }[]) {
  const a = words(title);
  if (!a.length) return [];
  return recs
    .map((r) => {
      const b = words(r.title);
      const shared = a.filter((w) => b.includes(w)).length;
      return { r, score: b.length ? shared / Math.max(1, Math.min(a.length, b.length)) : 0 };
    })
    .filter((x) => x.score >= 0.6)
    .sort((x, y) => y.score - x.score)
    .slice(0, 3)
    .map((x) => x.r);
}

async function listTips(sb: SupabaseClient) {
  const { data, error } = await sb
    .from("candidates")
    .select("id,created_at,category_guess,source_urls,proposed_holder,proposed_value_text,proposed_value_numeric,unit,claude_json")
    .eq("status", "pending")
    .eq("claude_json->>kind", "draft")
    .eq("claude_json->>source", "tip")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  const { data: recs } = await sb.from("records").select("slug,title,holder,value_text").eq("status", "published");
  const { data: cats } = await sb.from("categories").select("slug,name,parent_id").not("parent_id", "is", null).order("name");
  const items = (data ?? []).map((t) => ({
    ...t,
    matches: similar(String(t.claude_json?.title ?? t.claude_json?.tip?.what ?? ""), recs ?? []),
  }));
  return {
    items,
    categories: (cats ?? []).filter((c) => !["buildings", "bridges", "structures"].includes(c.slug)).map((c) => ({ slug: c.slug, name: c.name })),
  };
}

async function loadTip(sb: SupabaseClient, id: string): Promise<Tip> {
  const { data, error } = await sb.from("candidates").select("id,status,category_guess,source_urls,claude_json").eq("id", id).single();
  if (error || !data) throw new Error("Tip not found.");
  if (data.status !== "pending") throw new Error("This tip was already decided.");
  if (data.claude_json?.kind !== "draft" || data.claude_json?.source !== "tip") throw new Error("This is not a tip.");
  return data as Tip;
}

// Reads and checks the record fields sent from the admin page. Blank strings become null.
function recordFields(raw: unknown) {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (k: string, max = 300) => (typeof f[k] === "string" && (f[k] as string).trim() ? (f[k] as string).trim().slice(0, max) : null);
  const n = f.value_numeric === "" || f.value_numeric == null ? null : Number(f.value_numeric);
  if (n !== null && !Number.isFinite(n)) throw new Error("The numeric value must be a number.");
  const d = s("achieved_on", 10);
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("Date must look like 2026-10-03.");
  const dir = s("better_direction");
  return {
    title: s("title", 120),
    category_slug: s("category_slug", 60),
    holder: s("holder"),
    value_text: s("value_text"),
    value_numeric: n,
    unit: s("unit", 40),
    achieved_on: d,
    location: s("location"),
    governing_body: s("governing_body", 120),
    better_direction: dir === "lower" ? "lower" : "higher",
  };
}

async function tipSources(sb: SupabaseClient, recordId: string, urls: string[]) {
  const rows = [...new Set(urls)].filter((u) => /^https?:\/\//.test(u)).slice(0, 5)
    .map((u) => ({ record_id: recordId, url: u, publisher: site(u), license: null }));
  if (rows.length) {
    const { error } = await sb.from("record_sources").insert(rows);
    if (error) throw new Error(error.message);
  }
}

async function tipPublish(sb: SupabaseClient, id: string, raw: unknown, credit: boolean, reviewer: string) {
  const t = await loadTip(sb, id);
  const f = recordFields(raw);
  if (!f.title) throw new Error("Enter a title.");
  if (!f.holder) throw new Error("Enter the holder.");
  if (!f.value_text && f.value_numeric == null) throw new Error("Enter the figure.");
  const { data: cat } = await sb.from("categories").select("id").eq("slug", f.category_slug ?? "").maybeSingle();
  if (!cat) throw new Error("Pick a category.");

  // A unique address made from the title: "heaviest-pumpkin", then "heaviest-pumpkin-2" and so on.
  const base = f.title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "record";
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const { data: taken } = await sb.from("records").select("id").eq("slug", slug).maybeSingle();
    if (!taken) break;
    slug = `${base}-${i}`;
  }

  const name = credit ? String((t.claude_json.tip as Record<string, unknown>)?.name ?? "").trim() || null : null;
  const now = new Date().toISOString();
  const { data: rec, error } = await sb.from("records").insert({
    slug, category_id: cat.id, title: f.title, holder: f.holder, value_text: f.value_text, value_numeric: f.value_numeric,
    unit: f.unit, achieved_on: f.achieved_on, location: f.location, governing_body: f.governing_body,
    better_direction: f.better_direction, status: "published", tipped_by: name,
    last_verified_at: now, last_checked_at: now, updated_at: now,
    // media-gen makes the poster from this within a few minutes.
    visual_prompt: `A cinematic scene that represents this world record: ${f.title}. No people's faces.`,
  }).select("id").single();
  if (error) throw new Error(error.message);
  await tipSources(sb, rec.id, t.source_urls ?? []);

  const { error: cErr } = await sb.from("candidates").update({
    status: "approved", record_id: rec.id,
    claude_json: { ...t.claude_json, applied: "new", slug, reviewed_by: reviewer, reviewed_at: now },
  }).eq("id", id);
  if (cErr) throw new Error(cErr.message);
  return { ok: true, slug };
}

async function tipUpdate(sb: SupabaseClient, id: string, recordSlug: string, raw: unknown, credit: boolean, reviewer: string) {
  const t = await loadTip(sb, id);
  const f = recordFields(raw);
  if (!f.holder) throw new Error("Enter the holder.");
  if (!f.value_text && f.value_numeric == null) throw new Error("Enter the figure.");
  const { data: rec, error: rErr } = await sb.from("records").select("*").eq("slug", recordSlug).eq("status", "published").maybeSingle();
  if (rErr || !rec) throw new Error("That record was not found.");

  // 1. Keep the current holder as a history page that points to the live record.
  const year = rec.achieved_on?.slice(0, 4) ?? "previous";
  const now = new Date().toISOString();
  const { data: hist, error: hErr } = await sb.from("records").insert({
    slug: `${rec.slug}-${year}-${crypto.randomUUID().slice(0, 4)}`,
    category_id: rec.category_id, title: `${rec.title} (${year})`, holder: rec.holder,
    value_numeric: rec.value_numeric, value_text: rec.value_text, unit: rec.unit, better_direction: rec.better_direction,
    achieved_on: rec.achieved_on, location: rec.location, governing_body: rec.governing_body, wikidata_id: rec.wikidata_id,
    status: "superseded", superseded_by: rec.id, last_verified_at: rec.last_verified_at, featured: false,
  }).select("id").single();
  if (hErr) throw new Error(hErr.message);

  // 2. Move the current sources to the history page, then give the live record the tip's sources.
  const { error: mErr } = await sb.from("record_sources").update({ record_id: hist.id }).eq("record_id", rec.id);
  if (mErr) throw new Error(mErr.message);
  await tipSources(sb, rec.id, t.source_urls ?? []);

  // 3. Update the live record.
  const name = credit ? String((t.claude_json.tip as Record<string, unknown>)?.name ?? "").trim() || null : null;
  const { error: uErr } = await sb.from("records").update({
    holder: f.holder, value_text: f.value_text, value_numeric: f.value_numeric, unit: f.unit ?? rec.unit,
    achieved_on: f.achieved_on, location: f.location, governing_body: f.governing_body ?? rec.governing_body,
    tipped_by: name, last_verified_at: now, last_checked_at: now, updated_at: now,
  }).eq("id", rec.id);
  if (uErr) throw new Error(uErr.message);

  const { error: cErr } = await sb.from("candidates").update({
    status: "approved", record_id: rec.id,
    claude_json: { ...t.claude_json, applied: "update", slug: rec.slug, reviewed_by: reviewer, reviewed_at: now },
  }).eq("id", id);
  if (cErr) throw new Error(cErr.message);
  return { ok: true, slug: rec.slug };
}
