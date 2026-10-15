import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/src/popup", { recursive: true });
await mkdir("dist/src/content", { recursive: true });
await build({ entryPoints: ["src/popup/popup.js"], outfile: "dist/src/popup/popup.js", bundle: true, format: "esm", target: "chrome120" });
await build({ entryPoints: ["src/content/content.js"], outfile: "dist/src/content/content.js", bundle: true, format: "iife", target: "chrome120" });
await Promise.all([
  cp("manifest.json", "dist/manifest.json"),
  cp("src/popup/popup.html", "dist/src/popup/popup.html"),
  cp("src/popup/style.css", "dist/src/popup/style.css"),
  cp("assets", "dist/assets", { recursive: true })
]);
console.log("Built unpacked extension in dist/");
