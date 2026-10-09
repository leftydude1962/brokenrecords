// admin-review: lets the site owner see record corrections and approve, reject or hold them.
//
// Who can call it: only the signed-in Supabase user whose email is ADMIN_EMAIL below.
// The request must carry that user's login token (Authorization: Bearer ...). This function
// checks the token and the email itself, so the admin page is not the only guard.
//
// Actions (JSON body):
//   { action: "list" }
//   { action: "approve", candidate_id, fields: { holder, value_numeric, value_text, unit, achieved_on, location } }
//   { action: "reject", candidate_id }
//   { action: "hold", candidate_id }
//
// Approve follows the same steps as the recheck review: the old record is saved as a
// superseded history row, the live record is updated, and last_checked_at is set to now.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ADMIN_EMAIL = "mohr.keith@gmail.com";
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

    const candidateId = typeof body.candidate_id === "string" ? body.candidate_id : "";
    if (!candidateId) return json({ error: "Missing submission." }, 400, origin);

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
