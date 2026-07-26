import esbuild from "esbuild";

const production = process.argv[2] === "production";

esbuild
  .build({
    entryPoints: ["main.ts"],
    bundle: true,
    external: ["obsidian", "electron"],
    format: "cjs",
    target: "es2020",
    logLevel: "info",
    sourcemap: production ? false : "inline",
    minify: production,
    outfile: "main.js",
  })
  .catch(() => process.exit(1));
