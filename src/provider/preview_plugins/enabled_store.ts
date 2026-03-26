import { readFileSync } from "fs";
import path from "path";
import * as vscode from "vscode";
import { resolveNpmPackageVersions } from "../drivers/package_versions";
import { getRegisteredPreviewPlugin, listRegisteredPreviewPlugins } from "./registry";

const ENABLED_PREVIEW_PLUGIN_IDS_KEY = "cadb.enabledPreviewPluginIds";

function allRegisteredIds(): string[] {
  return listRegisteredPreviewPlugins().map((p) => p.id);
}

function readExtensionVersion(extPath: string): string {
  try {
    const raw = readFileSync(path.join(extPath, "package.json"), "utf-8");
    return String((JSON.parse(raw) as { version?: string }).version || "").trim();
  } catch {
    return "";
  }
}

/**
 * 已启用的预览插件 id。
 * - 从未写入：视为全部启用（兼容旧版）
 */
export function getEnabledPreviewPluginIds(context: vscode.ExtensionContext): string[] {
  const registered = allRegisteredIds();
  const raw = context.globalState.get<string[] | undefined>(
    ENABLED_PREVIEW_PLUGIN_IDS_KEY
  );
  if (raw === undefined) {
    return [...registered];
  }
  if (!Array.isArray(raw)) {
    return [...registered];
  }
  const regSet = new Set(registered);
  return raw.filter((id) => regSet.has(id));
}

export async function setEnabledPreviewPluginIds(
  context: vscode.ExtensionContext,
  ids: string[]
): Promise<void> {
  const registered = new Set(allRegisteredIds());
  const next = ids.filter((id) => registered.has(id));
  await context.globalState.update(ENABLED_PREVIEW_PLUGIN_IDS_KEY, next);
}

/**
 * 启用或停用单个预览插件（允许全部关闭；此时 Ctrl+点击预览将提示）
 */
export async function setPreviewPluginEnabled(
  context: vscode.ExtensionContext,
  id: string,
  enabled: boolean
): Promise<{ ok: boolean; message?: string }> {
  const reg = getRegisteredPreviewPlugin(id);
  if (!reg) {
    return { ok: false, message: "未知预览插件" };
  }
  const current = new Set(getEnabledPreviewPluginIds(context));
  if (enabled) {
    current.add(id);
  } else {
    current.delete(id);
  }
  const registeredOrder = allRegisteredIds();
  const next = registeredOrder.filter((x) => current.has(x));
  await context.globalState.update(ENABLED_PREVIEW_PLUGIN_IDS_KEY, next);
  return { ok: true };
}

export function isPreviewPluginEnabled(
  context: vscode.ExtensionContext,
  id: string
): boolean {
  return getEnabledPreviewPluginIds(context).includes(id);
}

/** 预览插件管理页数据 */
export function getPreviewPluginsManagementPayload(
  context: vscode.ExtensionContext
): {
  id: string;
  dataFormatLabel: string;
  description: string;
  enabled: boolean;
  packages: { name: string; version: string }[];
}[] {
  const enabled = new Set(getEnabledPreviewPluginIds(context));
  const extPath = context.extensionPath;
  const ver = readExtensionVersion(extPath);
  return listRegisteredPreviewPlugins().map((p) => ({
    id: p.id,
    dataFormatLabel: p.dataFormatLabel,
    description: p.description ?? "",
    enabled: enabled.has(p.id),
    packages:
      p.npmDependencyNames && p.npmDependencyNames.length > 0
        ? resolveNpmPackageVersions(extPath, p.npmDependencyNames)
        : [{ name: "vscode-cadb（内置渲染）", version: ver || "—" }],
  }));
}
