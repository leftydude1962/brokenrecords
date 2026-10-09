import type { APIRoute } from "astro";
import { getSearchIndex, cacheFor } from "../lib/data";

// The list the header search box filters as you type. Cached at the edge for an hour,
// so new records show up in search within about an hour.
export const GET: APIRoute = async () => {
  const items = await getSearchIndex();
  const res = new Response(JSON.stringify(items), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
  cacheFor(3600, res);
  return res;
};
