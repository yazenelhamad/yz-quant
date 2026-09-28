import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_ORIGIN = process.env.VITE_API_ORIGIN ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: API_ORIGIN,
        changeOrigin: true,
        // Keep cookies flowing: the API sets `yz_session` on its own origin; through the
        // proxy the browser sees a same-origin cookie, so `credentials: "include"` works.
        cookieDomainRewrite: "",
        secure: false,
      },
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
