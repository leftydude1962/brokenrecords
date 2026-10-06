# brokenrecords.com

World records, kept current. Astro site rendered on Cloudflare Workers, reading live from the Broken Records Supabase project.

## How it fits together

- **Supabase** (project `ccwmynoumrqpvnmpcgch`) holds categories, records, sources, and the review queue. A nightly edge function (`wikidata-sync`) pulls records from Wikidata.
- **This site** renders every page on request from Supabase, so new records appear without a rebuild. Pages are cached for an hour.
- **Cloudflare Workers** hosts it at brokenrecords.com.

## Commands

    npm install        # once
    npm run dev        # local site at http://localhost:4321
    npm run build      # production build into dist/
    npm run deploy     # build and deploy with wrangler (needs `npx wrangler login` once)

## Pages

- `/` home: featured record, categories, all records
- `/category` and `/category/<slug>`
- `/records/<slug>` one page per record
- `/sitemap.xml`, `/robots.txt`
