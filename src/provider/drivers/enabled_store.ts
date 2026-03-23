import * as vscode from "vscode";
import {
  getRegisteredDatabaseDriver,
  listRegisteredDatabaseDrivers,
} from "./registry";
import type { DriverSelectOption } from "./types";

const ENABLED_DRIVER_IDS_KEY = "cadb.enabledDriverIds";

function allRegisteredIds(): string[] {
  return listRegisteredDatabaseDrivers().map((d) => d.id);
}

/**
 * 当前启用的驱动 id 列表。
 * - 从未写入过 globalState：视为「全部启用」（兼容旧版）
 * - 已写入数组（可为空）：按用户选择，空数组表示全部关闭
 */
export function getEnabledDriverIds(context: vscode.ExtensionContext): string[] {
  const registered = allRegisteredIds();
  const raw = context.globalState.get<string[] | undefined>(ENABLED_DRIVER_IDS_KEY);
  if (raw === undefined) {
    return [...registered];
  }
  if (!Array.isArray(raw)) {
    return [...registered];
  }
  const regSet = new Set(registered);
  return raw.filter((id) => regSet.has(id));
}

export async function setEnabledDriverIds(
  context: vscode.ExtensionContext,
  ids: string[]
): Promise<void> {
  const registered = new Set(allRegisteredIds());
  const next = ids.filter((id) => registered.has(id));
  await context.globalState.update(ENABLED_DRIVER_IDS_KEY, next);
}

export function isDriverEnabled(
  context: vscode.ExtensionContext,
  id: string
): boolean {
  return getEnabledDriverIds(context).includes(id);
}

/** 新建连接：仅已启用 */
export function getDriverOptionsForNewConnection(
  context: vscode.ExtensionContext
): DriverSelectOption[] {
  const enabled = new Set(getEnabledDriverIds(context));
  return listRegisteredDatabaseDrivers()
    .filter((d) => enabled.has(d.id))
    .map((d) => ({
      id: d.id,
      label: d.displayName,
      description: d.description,
    }));
}

/**
 * 编辑连接：已启用 + 若当前连接类型未启用则附带一项（避免无法展示类型）
 */
export function getDriverOptionsForEditConnection(
  context: vscode.ExtensionContext,
  currentDbType: string | undefined
): DriverSelectOption[] {
  const enabled = new Set(getEnabledDriverIds(context));
  const out: DriverSelectOption[] = [];
  for (const d of listRegisteredDatabaseDrivers()) {
    if (enabled.has(d.id)) {
      out.push({
        id: d.id,
        label: d.displayName,
        description: d.description,
      });
    }
  }
  if (currentDbType && !enabled.has(currentDbType)) {
    const cur = getRegisteredDatabaseDriver(currentDbType);
    if (cur) {
      out.push({
        id: cur.id,
        label: `${cur.displayName}（当前连接，驱动未启用）`,
        description: cur.description,
      });
    }
  }
  return out;
}

/** 驱动管理页数据 */
export function getDriversManagementPayload(context: vscode.ExtensionContext): {
  id: string;
  displayName: string;
  description: string;
  enabled: boolean;
  marketplaceExtensionId?: string;
}[] {
  const enabled = new Set(getEnabledDriverIds(context));
  return listRegisteredDatabaseDrivers().map((d) => ({
    id: d.id,
    displayName: d.displayName,
    description: d.description ?? "",
    enabled: enabled.has(d.id),
    marketplaceExtensionId: d.marketplaceExtensionId,
  }));
}
