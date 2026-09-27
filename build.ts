// Assembles src/ into dist/quorum.html, the single self-contained page. The TypeScript in src/ is bundled from
// src/app.ts into one inline script.
import path from "node:path";

const src = (file: string) => path.join(import.meta.dir, "src", file);

// The page as one string of HTML.
export async function buildPage(): Promise<string> {
  const result = await Bun.build({ entrypoints: [src("app.ts")], target: "browser", format: "esm" });
  if (!result.success) throw new AggregateError(result.logs, "The page's scripts didn't build.");
  const js = await result.outputs[0].text();
  if (/<\/script/i.test(js)) throw new Error("A closing script tag inside the JavaScript would end the inline script early.");
  const read = (file: string) => Bun.file(src(file)).text();
  return (await read("head.html")) + (await read("body.html")) +
    '<script>\n(function () {\n"use strict";\n' + js + "})();\n</script>\n</body>\n</html>\n";
}

if (import.meta.main) {
  const html = await buildPage();
  const bytes = await Bun.write(path.join(import.meta.dir, "dist", "quorum.html"), html);
  console.log("Built dist/quorum.html (" + bytes + " bytes)");
}
