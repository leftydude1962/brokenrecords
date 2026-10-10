// mail-jobs: scheduled emails, run by cron.
// Locked: the request must carry the x-job-secret header, which only cron has. Cron reads the
// value from the job_secrets table at run time, so it is never written in code. The public key
// alone is not enough, because it is public.
//
// Jobs (POST, JSON body):
//   { job: "confirmations" }
//       Sends the confirm email to new signups that have not had one yet (for example signups
//       made before RESEND_API_KEY was set, or from the checkbox on the tip form). Every 10 minutes.
//   { job: "digest" }
//       The weekly email: records broken or added in the last 7 days, to every confirmed
//       subscriber. Mondays. Sends at most once per week (email_sends has one row per week).
//       Skips the week when nothing qualifies.
//   { job: "digest", test_to: "you@example.com" }
//       Sends this week's digest to one address only, marked TEST, and records nothing.
//
// Secrets: RESEND_API_KEY, MAIL_POSTAL_ADDRESS (required by US law in the weekly email).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SITE = "https://brokenrecords.com";
const FROM = "Broken Records <info@brokenrecords.com>";
const KEY = Deno.env.get("RESEND_API_KEY");
const POSTAL = Deno.env.get("MAIL_POSTAL_ADDRESS");

type Item = {
  kind: "broken" | "new"; slug: string; title: string; holder: string | null; display_value: string | null;
  old_holder: string | null; old_value: string | null; poster_url: string | null; category_name: string | null;
};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });

// Monday of the current week (UTC), used to send the digest only once per week.
function weekOf(d = new Date()): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

