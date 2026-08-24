import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "opencode-cursor-package-"),
);

try {
  const packed = JSON.parse(
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
  )[0];
  const paths = new Set(packed.files.map((file) => file.path));
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/v1.js",
    "dist/v1.d.ts",
    "dist/h2-bridge.mjs",
    "dist/h2-bridge-persistent.mjs",
    "LICENSE",
    "README.md",
    "package.json",
  ]) {
    if (!paths.has(required)) {
      throw new Error(`Packed artifact is missing ${required}`);
    }
  }
  for (const forbidden of ["src/", "test/", ".opencode/", "package-lock.json"]) {
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
  const loadedV1 = await import(
    pathToFileURL(join(packageRoot, "dist", "v1.js")).href
  );
  if (typeof loadedV1.default !== "function") {
    throw new Error("Packed ./v1 export is not an OpenCode V1 plugin");
  }
  execFileSync(
    process.execPath,
    [join(root, "scripts", "smoke-opencode-v2.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        OPENCODE_CURSOR_PLUGIN_PATH: join(
          packageRoot,
          "dist",
          "index.js",
        ),
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
