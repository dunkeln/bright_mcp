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
    <title>Data workbench</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${javascript}</script>
  </body>
</html>`;

await Bun.write(new URL("../dist/dataset-table.html", import.meta.url), html);

const oauthDither = await Bun.build({
  entrypoints: [
    new URL("../src/connections/oauth-dither.tsx", import.meta.url).pathname,
  ],
  outdir: new URL("../dist/", import.meta.url).pathname,
  target: "browser",
  format: "esm",
  minify: true,
  naming: "oauth-dither.[ext]",
  plugins: [{
    name: "root-react",
    setup(build) {
      build.onResolve(
        { filter: /^react(?:-dom)?(?:\/.*)?$/ },
        ({ path }) => ({
          path: Bun.resolveSync(
            path,
            new URL("../", import.meta.url).pathname,
          ),
        }),
      );
    },
  }],
});
if (!oauthDither.success) {
  for (const log of oauthDither.logs) console.error(log);
  throw new Error("Bun failed to build the OAuth dither script.");
}

console.log("Built data workbench");
