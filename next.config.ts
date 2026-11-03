import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // The pre-push build writes to its own folder so it never disturbs a running dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  cacheComponents: true,
  // No dev badge in screenshots or recordings.
  devIndicators: false,
  partialPrefetching: true,
  // Clients that don't run JavaScript get one finished HTML document instead of a streamed shell,
  // so the dashboard's records are visible text, not a "Loading…" fallback. Next's default list
  // (copied from next/dist/shared/lib/router/utils/html-bots.js, since this setting replaces it)
  // plus AI fetchers and plain HTTP clients.
  htmlLimitedBots: new RegExp(
    [
      String.raw`[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight`,
      String.raw`ChatGPT-User|GPTBot|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|Claude-Web|anthropic-ai|PerplexityBot|Perplexity-User|meta-externalagent|meta-externalfetcher|CCBot|Bytespider|cohere-ai`,
      String.raw`^curl/|^Wget/|python-requests|python-httpx|aiohttp|node-fetch|undici|axios|Go-http-client|okhttp|libwww-perl`,
    ].join("|"),
    "i",
  ),
  turbopack: {
    rules: {
      // Tailwind runs on plain stylesheets only: `as: "*.css"` on a .module.css file would drop its class mapping
      // (every `styles.x` came back undefined).
      "*.css": {
        condition: { not: { path: /\.module\.css$/ } },
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
