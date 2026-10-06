import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: "https://brokenrecords.com",
  output: "server",
  adapter: cloudflare(),
  trailingSlash: "never",
});
