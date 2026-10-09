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
