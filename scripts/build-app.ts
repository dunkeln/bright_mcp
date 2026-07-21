import { buildAppAssets } from "./app-build";

const outputDirectory = new URL("../dist/app/", import.meta.url);
const assets = await buildAppAssets({
  entrypoint: new URL("../src/app/main.tsx", import.meta.url),
  outputDirectory,
  minify: true,
});

const css = await Bun.file(assets.css).text();
const javascript = (
  await Bun.file(assets.javascript).text()
).replaceAll("</script", "<\\/script");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dataset workbench</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${javascript}</script>
  </body>
</html>`;

await Bun.write(new URL("../dist/dataset-table.html", import.meta.url), html);
console.log("Built dist/dataset-table.html");
