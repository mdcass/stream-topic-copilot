import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "src/ui"),
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4312",
      "/artifacts": "http://127.0.0.1:4312"
    }
  },
  build: {
    outDir: path.resolve(__dirname, "dist/ui"),
    emptyOutDir: true
  }
});
