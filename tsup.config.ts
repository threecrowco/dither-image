import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  external: ["react", "react-dom"],
  // esbuild doesn't preserve "use client" through bundling — without this,
  // Next.js's RSC compiler can't see the client boundary in consuming apps.
  banner: { js: '"use client";' },
});
