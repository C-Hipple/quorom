// Assembles src/ into dist/quorum.html, the single self-contained page.
const fs = require("fs");
const path = require("path");

const read = file => fs.readFileSync(path.join(__dirname, "src", file), "utf8");
const scripts = ["graph.js", "core.js", "providers.js", "app.js"].map(read);
if (scripts.some(js => /<\/script/i.test(js))) {
  console.error("A closing script tag inside the JavaScript would end the inline script early.");
  process.exit(1);
}

const html = read("head.html") + read("body.html") +
  '<script>\n(function () {\n"use strict";\n' + scripts.join("\n") + "})();\n</script>\n</body>\n</html>\n";

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dist", "quorum.html"), html);
console.log("Built dist/quorum.html (" + Buffer.byteLength(html) + " bytes)");
