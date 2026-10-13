import { rest } from "./data";

export type LatestItem = {
  kind: "broken" | "new";
  is_broken: boolean;
  changed_at: string;
  id: string;
  slug: string;
  title: string;
  holder: string | null;
  display_value: string | null;
  achieved_on: string | null;
  old_holder: string | null;
  old_value: string | null;
  old_achieved_on: string | null;
  poster_url: string | null;
  video_url: string | null;
  category_slug: string | null;
  category_name: string | null;
};

/** Newest broken + new records for the home page. Broken ones sort first. */
export async function getLatest(limit = 8): Promise<LatestItem[]> {
  try {
    return await rest<LatestItem[]>(
      `latest_feed?select=*&order=is_broken.desc,changed_at.desc&limit=${limit}`
    );
  } catch (err) {
    // Never let this section take the home page down.
    console.error("getLatest failed", err);
    return [];
  }
}

/** Today's date in Chicago as YYYY-MM-DD, minus `back` days. The site's day starts at midnight Central. */
export function chicagoDay(back = 0): string {
  const d = new Date(Date.now() - back * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
}

export type JustBroken = { items: LatestItem[]; days: 3 | 7 };

/**
 * The home page "Just broken" section: records actually SET in the last 3 days (today, yesterday,
 * the day before), by the date they were set, not the date we found them. A record set weeks ago
 * that we only just added stays out; it appears on /latest instead. If nothing was set in 3 days,
 * it widens to 7 so the section is never empty or stale.
 */
export async function getJustBroken(limit = 12): Promise<JustBroken> {
  const q = (from: string) =>
    rest<LatestItem[]>(
      `latest_feed?select=*&achieved_on=gte.${from}&achieved_on=lte.${chicagoDay(0)}&order=achieved_on.desc,is_broken.desc,changed_at.desc&limit=${limit}`
    );
  try {
    const three = await q(chicagoDay(2));
    if (three.length) return { items: three, days: 3 };
    return { items: await q(chicagoDay(6)), days: 7 };
  } catch (err) {
    console.error("getJustBroken failed", err);
    return { items: [], days: 3 };
  }
}
