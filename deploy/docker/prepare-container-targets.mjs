#!/usr/bin/env node
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink
} from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((mod) => `node:${mod}`)
]);

export const containerTargetManifest = Object.freeze({
  core: Object.freeze({
    workspaces: Object.freeze([
      "apps/api",
      "apps/web",
      "apps/worker",
      "packages/browser-host",
      "packages/cli-host",
      "packages/codex-app-server",
      "packages/contracts",
      "packages/db",
      "packages/gateway",
      "packages/memory-graph",
      "packages/opencode-control",
      "packages/runtime",
      "packages/streaming"
    ]),
    entrypointModules: Object.freeze([]),
    seedDependencies: Object.freeze([]),
    excludeDependencies: Object.freeze(["node-pty"]),
    copyDirectories: Object.freeze(["agent-skills"]),
    copyFiles: Object.freeze([])
  }),
  browser: Object.freeze({
    workspaces: Object.freeze([
      "packages/browser-host",
      "packages/contracts",
      "packages/db",
      "packages/memory-graph",
      "packages/runtime"
    ]),
    entrypointModules: Object.freeze([
      "apps/api/dist/browser-host-main.js"
    ]),
    seedDependencies: Object.freeze([
      "@t3-oss/env-core",
      "nanoid",
      "zod"
    ]),
    excludeDependencies: Object.freeze(["node-pty"]),
    copyDirectories: Object.freeze([]),
    copyFiles: Object.freeze([])
  }),
  cli: Object.freeze({
    workspaces: Object.freeze([
      "packages/cli-host"
    ]),
    entrypointModules: Object.freeze([]),
    seedDependencies: Object.freeze([]),
    excludeDependencies: Object.freeze([]),
    copyDirectories: Object.freeze(["agent-skills"]),
    copyFiles: Object.freeze([])
  })
});

const workspaceRuntimeFiles = Object.freeze({
  "apps/web": Object.freeze(["server.mjs"])
});

const workspaceRuntimeDirectories = Object.freeze({
  "packages/db": Object.freeze(["migrations"])
});

async function pathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  const [name] = specifier.split("/");
  return name;
}

async function resolvePackageDir(rootDir, packageName, fromDirs) {
  for (const startDir of fromDirs) {
    let current = resolve(startDir);
    while (true) {
      const candidate = join(current, "node_modules", ...packageName.split("/"));
      if (await pathExists(join(candidate, "package.json"))) {
        return candidate;
      }
      if (current === resolve(rootDir)) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

async function collectDependencyClosure(rootDir, workspaces, seedDependencies = [], excludeDependencies = []) {
  const excluded = new Set(excludeDependencies);
  const queue = [];
  const seenPackageDirs = new Set();
  const topLevelPackages = new Set();

  for (const workspace of workspaces) {
    const pkgPath = join(rootDir, workspace, "package.json");
    if (!(await pathExists(pkgPath))) {
      throw new Error(`Workspace package.json not found: ${pkgPath}`);
    }
    const pkg = await readJson(pkgPath);
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.optionalDependencies ?? {})
    };
    for (const depName of Object.keys(deps)) {
      if (depName.startsWith("@space/") || excluded.has(depName)) continue;
      queue.push({
        name: depName,
        searchFrom: [join(rootDir, workspace), rootDir]
      });
    }
  }

  for (const depName of seedDependencies) {
    if (depName.startsWith("@space/") || excluded.has(depName)) continue;
    queue.push({
      name: depName,
      searchFrom: [rootDir]
    });
  }

  while (queue.length > 0) {
    const { name, searchFrom } = queue.shift();
    if (excluded.has(name)) continue;
    const pkgDir = await resolvePackageDir(rootDir, name, searchFrom);
    if (!pkgDir) continue;
    if (seenPackageDirs.has(pkgDir)) continue;
    seenPackageDirs.add(pkgDir);

    const relToRootNodeModules = relative(join(rootDir, "node_modules"), pkgDir);
    if (!relToRootNodeModules.startsWith("..") && !relToRootNodeModules.includes("node_modules")) {
      topLevelPackages.add(relToRootNodeModules);
    }

    const pkg = await readJson(join(pkgDir, "package.json"));
    const childDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.optionalDependencies ?? {})
    };
    for (const childName of Object.keys(childDeps)) {
      if (childName.startsWith("@space/") || excluded.has(childName)) continue;
      queue.push({
        name: childName,
        searchFrom: [pkgDir, rootDir]
      });
    }
  }

  return [...topLevelPackages].sort();
}

