import { mkdir } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);
const outputDirectory = new URL("../dist/app/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });

const tailwind = Bun.spawn(
  [
    new URL("../node_modules/.bin/tailwindcss", import.meta.url).pathname,
    "-i",
    new URL("../src/app/styles.css", import.meta.url).pathname,
    "-o",
    new URL("../dist/app/dataset-table.css", import.meta.url).pathname,
    "--minify",
  ],
  { cwd: projectRoot.pathname, stdout: "inherit", stderr: "inherit" },
);

if ((await tailwind.exited) !== 0) {
  throw new Error("Tailwind failed to build the dataset table stylesheet.");
}

const build = await Bun.build({
  entrypoints: [new URL("../src/app/main.tsx", import.meta.url).pathname],
  outdir: outputDirectory.pathname,
  target: "browser",
  format: "esm",
  minify: true,
  naming: "dataset-table.[ext]",
});

if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error("Bun failed to build the dataset table script.");
}

const css = await Bun.file(
  new URL("../dist/app/dataset-table.css", import.meta.url),
).text();
const javascript = (
  await Bun.file(
    new URL("../dist/app/dataset-table.js", import.meta.url),
  ).text()
).replaceAll("</script", "<\\/script");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dataset table</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${javascript}</script>
  </body>
</html>`;

await Bun.write(new URL("../dist/dataset-table.html", import.meta.url), html);
console.log("Built dist/dataset-table.html");
