// media-gen: makes a still image and a short looping video for each record, through KIE.ai.
//
// Each record moves through these states (records.media_status):
//   null            -> waiting to start
//   image_pending   -> Seedream is drawing the poster image
//   video_pending   -> Seedance is animating that image into a 5 second clip (featured records only)
//   done            -> poster_url is set, and video_url too for featured records
//   failed          -> two attempts failed; media_error says why
//
// Nothing calls this on a schedule; it runs only when invoked. Each call checks the tasks in progress, saves finished
// files to Supabase Storage (bucket "media"), and starts new records. Spending is bounded in code:
// a record that already has media is never regenerated, and no more than MAX_VIDEOS clips are ever
// made in total. Every other record gets a still image only (about 3 KIE credits each).
import { createClient } from "jsr:@supabase/supabase-js@2";

const KIE = "https://api.kie.ai/api/v1/jobs";
const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const IMAGE_MODEL = env("MEDIA_IMAGE_MODEL", "seedream/5-flash-text-to-image");
const VIDEO_MODEL = env("MEDIA_VIDEO_MODEL", "bytedance/seedance-2-fast");
const RESOLUTION = env("MEDIA_RESOLUTION", "720p");
const DAILY_CAP = Number(env("MEDIA_DAILY_CAP", "400"));
const MAX_INFLIGHT = Number(env("MEDIA_MAX_INFLIGHT", "20"));
// Hard limit on clips, about 124 KIE credits each. Change it here, in code, on purpose.
const MAX_VIDEOS = 10;
const TIMEOUT_MS = 2 * 60 * 60 * 1000;

const STILL_STYLE =
  "Cinematic photograph, dramatic lighting, rich contrast, deep dark tones, vertical 9:16 composition. " +
  "Keep the top third and the bottom quarter darker and uncluttered for text overlay. " +
  "No text, no letters, no numbers, no logos, no watermarks, no recognizable real people.";
const MOTION_STYLE =
  "Slow cinematic camera movement with subtle natural motion, smooth and steady, suitable for a seamless loop. " +
  "No text, no captions, no logos, no recognizable real people.";

type Rec = {
  id: string; slug: string; visual_prompt: string | null; media_status: string | null;
  media_task_id: string | null; media_attempts: number; media_started_at: string | null; poster_url: string | null;
  featured: boolean;
};
const COLS = "id,slug,visual_prompt,media_status,media_task_id,media_attempts,media_started_at,poster_url,featured";