async function copyWorkspace(rootDir, stageDir, workspace) {
  const srcWorkspace = join(rootDir, workspace);
  const dstWorkspace = join(stageDir, workspace);
  await mkdir(dstWorkspace, { recursive: true });
  await cp(join(srcWorkspace, "package.json"), join(dstWorkspace, "package.json"));

  const distSrc = join(srcWorkspace, "dist");
  if (await pathExists(distSrc)) {
    await cp(distSrc, join(dstWorkspace, "dist"), {
      recursive: true,
      filter: (src) => {
        const rel = src.replace(/\\/g, "/");
        if (rel.includes("/__tests__/") || rel.endsWith("/__tests__") || rel.includes("/tests/") || rel.endsWith("/tests")) {
          return false;
        }
        if (
          rel.endsWith(".test.js") ||
          rel.endsWith(".spec.js") ||
          rel.endsWith(".d.ts") ||
          rel.endsWith(".d.mts") ||
          rel.endsWith(".d.cts") ||
          rel.endsWith(".map")
        ) {
          return false;
        }
        return true;
      }
    });
  }

  for (const extraFile of workspaceRuntimeFiles[workspace] ?? []) {
    const extraSrc = join(srcWorkspace, extraFile);
    if (await pathExists(extraSrc)) {
      await cp(extraSrc, join(dstWorkspace, extraFile));
    }
  }

  for (const extraDir of workspaceRuntimeDirectories[workspace] ?? []) {
    const extraSrc = join(srcWorkspace, extraDir);
    if (await pathExists(extraSrc)) {
      await cp(extraSrc, join(dstWorkspace, extraDir), { recursive: true });
    }
  }

  const pkg = await readJson(join(srcWorkspace, "package.json"));
  if (typeof pkg.name === "string" && pkg.name.startsWith("@space/")) {
    const linkParent = join(stageDir, "node_modules", "@space");
    await mkdir(linkParent, { recursive: true });
    const linkPath = join(stageDir, "node_modules", ...pkg.name.split("/"));
    await rm(linkPath, { recursive: true, force: true });
    const relTarget = relative(dirname(linkPath), dstWorkspace);
    await symlink(relTarget, linkPath, "dir");
  }
}

async function copyEntrypointModuleClosure(rootDir, stageDir, entrypointRelPath) {
  const parts = entrypointRelPath.split("/");
  const workspace = parts.slice(0, 2).join("/");
  const srcWorkspacePkg = join(rootDir, workspace, "package.json");
  const dstWorkspacePkg = join(stageDir, workspace, "package.json");
  if ((await pathExists(srcWorkspacePkg)) && !(await pathExists(dstWorkspacePkg))) {
    await mkdir(dirname(dstWorkspacePkg), { recursive: true });
    await cp(srcWorkspacePkg, dstWorkspacePkg);
  }

  const queue = [resolve(rootDir, entrypointRelPath)];
  const visited = new Set();
  const importExportRe =
    /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

  while (queue.length > 0) {
    const absFile = queue.shift();
    if (visited.has(absFile)) continue;
    if (!(await pathExists(absFile))) {
      throw new Error(`Entrypoint module not found: ${absFile}`);
    }
    visited.add(absFile);

    const relFile = relative(rootDir, absFile);
    const dstFile = join(stageDir, relFile);
    await mkdir(dirname(dstFile), { recursive: true });
    await cp(absFile, dstFile);

    const source = await readFile(absFile, "utf8");
    for (const match of source.matchAll(importExportRe)) {
      const specifier = match[1] ?? match[2];
      if (!specifier || !specifier.startsWith(".")) continue;
      const resolvedNext = resolve(dirname(absFile), specifier);
      if (await pathExists(resolvedNext)) {
        queue.push(resolvedNext);
      }
    }
  }
}

