import { mkdir, unlink } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);
const defaultStylesheet = new URL("../src/app/styles.css", import.meta.url);
const tailwind = new URL(
  "../node_modules/@tailwindcss/cli/dist/index.mjs",
  import.meta.url,
);

export async function buildAppAssets(options: {
  entrypoint: URL;
  outputDirectory: URL;
  minify: boolean;
  stylesheet?: URL;
}) {
  await mkdir(options.outputDirectory, { recursive: true });
  const css = new URL("dataset-table.css", options.outputDirectory);
  const tailwindCss = new URL("dataset-table.tailwind.css", options.outputDirectory);
  const javascript = new URL("dataset-table.js", options.outputDirectory);

  const styles = Bun.spawn(
    [
      process.execPath,
      tailwind.pathname,
      "-i",
      (options.stylesheet ?? defaultStylesheet).pathname,
      "-o",
      tailwindCss.pathname,
      ...(options.minify ? ["--minify"] : []),
    ],
    { cwd: projectRoot.pathname, stdout: "inherit", stderr: "inherit" },
  );
  if ((await styles.exited) !== 0) {
    throw new Error("Tailwind failed to build the dataset table stylesheet.");
  }

  const build = await Bun.build({
    entrypoints: [options.entrypoint.pathname],
    outdir: options.outputDirectory.pathname,
    target: "browser",
    format: "esm",
    minify: options.minify,
    naming: "dataset-table.[ext]",
    sourcemap: options.minify ? "none" : "inline",
  });
  if (!build.success) {
    for (const log of build.logs) console.error(log);
    throw new Error("Bun failed to build the dataset table script.");
  }

  const componentCss = build.outputs.filter((output) => output.path.endsWith(".css"));
  const combinedCss = [
    await Bun.file(tailwindCss).text(),
    ...(await Promise.all(componentCss.map((output) => output.text()))),
  ].join("\n");
  await Bun.write(css, combinedCss);
  await unlink(tailwindCss);

  return { css, javascript };
}
