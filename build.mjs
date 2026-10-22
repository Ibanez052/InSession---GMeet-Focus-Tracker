import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/src/popup", { recursive: true });
await mkdir("dist/src/content", { recursive: true });
await mkdir("dist/src/background", { recursive: true });
await mkdir("dist/src/auth", { recursive: true });
await build({ entryPoints: ["src/popup/popup.js"], outfile: "dist/src/popup/popup.js", bundle: true, format: "esm", target: "chrome120" });
await build({ entryPoints: ["src/content/content.js"], outfile: "dist/src/content/content.js", bundle: true, format: "iife", target: "chrome120" });
const distributionManifest = JSON.parse(await readFile("manifest.json", "utf8"));
distributionManifest.side_panel.default_path = distributionManifest.side_panel.default_path.replace(/^dist\//, "");
distributionManifest.background.service_worker = distributionManifest.background.service_worker.replace(/^dist\//, "");
for (const contentScript of distributionManifest.content_scripts ?? []) {
  contentScript.js = contentScript.js.map((path) => path.replace(/^dist\//, ""));
}

await Promise.all([
  writeFile("dist/manifest.json", `${JSON.stringify(distributionManifest, null, 2)}\n`),
  cp("src/popup/popup.html", "dist/src/popup/popup.html"),
  cp("src/popup/style.css", "dist/src/popup/style.css"),
  cp("src/popup/theme.js", "dist/src/popup/theme.js"),
  cp("src/background/service-worker.js", "dist/src/background/service-worker.js"),
  cp("src/auth/offscreen.html", "dist/src/auth/offscreen.html"),
  cp("src/auth/offscreen.js", "dist/src/auth/offscreen.js"),
  cp("assets", "dist/assets", { recursive: true })
]);
console.log("Built unpacked extension in dist/");
