// Bundles the board client into dist/ (served by lab/board/server.ts).
import { build } from "esbuild";
await build({
  entryPoints: ["app.jsx"],
  bundle: true,
  minify: true,
  format: "esm",
  outdir: "dist",
  jsx: "automatic",
  loader: { ".woff2": "file", ".ttf": "file", ".png": "file", ".svg": "file" },
  define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"' },
  logLevel: "warning",
});
console.log("built dist/app.js");
