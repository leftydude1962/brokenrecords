// social-post: posts a world record to the Broken Records Facebook Page and Instagram account
// three times a day: 6 AM, noon and 6 PM Central.
//
// A cron job calls this at 11, 12, 17, 18, 23 and 0 UTC. Only the calls that land on 6, 12 or 18
// in Chicago post, so the times stay right through daylight saving changes. One post per slot.
//
// Which record:
//   1. A record the news watcher added or updated in the last 2 days and not yet posted ("New record").
//   2. Otherwise a record never posted before, from the section posted least recently, so the feed
//      rotates through sports, nature, space, music and the rest.
// The post is the record's image with a short caption and a link to its page.
//
// Secrets: FB_PAGE_TOKEN (a Page access token with pages_manage_posts, plus instagram_basic and
// instagram_content_publish for Instagram). The Page ID and Instagram account come from the token.
// Instagram feed posts must be 4:5 to 1.91:1, so Instagram gets a 4:5 crop made by Supabase Storage.
// Body options: {"dryRun": true} shows the caption without posting; {"force": true} skips the time check;
// {"check": true} reports which Page and Instagram account the token reaches.
import { createClient } from "npm:@supabase/supabase-js@2";
import { formatValue } from "./format.ts";

const GRAPH = "https://graph.facebook.com/v23.0";
const SITE = "https://brokenrecords.com";
const SLOTS = [6, 12, 18]; // Chicago hours

