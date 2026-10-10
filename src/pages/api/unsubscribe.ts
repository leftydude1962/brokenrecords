// One-click unsubscribe for mail apps (the List-Unsubscribe header in the weekly email).
// Gmail and Apple Mail send POST /api/unsubscribe?t=TOKEN when the reader clicks "Unsubscribe".
// A GET (someone opening the link) goes to the /alerts page, which shows a message.
import type { APIRoute } from "astro";

const FN = "https://ccwmynoumrqpvnmpcgch.supabase.co/functions/v1/subscribe";

export const POST: APIRoute = async ({ url }) => {
  const token = url.searchParams.get("t") ?? "";
  const res = await fetch(FN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "unsubscribe", token }),
  }).catch(() => null);
  return new Response(res?.ok ? "Unsubscribed" : "Link not valid", {
    status: res?.ok ? 200 : 400,
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
  });
};

export const GET: APIRoute = ({ url, redirect }) =>
  redirect(`/alerts?unsubscribe=${encodeURIComponent(url.searchParams.get("t") ?? "")}`, 302);
