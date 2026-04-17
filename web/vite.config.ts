import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import http from "node:http";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "sse-proxy",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (
            req.url?.startsWith("/api") &&
            req.headers.accept?.includes("text/event-stream")
          ) {
            const proxyReq = http.request(
              {
                hostname: "localhost",
                port: 3000,
                path: req.url,
                method: req.method,
                headers: { ...req.headers, host: "localhost:3000" },
              },
              (proxyRes) => {
                res.writeHead(proxyRes.statusCode!, proxyRes.headers);
                proxyRes.pipe(res);
              },
            );
            proxyReq.on("error", () => res.end());
            req.pipe(proxyReq);
          } else {
            next();
          }
        });
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
