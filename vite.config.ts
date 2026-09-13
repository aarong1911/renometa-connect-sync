import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

// Netlify Dev's [[redirects]] "/*" -> "/index.html" rewrite (needed so a
// direct refresh on a client-side route like /settings resolves to the SPA
// shell) breaks conditional requests for the rewritten document: when the
// browser sends "If-None-Match" with the ETag Vite issued on the previous
// load, Netlify Dev's proxy returns "200 OK" with an empty body instead of
// either a real 304 or the full document. The browser renders that empty
// response, producing an intermittent blank page on refresh — reproducible
// via curl, and confirmed absent both on :5173 (direct Vite, no rewrite) and
// on :9999 paths that aren't rewritten (Vite's own 304 handling is correct).
// "Disable cache" in devtools "fixes" it only because it stops the browser
// from ever sending "If-None-Match" in the first place.
//
// [[headers]] in netlify.toml does not apply to responses proxied from the
// Vite dev target (confirmed empirically — an added Cache-Control header
// never appeared on proxied responses), so the fix has to prevent the
// browser from caching the SPA document in the first place, at the source:
// Vite's own dev server. Scoped to document requests only (no file
// extension, not one of Vite's dev-internal paths) so JS/CSS module
// requests keep their normal ETag/304 caching untouched, and this plugin is
// a no-op for the production `dist` build served by Netlify's CDN.
function noStoreSpaDocument() {
  return {
    name: "no-store-spa-document",
    configureServer(server: import("vite").ViteDevServer) {
      // Vite's own HTML-serving middleware (which sets Cache-Control:
      // no-cache + an ETag on the transformed index.html) ends the
      // response directly rather than calling next(), so a middleware
      // registered after it — including one returned from this hook to
      // run "post" — never gets a turn for document requests. Instead,
      // wrap res.setHeader from an early (pre) middleware so it can
      // intercept and override the values Vite sets later in the same
      // request/response cycle, before headers are flushed.
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const path = url.split("?")[0];
        const isDevInternal = /^\/(@|src\/|node_modules\/|\.netlify\/)/.test(path);
        // Netlify Dev's "/*" -> "/index.html" rewrite means the request Vite
        // actually receives for a client-side route (e.g. /settings) has
        // already been rewritten to "/index.html" by the time it reaches
        // here — which DOES have a file extension, so it must be treated as
        // the SPA document, not as a normal cacheable static asset.
        const isDocument = path === "/index.html" || path === "/";
        const hasFileExtension = /\.[a-zA-Z0-9]+$/.test(path);
        if (!isDevInternal && (isDocument || !hasFileExtension)) {
          const originalSetHeader = res.setHeader.bind(res);
          res.setHeader = ((name: string, value: unknown) => {
            const lower = typeof name === "string" ? name.toLowerCase() : "";
            if (lower === "cache-control") return originalSetHeader("Cache-Control", "no-store");
            if (lower === "etag") return res;
            return originalSetHeader(name, value as string);
          }) as typeof res.setHeader;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    TanStackRouterVite(),
    react(),
    tailwindcss(),
    tsconfigPaths(),
    noStoreSpaDocument(),
  ],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  server: {
    proxy: {
      "/.netlify/functions": {
        target: "http://localhost:9999",
        changeOrigin: true,
      },
    },
  },
});