Deno.serve(async (req) => {
  const key = Deno.env.get("KIE_API_KEY");
  if (!key) return json({ error: "KIE_API_KEY is not set" }, 500);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const body = await req.json().catch(() => ({}));
  const only: string[] | null = Array.isArray(body.only) ? body.only.slice(0, 10) : null;
  const startLimit = Math.max(0, Math.min(Number(body.start ?? MAX_INFLIGHT), MAX_INFLIGHT));
  const log: Record<string, unknown>[] = [];
  const startedAt = new Date().toISOString();

  const kie = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${KIE}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || (j.code && j.code !== 200)) throw new Error(`KIE ${res.status} ${j.code ?? ""} ${j.msg ?? ""}`.trim());
    return j.data;
  };
  const createTask = async (model: string, input: Record<string, unknown>) =>
    (await kie("createTask", { method: "POST", body: JSON.stringify({ model, input }) })).taskId as string;

  const store = async (url: string, path: string, type: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { error } = await sb.storage.from("media").upload(path, bytes, { contentType: type, upsert: true, cacheControl: "31536000" });
    if (error) throw new Error(`upload: ${error.message}`);
    return `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/media/${path}?v=${Date.now()}`;
  };

  const startVideo = (r: Rec, posterUrl: string) =>
    createTask(VIDEO_MODEL, {
      prompt: `${r.visual_prompt}. ${MOTION_STYLE}`,
      first_frame_url: posterUrl.split("?")[0],
      resolution: RESOLUTION,
      aspect_ratio: "9:16",
      duration: 5,
      generate_audio: false,
    });

  // Clips made or in progress. Checked before every new clip so the total never passes MAX_VIDEOS.
  const videoCount = async () => {
    const { count } = await sb.from("records").select("id", { count: "exact", head: true })
      .or("video_url.not.is.null,media_status.eq.video_pending");
    return count ?? MAX_VIDEOS;
  };
  const wantsVideo = async (r: Rec) => r.featured && (await videoCount()) < MAX_VIDEOS;

  const fail = async (r: Rec, msg: string) => {
    const attempts = r.media_attempts + 1;
    await sb.from("records").update({
      media_status: attempts >= 2 ? "failed" : null, media_task_id: null, media_error: msg.slice(0, 500), media_attempts: attempts,
    }).eq("id", r.id);
    log.push({ slug: r.slug, failed: msg, attempts });
  };

  // 1. Check tasks already running.
  const { data: inflight } = await sb.from("records")
    .select(COLS)
    .in("media_status", ["image_pending", "video_pending"]);
  let running = 0;
  for (const r of (inflight ?? []) as Rec[]) {
    try {
      const t = await kie(`recordInfo?taskId=${encodeURIComponent(r.media_task_id ?? "")}`);
      if (t.state === "success") {
        const result = typeof t.resultJson === "string" ? JSON.parse(t.resultJson) : t.resultJson;
        const out = result?.resultUrls?.[0];
        if (!out) throw new Error("no result url");
        if (r.media_status === "image_pending") {
          const poster = await store(out, `posters/${r.slug}.jpg`, "image/jpeg");
          if (await wantsVideo(r)) {
            const taskId = await startVideo(r, poster);
            await sb.from("records").update({ poster_url: poster, media_status: "video_pending", media_task_id: taskId }).eq("id", r.id);
            log.push({ slug: r.slug, poster: "saved", video: "started", credits: t.creditsConsumed });
            running++;
          } else {
            await sb.from("records").update({ poster_url: poster, media_status: "done", media_task_id: null, media_error: null }).eq("id", r.id);
            log.push({ slug: r.slug, poster: "saved", credits: t.creditsConsumed });
          }
        } else {
          const video = await store(out, `videos/${r.slug}.mp4`, "video/mp4");
          await sb.from("records").update({ video_url: video, media_status: "done", media_task_id: null, media_error: null }).eq("id", r.id);
          log.push({ slug: r.slug, video: "saved", credits: t.creditsConsumed });
        }
      } else if (t.state === "fail") {
        await fail(r, `${t.failCode ?? ""} ${t.failMsg ?? "failed"}`.trim());
      } else if (r.media_started_at && Date.now() - Date.parse(r.media_started_at) > TIMEOUT_MS) {
        await fail(r, "timed out");
      } else {
        running++;
      }
    } catch (e) {
      log.push({ slug: r.slug, error: String(e) });
      running++;
    }
  }

  // 2. Start new records, within the in-flight limit and the 24 hour cap.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: today } = await sb.from("records").select("id", { count: "exact", head: true }).gte("media_started_at", since);
  const slots = Math.min(startLimit, MAX_INFLIGHT - running, DAILY_CAP - (today ?? 0));
  if (slots > 0) {
    let q = sb.from("records").select(COLS)
      .eq("status", "published").is("media_status", null).not("visual_prompt", "is", null)
      .order("featured", { ascending: false }).order("media_priority", { ascending: true, nullsFirst: false }).limit(slots);
    if (only) q = q.in("slug", only);
    const { data: next } = await q;
    for (const r of (next ?? []) as Rec[]) {
      try {
        // A record whose poster already exists (a retry after a video failure) goes straight to video.
        if (r.poster_url) {
          if (!(await wantsVideo(r))) {
            await sb.from("records").update({ media_status: "done", media_error: null }).eq("id", r.id);
            continue;
          }
          const taskId = await startVideo(r, r.poster_url);
          await sb.from("records").update({ media_status: "video_pending", media_task_id: taskId, media_started_at: new Date().toISOString() }).eq("id", r.id);
          log.push({ slug: r.slug, video: "restarted" });
          continue;
        }
        const taskId = await createTask(IMAGE_MODEL, {
          prompt: `${r.visual_prompt}. ${STILL_STYLE}`,
          aspect_ratio: "9:16",
          size: "1K",
          output_format: "jpeg",
        });
        await sb.from("records").update({ media_status: "image_pending", media_task_id: taskId, media_started_at: new Date().toISOString(), media_error: null }).eq("id", r.id);
        log.push({ slug: r.slug, image: "started" });
      } catch (e) {
        await fail(r, String(e));
      }
    }
  }

  const stats = { checked: inflight?.length ?? 0, started_today: today ?? 0, slots: Math.max(0, slots), log };
  if (log.length) await sb.from("sync_runs").insert({ source: "media-gen", dry_run: false, started_at: startedAt, finished_at: new Date().toISOString(), stats });
  return json(stats);
});

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });
