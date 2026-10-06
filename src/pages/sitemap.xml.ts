import type { APIRoute } from "astro";
import { getCategories, getRecords } from "../lib/data";

export const GET: APIRoute = async () => {
  const [categories, records] = await Promise.all([getCategories(), getRecords()]);
  const base = "https://brokenrecords.com";
  const urls = [
    { loc: `${base}/`, lastmod: undefined as string | undefined },
    { loc: `${base}/category`, lastmod: undefined },
    ...categories.filter((c) => (c.count ?? 0) > 0).map((c) => ({ loc: `${base}/category/${c.slug}`, lastmod: undefined })),
    ...records.map((r) => ({ loc: `${base}/records/${r.slug}`, lastmod: (r.last_verified_at ?? r.updated_at ?? "").slice(0, 10) || undefined })),
  ];
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n") +
    `\n</urlset>\n`;
  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
};
