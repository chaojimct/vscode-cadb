import { existsSync, readFileSync } from "fs";
import path from "path";

/**
 * 从扩展目录解析 npm 包展示用版本：优先 node_modules 内实际 version，否则用根 package.json 的依赖范围
 */
export function resolveNpmPackageVersions(
  extensionPath: string,
  packageNames: readonly string[]
): { name: string; version: string }[] {
  let rootDeps: Record<string, string> = {};
  try {
    const raw = readFileSync(path.join(extensionPath, "package.json"), "utf-8");
    rootDeps = (JSON.parse(raw).dependencies as Record<string, string>) || {};
  } catch {
    /* ignore */
  }

  return packageNames.map((name) => {
    const dir = dependencyDir(extensionPath, name);
    const pkgJson = path.join(dir, "package.json");
    let version = "";
    if (existsSync(pkgJson)) {
      try {
        version = String((JSON.parse(readFileSync(pkgJson, "utf-8")) as { version?: string }).version || "");
      } catch {
        /* ignore */
      }
    }
    if (!version && rootDeps[name]) {
      version = rootDeps[name];
    }
    return { name, version: version || "—" };
  });
}

function dependencyDir(extensionPath: string, packageName: string): string {
  if (packageName.startsWith("@")) {
    const slash = packageName.indexOf("/");
    if (slash === -1) {
      return path.join(extensionPath, "node_modules", packageName);
    }
    const scope = packageName.slice(0, slash);
    const sub = packageName.slice(slash + 1);
    return path.join(extensionPath, "node_modules", scope, sub);
  }
  return path.join(extensionPath, "node_modules", packageName);
}
