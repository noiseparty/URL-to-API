import { defineConfig } from "vite";

const BASE = "/";
const API_PORT = Number(process.env.API_PORT ?? 3103);

export default defineConfig({
  base: BASE,
  build: {
    outDir: "dist/public",
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    proxy: {
      // The shell serves theme.css on the same origin in production; borrow the live copy in dev.
      "/theme.css": { target: "https://www.skabene.id.lv", changeOrigin: true },
      [`${BASE}api`]: { target: `http://127.0.0.1:${API_PORT}` },
      [`${BASE}healthz`]: { target: `http://127.0.0.1:${API_PORT}` },
    },
  },
});
