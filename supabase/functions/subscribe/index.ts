// subscribe: the email list for weekly record alerts.
//
// Actions (POST, JSON body):
//   { action: "subscribe", email, source?, source_detail?, turnstile_token, website? }
//       Adds the address as "pending" and emails a confirm link. Always answers {ok:true} for a
//       valid request, so the form never reveals whether an address is already on the list.
//   { action: "confirm", token }      the link in the confirm email (called by /alerts on the site)
//   { action: "unsubscribe", token }  the link in every email (called by /alerts and /api/unsubscribe)
//
// Double opt-in: nobody gets the weekly email until they click the confirm link.
// Public endpoint (verify_jwt = false). Bot check (Turnstile) and a rate limit guard "subscribe".
// Secrets: TURNSTILE_SECRET_KEY, RESEND_API_KEY. Without RESEND_API_KEY the address is still saved,
// and the mail-jobs function sends the confirm email once the key is added.
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE = "https://brokenrecords.com";
const FROM = "Broken Records <info@brokenrecords.com>";
const ALLOWED_ORIGINS = ["https://brokenrecords.com", "https://www.brokenrecords.com"];
const RATE_LIMIT = 5;          // signups per IP hash ...
const RATE_WINDOW_MIN = 10;    // ... in this many minutes
const RESEND_GAP_MIN = 10;     // at most one confirm email per address in this many minutes

const corsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
});
const json = (d: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) throw new Error("TURNSTILE_SECRET_KEY is not set");
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip !== "unknown") form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const out = await res.json().catch(() => ({ success: false }));
  return out.success === true;
}

// The confirm email. Plain layout so it renders the same in every mail app.
function confirmEmail(token: string) {
  const link = `${SITE}/alerts?confirm=${token}`;
  return {
    subject: "Confirm your Broken Records alerts",
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#eceff1;font-family:Georgia,serif;color:#17212b">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px"><tr><td style="padding:28px">
<p style="margin:0 0 16px;font:900 22px Arial,sans-serif"><span style="color:#c98a12">Broken</span> Records</p>
<p style="margin:0 0 16px;font-size:17px;line-height:1.5">Confirm your email and we'll send you the world records that fell each week, with sources.</p>
<p style="margin:24px 0"><a href="${link}" style="background:#f2b33d;color:#000;text-decoration:none;font:700 16px Arial,sans-serif;padding:12px 20px;border-radius:6px;display:inline-block">Yes, send me record alerts</a></p>
<p style="margin:0;font-size:14px;color:#4a5866">If you didn't sign up, ignore this email. You won't hear from us again.</p>
</td></tr></table></body></html>`,
    text: `Confirm your email and we'll send you the world records that fell each week.\n\nConfirm: ${link}\n\nIf you didn't sign up, ignore this email.`,
  };
}

async function sendConfirm(email: string, token: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return false;
  const m = confirmEmail(token);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [email], subject: m.subject, html: m.html, text: m.text }),
  });
  return res.ok;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Send JSON." }, 400, origin);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const action = str(body.action) || "subscribe";

  // ----- Confirm and unsubscribe: the token is the proof. -----
  if (action === "confirm" || action === "unsubscribe") {
    const token = str(body.token);
    if (!isUuid(token)) return json({ error: "That link is not valid." }, 400, origin);
    const { data: sub } = await sb.from("subscribers").select("id,status").eq("token", token).maybeSingle();
    if (!sub) return json({ error: "That link is not valid or has expired." }, 404, origin);
    const now = new Date().toISOString();
    if (action === "confirm") {
      if (sub.status === "unsubscribed") return json({ ok: true, status: "unsubscribed" }, 200, origin);
      if (sub.status !== "confirmed") await sb.from("subscribers").update({ status: "confirmed", confirmed_at: now }).eq("id", sub.id);
      return json({ ok: true, status: "confirmed" }, 200, origin);
    }
    if (sub.status !== "unsubscribed") await sb.from("subscribers").update({ status: "unsubscribed", unsubscribed_at: now }).eq("id", sub.id);
    return json({ ok: true, status: "unsubscribed" }, 200, origin);
  }

  if (action !== "subscribe") return json({ error: "Unknown action." }, 400, origin);

  // ----- Subscribe -----
  if (str(body.website)) return json({ ok: true }, 200, origin); // honeypot: pretend success
  const email = str(body.email).toLowerCase();
  if (!email || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json({ error: "That email address does not look right." }, 400, origin);
  }
  const source = str(body.source).replace(/[^a-z0-9-]/g, "").slice(0, 40) || null;
  const sourceDetail = str(body.source_detail).replace(/[^a-z0-9-]/g, "").slice(0, 120) || null;

  const token = str(body.turnstile_token);
  if (!token) return json({ error: "Please wait a moment and try again." }, 400, origin);
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  try {
    if (!(await verifyTurnstile(token, ip))) return json({ error: "The check did not pass. Refresh the page and try again." }, 403, origin);
  } catch {
    return json({ error: "Something went wrong. Try again later." }, 500, origin);
  }

  const ipHash = await sha256Hex(ip + "|subscribe");
  const since = new Date(Date.now() - RATE_WINDOW_MIN * 60_000).toISOString();
  const { count } = await sb.from("subscribers").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", since);
  if ((count ?? 0) >= RATE_LIMIT) return json({ error: "Too many signups at once. Try again in a few minutes." }, 429, origin);

  const { data: existing } = await sb.from("subscribers").select("id,status,token,confirm_sent_at,confirm_count").eq("email", email).maybeSingle();
  if (existing?.status === "confirmed") return json({ ok: true }, 200, origin);

  let row = existing;
  if (!row) {
    const { data, error } = await sb.from("subscribers")
      .insert({ email, source, source_detail: sourceDetail, ip_hash: ipHash })
      .select("id,status,token,confirm_sent_at,confirm_count").single();
    if (error) return json({ error: "Something went wrong. Try again later." }, 500, origin);
    row = data;
  } else if (row.status === "unsubscribed") {
    // Signing up again after leaving: back to pending with a fresh link.
    const { data } = await sb.from("subscribers")
      .update({ status: "pending", token: crypto.randomUUID(), unsubscribed_at: null, confirm_sent_at: null, source, source_detail: sourceDetail })
      .eq("id", row.id).select("id,status,token,confirm_sent_at,confirm_count").single();
    row = data ?? row;
  }

  // Send the confirm email, at most once every few minutes per address, and at most 5 times in all.
  const recent = row!.confirm_sent_at && Date.now() - Date.parse(row!.confirm_sent_at) < RESEND_GAP_MIN * 60_000;
  if (!recent && (row!.confirm_count ?? 0) < 5) {
    const sent = await sendConfirm(email, row!.token);
    if (sent) {
      await sb.from("subscribers").update({ confirm_sent_at: new Date().toISOString(), confirm_count: (row!.confirm_count ?? 0) + 1 }).eq("id", row!.id);
    }
  }
  return json({ ok: true }, 200, origin);
});