const fbGet = async (path: string, token: string) =>
  (await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`)).json().catch(() => ({}));

// 4:5 crop of a poster for Instagram, made on the fly by Supabase Storage image transforms.
const igImage = (posterUrl: string) =>
  posterUrl.split("?")[0].replace("/storage/v1/object/public/", "/storage/v1/render/image/public/") +
  "?width=1080&height=1350&resize=cover&quality=90&format=origin";

type Row = {
  id: string; slug: string; title: string; holder: string | null; value_numeric: number | null; value_text: string | null;
  unit: string | null; achieved_on: string | null; location: string | null; poster_url: string | null; updated_at: string | null;
  created_at: string | null; category_id: string;
};

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const force = body?.force === true;
  // {"check": true}: ask Facebook which Page and Instagram account the token reaches. Never returns the token.
  if (body?.check === true) {
    const t = Deno.env.get("FB_PAGE_TOKEN") ?? "";
    const me = await fbGet("me?fields=id,name,instagram_business_account{id,username}", t);
    const sample = await createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)
      .from("records").select("poster_url").not("poster_url", "is", null).limit(1).single();
    let crop: unknown = null;
    if (sample.data?.poster_url) {
      const r = await fetch(igImage(sample.data.poster_url));
      crop = { status: r.status, type: r.headers.get("content-type"), bytes: (await r.arrayBuffer()).byteLength };
    }
    return json({ token_length: t.length, me, instagram_crop: crop });
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Post only in the 6 AM, noon and 6 PM Chicago slots, once per slot.
  const now = new Date();
  const chicagoSlot = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).format(d);
  const chicagoHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(now));
  if (!force && !dryRun && !SLOTS.includes(chicagoHour)) return json({ skipped: `not a posting hour in Chicago (hour ${chicagoHour})` });
  // Manual test posts (force) don't count toward a slot.
  const { data: recent } = await sb.from("social_posts").select("posted_at,kind").eq("platform", "facebook").is("error", null)
    .gt("posted_at", new Date(now.getTime() - 3 * 3600 * 1000).toISOString());
  const postedThisSlot = (recent ?? []).some((p) => p.kind !== "test" && chicagoSlot(new Date(p.posted_at)) === chicagoSlot(now));
  if (!dryRun && !force && postedThisSlot) return json({ skipped: "already posted this slot" });

  // Categories and sections, to label the post and rotate through sections.
  const { data: cats } = await sb.from("categories").select("id,slug,name,parent_id");
  const byId = new Map((cats ?? []).map((c) => [c.id, c]));
  const sectionOf = (catId: string) => {
    const c = byId.get(catId);
    return c?.parent_id ? byId.get(c.parent_id) ?? c : c;
  };

  const { data: posted } = await sb.from("social_posts").select("record_id,posted_at").eq("platform", "facebook").is("error", null);
  const lastPost = new Map<string, string>();
  for (const p of posted ?? []) if (p.record_id) lastPost.set(p.record_id, p.posted_at);

  const cols = "id,slug,title,holder,value_numeric,value_text,unit,achieved_on,location,poster_url,updated_at,created_at,category_id";
  const { data: recs } = await sb.from("records").select(cols).eq("status", "published").not("poster_url", "is", null);
  const all = (recs ?? []) as Row[];

  // 1. Fresh news: a record the news watcher published or updated in the last 2 days, not posted since.
  //    The watcher logs each change in the candidates table (new records match by title).
  const { data: news } = await sb.from("candidates").select("record_id,created_at,claude_json")
    .in("status", ["auto_published", "approved"]).gt("created_at", new Date(Date.now() - 48 * 3600 * 1000).toISOString())
    .order("created_at", { ascending: false });
  let pick: Row | undefined;
  for (const n of news ?? []) {
    const title = (n.claude_json as { title?: string } | null)?.title?.trim().toLowerCase();
    const r = all.find((x) => (n.record_id && x.id === n.record_id) || (!n.record_id && title && x.title.toLowerCase() === title));
    if (r && !(Date.parse(lastPost.get(r.id) ?? "") > Date.parse(n.created_at))) { pick = r; break; }
  }
  const isNews = !!pick;

  // 2. Rotation: never-posted records from the section posted least recently.
  if (!pick) {
    const sectionLast = new Map<string, number>();
    for (const r of all) {
      const s = sectionOf(r.category_id)?.id ?? "";
      const t = Date.parse(lastPost.get(r.id) ?? "") || 0;
      sectionLast.set(s, Math.max(sectionLast.get(s) ?? 0, t));
    }
    const unposted = all.filter((r) => !lastPost.has(r.id));
    const pool = unposted.length ? unposted : all;
    pool.sort((a, b) => (sectionLast.get(sectionOf(a.category_id)?.id ?? "") ?? 0) - (sectionLast.get(sectionOf(b.category_id)?.id ?? "") ?? 0) || Math.random() - 0.5);
    pick = pool[0];
  }
  if (!pick) return json({ error: "no record with an image to post" }, 500);

  const v = formatValue({ ...pick, title: pick.title });
  const figure = `${v.value}${v.unit ? " " + v.unit : ""}`;
  const section = sectionOf(pick.category_id)?.name ?? "World records";
  const year = pick.achieved_on ? pick.achieved_on.slice(0, 4) : null;
  const where = [pick.location, year].filter(Boolean).join(", ");
  const tag = "#" + section.split(/[^A-Za-z]+/).filter((w) => w && w !== "and").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  const message = [
    isNews ? `NEW RECORD: ${pick.title}` : pick.title,
    "",
    `${figure}${pick.holder ? ` · ${pick.holder}` : ""}`,
    where || null,
    "",
    `Sources and the full record: ${SITE}/records/${pick.slug}`,
    "",
    `#WorldRecord ${tag}`,
  ].filter((l) => l !== null).join("\n");

  // Instagram captions can't hold clickable links, so point to the site by name.
  const igMessage = [
    isNews ? `NEW RECORD: ${pick.title}` : pick.title,
    "",
    `${figure}${pick.holder ? ` · ${pick.holder}` : ""}`,
    where || null,
    "",
    "Sources and the full record at brokenrecords.com (link in bio)",
    "",
    `#WorldRecord #WorldRecords ${tag} #DidYouKnow #BrokenRecords`,
  ].filter((l) => l !== null).join("\n");

  if (dryRun) return json({ dryRun: true, record: pick.slug, isNews, image: pick.poster_url, igImage: igImage(pick.poster_url!), message, igMessage });

  const token = Deno.env.get("FB_PAGE_TOKEN");
  if (!token) return json({ error: "FB_PAGE_TOKEN secret is not set" }, 500);
  // A Page token knows its own Page, so ask Facebook for the ID instead of trusting FB_PAGE_ID.
  const pageId = (await fbGet("me?fields=id", token))?.id ?? Deno.env.get("FB_PAGE_ID");

  const form = new URLSearchParams({ url: pick.poster_url!.split("?")[0], caption: message, published: "true", access_token: token });
  const res = await fetch(`${GRAPH}/${pageId}/photos`, { method: "POST", body: form });
  const out = await res.json().catch(() => ({}));
  const ok = res.ok && (out.post_id || out.id);
  const kind = force ? "test" : isNews ? "news" : "daily";
  await sb.from("social_posts").insert({
    record_id: pick.id, platform: "facebook", kind, message,
    external_id: ok ? out.post_id ?? out.id : null, error: ok ? null : JSON.stringify(out.error ?? out).slice(0, 500),
  });

  // Instagram: create a media container from the 4:5 crop, wait until it is ready, then publish it.
  let ig: Record<string, unknown> = { skipped: "no Instagram account linked to the Page" };
  const igId = (await fbGet("me?fields=instagram_business_account", token))?.instagram_business_account?.id;
  if (igId) {
    const c = await (await fetch(`${GRAPH}/${igId}/media`, { method: "POST", body: new URLSearchParams({ image_url: igImage(pick.poster_url!), caption: igMessage, access_token: token }) })).json().catch(() => ({}));
    let published: { id?: string; error?: unknown } = {};
    if (c.id) {
      for (let i = 0; i < 10; i++) {
        const st = await fbGet(`${c.id}?fields=status_code`, token);
        if (st.status_code === "FINISHED" || st.status_code === "ERROR") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      published = await (await fetch(`${GRAPH}/${igId}/media_publish`, { method: "POST", body: new URLSearchParams({ creation_id: c.id, access_token: token }) })).json().catch(() => ({}));
    }
    const igOk = !!published.id;
    ig = igOk ? { posted: published.id } : { error: published.error ?? c.error ?? c };
    await sb.from("social_posts").insert({
      record_id: pick.id, platform: "instagram", kind, message: igMessage,
      external_id: igOk ? published.id : null, error: igOk ? null : JSON.stringify(ig.error).slice(0, 500),
    });
  }
  return json(ok ? { posted: pick.slug, post_id: out.post_id ?? out.id, instagram: ig } : { error: out.error ?? out, instagram: ig }, ok ? 200 : 502);
});

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });
