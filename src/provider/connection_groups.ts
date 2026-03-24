import * as vscode from "vscode";
import type { DatasourceInputData } from "./entity/datasource";

const GROUPS_KEY = "cadb.connectionGroups";

/** 未填写分组、空白的连接归入此侧栏分组 */
export const DEFAULT_CONNECTION_GROUP = "默认";

export function normalizeConnectionGroupLabel(g: unknown): string {
  const v = String(g ?? "").trim();
  return v || DEFAULT_CONNECTION_GROUP;
}

function dedupeOrder(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const v = normalizeConnectionGroupLabel(n);
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** 若包含「默认」，固定排到列表最后（TreeView 根分组顺序） */
function moveDefaultGroupToEnd(names: string[]): string[] {
  if (!names.includes(DEFAULT_CONNECTION_GROUP)) {
    return names;
  }
  return [...names.filter((x) => x !== DEFAULT_CONNECTION_GROUP), DEFAULT_CONNECTION_GROUP];
}

/**
 * 侧栏树根分组顺序：
 * - 未写入或写入空数组：仅按连接里的分组名去重后排序
 * - 已写入非空数组：该顺序优先，再将连接里出现但未列入的名称按拼音序追加在末尾
 */
export function getOrderedConnectionGroups(
  context: vscode.ExtensionContext,
  connections: DatasourceInputData[]
): string[] {
  const fromConn = new Set<string>();
  for (const c of connections) {
    fromConn.add(normalizeConnectionGroupLabel((c as { group?: string }).group));
  }
  const stored = context.globalState.get<string[] | undefined>(GROUPS_KEY);
  if (!Array.isArray(stored) || stored.length === 0) {
    const sorted = [...fromConn].sort((a, b) => a.localeCompare(b, "zh-CN"));
    return moveDefaultGroupToEnd(sorted);
  }
  const ordered: string[] = [];
  for (const s of stored) {
    const n = normalizeConnectionGroupLabel(s);
    if (!ordered.includes(n)) {
      ordered.push(n);
    }
  }
  for (const g of [...fromConn].sort((a, b) => a.localeCompare(b, "zh-CN"))) {
    if (!ordered.includes(g)) {
      ordered.push(g);
    }
  }
  return moveDefaultGroupToEnd(ordered);
}

/**
 * 已持久化的自定义顺序（未定义则 []）；不合并「当前生效顺序」
 */
export function getStoredConnectionGroupsOrder(
  context: vscode.ExtensionContext
): string[] {
  const raw = context.globalState.get<string[] | undefined>(GROUPS_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  return dedupeOrder(raw);
}

/**
 * 分组编辑页初始标签列表：
 * - 从未持久化过：展示当前生效顺序（「默认」已在末位）
 * - 已持久化 []：自动排序模式，返回 []
 * - 已持久化非空：规范为「默认」在末位（去重）
 */
export function getConnectionGroupsEditorLines(
  context: vscode.ExtensionContext,
  connections: DatasourceInputData[]
): string[] {
  const raw = context.globalState.get<string[] | undefined>(GROUPS_KEY);
  if (raw === undefined) {
    const o = getOrderedConnectionGroups(context, connections);
    if (o.length === 0) {
      return [];
    }
    return moveDefaultGroupToEnd(dedupeOrder(o));
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const lines = dedupeOrder(raw);
  return moveDefaultGroupToEnd(lines);
}

/**
 * 用户提交的顺序写入 globalState 前的规范化：
 * - 空数组：保持「仅按连接分组名自动排序」
 * - 非空：「默认」固定为最后一项，且只出现一次
 */
export function normalizeConnectionGroupsOrderForSave(names: string[]): string[] {
  const deduped = dedupeOrder(names);
  if (deduped.length === 0) {
    return [];
  }
  const rest = deduped.filter((x) => x !== DEFAULT_CONNECTION_GROUP);
  return [...rest, DEFAULT_CONNECTION_GROUP];
}

/**
 * 从管理列表中删掉的分组名（规范化后）。仅当新列表非空时迁移连接；新列表为空表示切回自动排序，不迁移。
 */
export function getRemovedGroupsForMigration(
  prevStored: string[],
  nextStored: string[]
): string[] {
  if (nextStored.length === 0) {
    return [];
  }
  const nextSet = new Set(nextStored);
  return prevStored.filter((p) => !nextSet.has(p));
}

/**
 * 连接表单「分组」下拉的候选项：与侧栏生效顺序一致，至少含「默认」；
 * 若当前连接的分组不在列表中（历史数据等），会追加一项。
 */
export function getConnectionGroupFormOptions(
  context: vscode.ExtensionContext,
  connections: DatasourceInputData[],
  currentGroup?: unknown
): { value: string; label: string }[] {
  const ordered = getOrderedConnectionGroups(context, connections);
  const names: string[] =
    ordered.length > 0 ? [...ordered] : [DEFAULT_CONNECTION_GROUP];
  const cur = normalizeConnectionGroupLabel(currentGroup);
  if (!names.includes(cur)) {
    names.push(cur);
  }
  return moveDefaultGroupToEnd(names).map((n) => ({ value: n, label: n }));
}

export async function setConnectionGroupsOrder(
  context: vscode.ExtensionContext,
  names: string[]
): Promise<void> {
  await context.globalState.update(GROUPS_KEY, names);
}