function normalizeArch(targetArch) {
  const raw = (targetArch || process.arch).toLowerCase();
  if (raw === "amd64" || raw === "x64" || raw === "x86_64") {
    return {
      nodeArch: "x64",
      rustArch: "x86_64-unknown-linux-gnu",
      foreignTokens: ["arm64", "aarch64", "darwin", "win32", "msvc", "apple", "musl", "android", "freebsd"]
    };
  }
  if (raw === "arm64" || raw === "aarch64") {
    return {
      nodeArch: "arm64",
      rustArch: "aarch64-unknown-linux-gnu",
      foreignTokens: ["x64", "x86_64", "darwin", "win32", "msvc", "apple", "musl", "android", "freebsd"]
    };
  }
  throw new Error(`Unsupported container target architecture: ${targetArch}`);
}

async function pruneForeignPlatformArtifacts(stageDir, targetArch) {
  const { nodeArch, rustArch, foreignTokens } = normalizeArch(targetArch);
  const nodeModulesDir = join(stageDir, "node_modules");
  if (!(await pathExists(nodeModulesDir))) return;

  const temporalReleasesDir = join(nodeModulesDir, "@temporalio", "core-bridge", "releases");
  if (await pathExists(temporalReleasesDir)) {
    for (const entry of await readdir(temporalReleasesDir, { withFileTypes: true })) {
      if (entry.name !== rustArch) {
        await rm(join(temporalReleasesDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  for (const scope of ["@napi-rs", "@swc"]) {
    const scopeDir = join(nodeModulesDir, scope);
    if (!(await pathExists(scopeDir))) continue;
    for (const entry of await readdir(scopeDir, { withFileTypes: true })) {
      const lower = entry.name.toLowerCase();
      if (foreignTokens.some((token) => lower.includes(token))) {
        await rm(join(scopeDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  async function prunePrebuilds(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === "prebuilds") {
        for (const sub of await readdir(fullPath, { withFileTypes: true })) {
          if (sub.name !== `linux-${nodeArch}`) {
            await rm(join(fullPath, sub.name), { recursive: true, force: true });
          }
        }
        continue;
      }
      await prunePrebuilds(fullPath);
    }
  }

  await prunePrebuilds(nodeModulesDir);
}

async function collectBareSpecifiers(jsFilePath) {
  const source = await readFile(jsFilePath, "utf8");
  const specifiers = new Set();
  const staticRe = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^"'`\n]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const regex of [staticRe, dynamicRe]) {
    for (const match of source.matchAll(regex)) {
      const spec = match[1];
      if (!spec || spec.startsWith(".") || spec.startsWith("/") || builtins.has(spec)) continue;
      specifiers.add(spec);
    }
  }
  return [...specifiers];
}

async function verifyStagedResolution(stageDir, excludedDependencies = []) {
  const excluded = new Set(excludedDependencies);
  const jsFiles = [];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      const rel = relative(stageDir, full);
      if (rel === "node_modules" || rel.startsWith("node_modules/")) continue;
      if (rel === "apps/web/dist" || rel.startsWith("apps/web/dist/")) continue;
      if (rel === "agent-skills" || rel.startsWith("agent-skills/")) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && /\.(?:m?js)$/.test(entry.name)) {
        jsFiles.push(full);
      }
    }
  }

  await walk(stageDir);

  const unresolved = [];
  for (const file of jsFiles) {
    const req = createRequire(file);
    const specifiers = await collectBareSpecifiers(file);
    for (const spec of specifiers) {
      const pkgName = packageNameFromSpecifier(spec);
      if (excluded.has(spec) || excluded.has(pkgName)) continue;
      try {
        req.resolve(spec);
      } catch {
        const pkgDir = await resolvePackageDir(stageDir, pkgName, [dirname(file), stageDir]);
        if (!pkgDir) {
          unresolved.push(`${relative(stageDir, file)} -> ${spec}`);
        }
      }
    }
  }

  if (unresolved.length > 0) {
    throw new Error(
      `Staged container target at ${stageDir} has unresolved runtime imports:\n${unresolved.join("\n")}`
    );
  }
}

export async function prepareContainerTarget({
  rootDir = process.cwd(),
  outRootDir,
  target,
  targetArch = process.arch
}) {
  const manifest = containerTargetManifest[target];
  if (!manifest) {
    throw new Error(`Unknown container target "${target}". Expected one of: ${Object.keys(containerTargetManifest).join(", ")}`);
  }

  const stageDir = join(outRootDir, target);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(join(stageDir, "node_modules"), { recursive: true });

  await cp(join(rootDir, "package.json"), join(stageDir, "package.json"));

  for (const workspace of manifest.workspaces) {
    await copyWorkspace(rootDir, stageDir, workspace);
  }

  for (const entrypointModule of manifest.entrypointModules) {
    await copyEntrypointModuleClosure(rootDir, stageDir, entrypointModule);
  }

  const topLevelPackages = await collectDependencyClosure(
    rootDir,
    manifest.workspaces,
    manifest.seedDependencies,
    manifest.excludeDependencies
  );
  for (const relPkg of topLevelPackages) {
    const srcPkg = join(rootDir, "node_modules", relPkg);
    const dstPkg = join(stageDir, "node_modules", relPkg);
    await mkdir(dirname(dstPkg), { recursive: true });
    await cp(srcPkg, dstPkg, { recursive: true, verbatimSymlinks: true });
  }

  for (const dirRel of manifest.copyDirectories) {
    const srcDir = join(rootDir, dirRel);
    if (await pathExists(srcDir)) {
      const dstDir = join(stageDir, dirRel);
      await mkdir(dirname(dstDir), { recursive: true });
      await cp(srcDir, dstDir, { recursive: true });
    }
  }

  for (const fileRel of manifest.copyFiles) {
    const srcFile = join(rootDir, fileRel);
    if (await pathExists(srcFile)) {
      const dstFile = join(stageDir, fileRel);
      await mkdir(dirname(dstFile), { recursive: true });
      await cp(srcFile, dstFile);
    }
  }

  await pruneForeignPlatformArtifacts(stageDir, targetArch);
  await verifyStagedResolution(stageDir, manifest.excludeDependencies);

  return {
    target,
    stageDir,
    workspaces: manifest.workspaces,
    packageCount: topLevelPackages.length
  };
}

export async function prepareAllContainerTargets({
  rootDir = process.cwd(),
  outRootDir = join(rootDir, "deploy", "container-targets"),
  targetArch = process.arch,
  targets = Object.keys(containerTargetManifest)
} = {}) {
  const results = [];
  for (const target of targets) {
    results.push(
      await prepareContainerTarget({
        rootDir,
        outRootDir,
        target,
        targetArch
      })
    );
  }
  return results;
}

function parseArgs(argv) {
  let rootDir = process.cwd();
  let outRootDir = null;
  let targetArch = process.env.TARGETARCH || process.arch;
  const targets = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      rootDir = resolve(argv[++i]);
    } else if (arg === "--out") {
      outRootDir = resolve(argv[++i]);
    } else if (arg === "--arch") {
      targetArch = argv[++i];
    } else if (arg === "--target") {
      targets.push(argv[++i]);
    } else if (arg === "--all") {
      targets.push(...Object.keys(containerTargetManifest));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    rootDir,
    outRootDir: outRootDir ?? join(rootDir, "deploy", "container-targets"),
    targetArch,
    targets: targets.length > 0 ? [...new Set(targets)] : Object.keys(containerTargetManifest)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const summaries = await prepareAllContainerTargets(options);
  for (const summary of summaries) {
    process.stdout.write(
      `Prepared container target ${summary.target}: ${summary.workspaces.length} workspaces, ${summary.packageCount} top-level packages -> ${summary.stageDir}\n`
    );
  }
}
