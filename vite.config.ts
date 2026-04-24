import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";

const backendPort = process.env.BACKEND_PORT || "5151";
const backendHost = process.env.BACKEND_HOST || "127.0.0.1";
const backendUrl = `http://${backendHost}:${backendPort}`;

// Mirrors the production server's /sw.js handler: substitutes __BUILD_ID__
// into public/sw.js so dev reloads pick up a fresh SW like prod does, and
// disables HTTP caching on the SW script. The ID is fixed for the lifetime
// of the dev server so the worker doesn't churn on every request.
function serviceWorkerDevPlugin(): Plugin {
  const devBuildId = `dev-${Date.now()}`;
  return {
    name: "vivi-sw-dev",
    configureServer(server) {
      server.middlewares.use("/sw.js", (req, res, next) => {
        if (req.url !== "/") return next();
        try {
          const src = fs.readFileSync(
            path.join(process.cwd(), "public/sw.js"),
            "utf8",
          );
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Service-Worker-Allowed", "/");
          res.end(src.replace(/__BUILD_ID__/g, devBuildId));
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorkerDevPlugin()],
  server: {
    proxy: {
      "/api": backendUrl,
      "/ws": {
        target: backendUrl,
        ws: true,
        // Suppress EPIPE errors when browser disconnects mid-proxy
        configure: (proxy) => {
          proxy.on("error", (err: NodeJS.ErrnoException) => {
            // EPIPE is expected when browser disconnects mid-proxy — suppress those
            if (err.code !== "EPIPE") {
              console.warn("[vite-proxy] WebSocket proxy error:", err.message);
            }
          });
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ["ghostty-web"],
  },
});