async function resendBatch(emails: unknown[]) {
  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(emails),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// ---------- Confirm emails that are waiting ----------
async function confirmations(sb: SupabaseClient) {
  if (!KEY) return { skipped: "RESEND_API_KEY is not set" };
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await sb.from("subscribers").select("id,email,token,confirm_count")
    .eq("status", "pending").is("confirm_sent_at", null).gt("created_at", weekAgo).limit(50);
  const rows = data ?? [];
  if (!rows.length) return { sent: 0 };
  await resendBatch(rows.map((r) => {
    const link = `${SITE}/alerts?confirm=${r.token}`;
    return {
      from: FROM, to: [r.email], subject: "Confirm your Broken Records alerts",
      html: `<!doctype html><html><body style="margin:0;padding:24px;background:#eceff1;font-family:Georgia,serif;color:#17212b">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px"><tr><td style="padding:28px">
<p style="margin:0 0 16px;font:900 22px Arial,sans-serif"><span style="color:#c98a12">Broken</span> Records</p>
<p style="margin:0 0 16px;font-size:17px;line-height:1.5">Confirm your email and we'll send you the world records that fell each week, with sources.</p>
<p style="margin:24px 0"><a href="${link}" style="background:#f2b33d;color:#000;text-decoration:none;font:700 16px Arial,sans-serif;padding:12px 20px;border-radius:6px;display:inline-block">Yes, send me record alerts</a></p>
<p style="margin:0;font-size:14px;color:#4a5866">If you didn't sign up, ignore this email. You won't hear from us again.</p>
</td></tr></table></body></html>`,
      text: `Confirm your email and we'll send you the world records that fell each week.\n\nConfirm: ${link}\n\nIf you didn't sign up, ignore this email.`,
    };
  }));
  const now = new Date().toISOString();
  for (const r of rows) await sb.from("subscribers").update({ confirm_sent_at: now, confirm_count: (r.confirm_count ?? 0) + 1 }).eq("id", r.id);
  return { sent: rows.length };
}

// ---------- Weekly digest ----------
function subjectFor(items: Item[]) {
  const broken = items.filter((i) => i.kind === "broken");
  const lead = (broken.length ? broken : items).slice(0, 2).map((i) => i.title);
  const more = items.length > lead.length ? " and more" : "";
  if (broken.length) return `${broken.length} record${broken.length === 1 ? "" : "s"} fell this week: ${lead.join(", ")}${more}`;
  return `New world records this week: ${lead.join(", ")}${more}`;
}

function digestHtml(items: Item[], token: string, test: boolean) {
  const unsub = `${SITE}/alerts?unsubscribe=${token}`;
  const rows = items.map((i) => {
    const url = `${SITE}/records/${i.slug}?utm_source=email&utm_medium=digest`;
    const img = i.poster_url
      ? `<td width="96" valign="top" style="padding:0 14px 0 0"><a href="${esc(url)}"><img src="${esc(i.poster_url)}" width="96" height="96" alt="" style="display:block;width:96px;height:96px;object-fit:cover;border-radius:6px"></a></td>`
      : "";
    const tag = i.kind === "broken"
      ? `<span style="background:#c8102e;color:#fff;font:700 11px Arial,sans-serif;padding:3px 6px;border-radius:3px;letter-spacing:.04em">RECORD BROKEN</span>`
      : `<span style="background:#17212b;color:#f2b33d;font:700 11px Arial,sans-serif;padding:3px 6px;border-radius:3px;letter-spacing:.04em">NEW RECORD</span>`;
    const was = i.kind === "broken" && i.old_holder
      ? `<p style="margin:4px 0 0;font-size:14px;color:#4a5866">Beat: ${esc(i.old_holder)}${i.old_value ? `, ${esc(i.old_value)}` : ""}</p>` : "";
    return `<tr><td style="padding:16px 0;border-bottom:1px solid #dde2e6"><table role="presentation" width="100%"><tr>${img}<td valign="top">
${tag}${i.category_name ? ` <span style="font:12px Arial,sans-serif;color:#4a5866">${esc(i.category_name)}</span>` : ""}
<p style="margin:6px 0 2px;font:800 18px Arial,sans-serif"><a href="${esc(url)}" style="color:#17212b;text-decoration:none">${esc(i.title)}</a></p>
<p style="margin:0;font-size:15px">${esc(i.holder)}${i.display_value ? ` · <strong>${esc(i.display_value)}</strong>` : ""}</p>${was}
</td></tr></table></td></tr>`;
  }).join("");
  return `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#eceff1;font-family:Georgia,serif;color:#17212b">
<table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px"><tr><td style="padding:24px 24px 8px">
${test ? `<p style="margin:0 0 12px;font:700 13px Arial,sans-serif;color:#c8102e">TEST SEND. Subscribers did not get this copy.</p>` : ""}
<p style="margin:0;font:900 24px Arial,sans-serif"><span style="color:#c98a12">Broken</span> Records</p>
<p style="margin:4px 0 8px;font-size:15px;color:#4a5866">This week's broken and new world records, each with its sources.</p>
<table role="presentation" width="100%">${rows}</table>
<p style="margin:20px 0 6px;font-size:15px"><a href="${SITE}/latest?utm_source=email&utm_medium=digest" style="color:#1d5c8f;font-weight:700">See everything that changed</a></p>
<p style="margin:0 0 20px;font-size:15px">Saw a record fall that we missed? <a href="${SITE}/tip?utm_source=email&utm_medium=digest" style="color:#1d5c8f;font-weight:700">Tip us off</a> and get credit when it goes live.</p>
</td></tr><tr><td style="padding:16px 24px 24px;border-top:1px solid #dde2e6;font:12px/1.5 Arial,sans-serif;color:#4a5866">
You get this because you signed up for record alerts at brokenrecords.com. <a href="${esc(unsub)}" style="color:#4a5866">Unsubscribe</a> with one click.<br>
${esc(POSTAL ?? "")}
</td></tr></table></body></html>`;
}

function digestText(items: Item[], token: string) {
  const lines = items.map((i) =>
    `${i.kind === "broken" ? "RECORD BROKEN" : "NEW RECORD"}: ${i.title}\n${i.holder ?? ""}${i.display_value ? `, ${i.display_value}` : ""}` +
    (i.kind === "broken" && i.old_holder ? `\nBeat: ${i.old_holder}${i.old_value ? `, ${i.old_value}` : ""}` : "") +
    `\n${SITE}/records/${i.slug}`);
  return `This week's broken and new world records\n\n${lines.join("\n\n")}\n\nSaw a record fall that we missed? ${SITE}/tip\n\n` +
    `Unsubscribe: ${SITE}/alerts?unsubscribe=${token}\n${POSTAL ?? ""}`;
}

async function digest(sb: SupabaseClient, testTo: string | null) {
  if (!KEY) return { skipped: "RESEND_API_KEY is not set" };
  if (!POSTAL) return { skipped: "MAIL_POSTAL_ADDRESS is not set (US law requires a postal address in the weekly email)" };
  const { data: items, error } = await sb.rpc("digest_items", { days: 7 });
  if (error) throw new Error(error.message);
  const list = (items ?? []) as Item[];
  if (!list.length) return { skipped: "no records broken or added this week" };
  const subject = subjectFor(list);

  if (testTo) {
    await resendBatch([{ from: FROM, to: [testTo], subject: `[TEST] ${subject}`, html: digestHtml(list, "00000000-0000-0000-0000-000000000000", true), text: digestText(list, "00000000-0000-0000-0000-000000000000") }]);
    return { test: true, to: testTo, items: list.length, subject };
  }

  // Claim this week first, so two runs can't both send.
  const week = weekOf();
  const { data: claim, error: cErr } = await sb.from("email_sends").insert({ kind: "digest", week_of: week, subject, items: list.length }).select("id").single();
  if (cErr) return { skipped: `digest for the week of ${week} was already sent` };

  let sent = 0, from = 0;
  const pageSize = 100; // Resend batch limit
  try {
    for (;;) {
      const { data: subs } = await sb.from("subscribers").select("id,email,token").eq("status", "confirmed").order("created_at").range(from, from + pageSize - 1);
      if (!subs?.length) break;
      await resendBatch(subs.map((s) => ({
        from: FROM, to: [s.email], subject,
        html: digestHtml(list, s.token, false), text: digestText(list, s.token),
        headers: {
          "List-Unsubscribe": `<${SITE}/api/unsubscribe?t=${s.token}>, <mailto:info@brokenrecords.com?subject=unsubscribe>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      })));
      await sb.from("subscribers").update({ last_digest_at: new Date().toISOString() }).in("id", subs.map((s) => s.id));
      sent += subs.length;
      from += pageSize;
      if (subs.length < pageSize) break;
    }
  } catch (e) {
    await sb.from("email_sends").update({ recipients: sent, error: String(e).slice(0, 300) }).eq("id", claim.id);
    throw e;
  }
  await sb.from("email_sends").update({ recipients: sent }).eq("id", claim.id);
  return { sent, items: list.length, subject };
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: secret } = await sb.from("job_secrets").select("value").eq("key", "jobs").maybeSingle();
  if (!secret?.value || req.headers.get("x-job-secret") !== secret.value) return json({ error: "Not allowed" }, 401);
  try {
    if (body.job === "confirmations") return json(await confirmations(sb));
    if (body.job === "digest") {
      const testTo = typeof body.test_to === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.test_to) ? body.test_to : null;
      return json(await digest(sb, testTo));
    }
    return json({ error: "Unknown job" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e).slice(0, 300) }, 500);
  }
});
