import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const temporaryRoot = await mkdtemp(join(tmpdir(), "opencode-cursor-package-"));

try {
  const report = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        temporaryRoot,
      ],
      { encoding: "utf8" },
    ),
  );
  // npm 12 keys pack results by package name; earlier releases return an array.
  const packed = Array.isArray(report) ? report[0] : Object.values(report)[0];
  const paths = new Set(packed.files.map((file) => file.path));
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/h2-v2.mjs",
    "dist/h2-unary.mjs",
    "LICENSE",
    "README.md",
    "package.json",
  ]) {
    if (!paths.has(required)) {
      throw new Error(`Packed artifact is missing ${required}`);
    }
  }
  for (const forbidden of [
    "src/",
    "test/",
    ".opencode/",
    "package-lock.json",
  ]) {
    if (
      [...paths].some(
        (path) => path === forbidden || path.startsWith(forbidden),
      )
    ) {
      throw new Error(`Packed artifact contains forbidden path ${forbidden}`);
    }
  }

  const archive = join(temporaryRoot, packed.filename);
  execFileSync("tar", ["-xzf", archive, "-C", temporaryRoot], {
    stdio: "inherit",
  });
  const packageRoot = join(temporaryRoot, "package");
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--omit=dev", "--no-package-lock"],
    { cwd: packageRoot, stdio: "inherit" },
  );
  const loaded = await import(
    pathToFileURL(join(packageRoot, "dist", "index.js")).href
  );
  if (
    loaded.default?.id !== "opencode.provider.cursor" ||
    typeof loaded.default?.setup !== "function"
  ) {
    throw new Error("Packed default export is not an OpenCode V2 plugin");
  }
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (Object.keys(manifest.exports).join() !== ".")
    throw new Error("Packed plugin has an unexpected compatibility export");
  const pluginDependencies = Object.keys(manifest.dependencies).filter(
    (name) => name.includes("opencode") && name.includes("plugin"),
  );
  if (pluginDependencies.join() !== "@opencode/plugin")
    throw new Error("Packed plugin has an unexpected plugin API dependency");
  execFileSync(
    process.execPath,
    [join(root, "scripts", "smoke-opencode-v2.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        OPENCODE_CURSOR_PLUGIN_PATH: join(packageRoot, "dist"),
      },
      stdio: "inherit",
    },
  );
  console.log(
    `[test] Packed V2 plugin verified (${packed.entryCount} files, ${packed.size} bytes)`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
