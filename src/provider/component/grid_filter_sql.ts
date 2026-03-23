/**
 * 将 AG Grid Community 列 filterModel 转为 MySQL WHERE 片段（仅允许已知列名，值做转义）。
 * 与 https://www.ag-grid.com/javascript-data-grid/filtering/ 提供的 Text / Number / Date 条件对齐。
 */

import type { ColDef } from "../entity/dataloader";

function quoteIdent(field: string): string {
  return "`" + field.replace(/`/g, "``") + "`";
}

function escapeSqlString(s: string): string {
  return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

/** LIKE 通配符转义，配合 ESCAPE '\\' */
function escapeLikePattern(s: string): string {
  return String(s).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function colExpr(field: string): string {
  return quoteIdent(field);
}

function parseNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function textCondition(field: string, cond: Record<string, unknown>): string | null {
  const type = String(cond.type ?? "contains").toLowerCase();
  const c = colExpr(field);

  if (type === "blank") {
    return `(${c} IS NULL OR ${c} = '' OR CAST(${c} AS CHAR) = '')`;
  }
  if (type === "notblank") {
    return `(${c} IS NOT NULL AND ${c} <> '' AND CAST(${c} AS CHAR) <> '')`;
  }

  const raw = cond.filter;
  if (raw === undefined || raw === null) return null;
  const s = String(raw);
  const esc = escapeSqlString(s);
  const likeEsc = escapeLikePattern(s);
  const likeSuffix = " ESCAPE '\\\\'";

  switch (type) {
    case "equals":
      return `${c} = ${esc}`;
    case "notequal":
      return `${c} <> ${esc}`;
    case "contains":
      return `${c} LIKE ${escapeSqlString("%" + likeEsc + "%")}${likeSuffix}`;
    case "notcontains":
      return `${c} NOT LIKE ${escapeSqlString("%" + likeEsc + "%")}${likeSuffix}`;
    case "startswith":
      return `${c} LIKE ${escapeSqlString(likeEsc + "%")}${likeSuffix}`;
    case "endswith":
      return `${c} LIKE ${escapeSqlString("%" + likeEsc)}${likeSuffix}`;
    default:
      return `${c} LIKE ${escapeSqlString("%" + likeEsc + "%")}${likeSuffix}`;
  }
}

function combineText(field: string, model: Record<string, unknown>): string | null {
  const op = String(model.operator ?? "AND").toUpperCase();
  const joiner = op === "OR" ? " OR " : " AND ";
  const conditions = model.conditions;
  if (Array.isArray(conditions) && conditions.length > 0) {
    const parts: string[] = [];
    for (const c of conditions) {
      if (c && typeof c === "object") {
        const p = textCondition(field, c as Record<string, unknown>);
        if (p) parts.push(`(${p})`);
      }
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0] : `(${parts.join(joiner)})`;
  }
  return textCondition(field, model);
}

function numberCondition(field: string, cond: Record<string, unknown>): string | null {
  const type = String(cond.type ?? "equals").toLowerCase();
  const c = colExpr(field);

  if (type === "blank") {
    return `${c} IS NULL`;
  }
  if (type === "notblank") {
    return `${c} IS NOT NULL`;
  }

  if (type === "inrange") {
    const a = parseNumber(cond.filter);
    const b = parseNumber(cond.filterTo);
    if (a == null || b == null) return null;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return `${c} >= ${lo} AND ${c} <= ${hi}`;
  }

  const n = parseNumber(cond.filter);
  if (n == null) return null;

  switch (type) {
    case "equals":
      return `${c} = ${n}`;
    case "notequal":
      return `${c} <> ${n}`;
    case "lessthan":
      return `${c} < ${n}`;
    case "lessthanorequal":
      return `${c} <= ${n}`;
    case "greaterthan":
      return `${c} > ${n}`;
    case "greaterthanorequal":
      return `${c} >= ${n}`;
    default:
      return `${c} = ${n}`;
  }
}

function combineNumber(field: string, model: Record<string, unknown>): string | null {
  const op = String(model.operator ?? "AND").toUpperCase();
  const joiner = op === "OR" ? " OR " : " AND ";
  const conditions = model.conditions;
  if (Array.isArray(conditions) && conditions.length > 0) {
    const parts: string[] = [];
    for (const c of conditions) {
      if (c && typeof c === "object") {
        const p = numberCondition(field, c as Record<string, unknown>);
        if (p) parts.push(`(${p})`);
      }
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0] : `(${parts.join(joiner)})`;
  }
  return numberCondition(field, model);
}

/** 取日期比较用的字符串（YYYY-MM-DD 或带时间） */
function dateFromModel(cond: Record<string, unknown>): string | null {
  const from = cond.dateFrom ?? cond.filter;
  if (from == null || from === "") return null;
  if (typeof from === "string") return from;
  if (typeof from === "object" && from !== null && "date" in (from as object)) {
    const d = (from as { date?: string }).date;
    return d != null ? String(d) : null;
  }
  return String(from);
}

function dateToModel(cond: Record<string, unknown>): string | null {
  const to = cond.dateTo;
  if (to == null || to === "") return null;
  if (typeof to === "string") return to;
  if (typeof to === "object" && to !== null && "date" in (to as object)) {
    const d = (to as { date?: string }).date;
    return d != null ? String(d) : null;
  }
  return String(to);
}

function dateCondition(field: string, cond: Record<string, unknown>): string | null {
  const type = String(cond.type ?? "equals").toLowerCase();
  const c = colExpr(field);

  if (type === "blank") {
    return `${c} IS NULL`;
  }
  if (type === "notblank") {
    return `${c} IS NOT NULL`;
  }

  const df = dateFromModel(cond);
  const dt = dateToModel(cond);

  if (type === "inrange") {
    if (!df || !dt) return null;
    return `${c} >= ${escapeSqlString(df)} AND ${c} <= ${escapeSqlString(dt)}`;
  }

  if (!df) return null;
  const esc = escapeSqlString(df);

  switch (type) {
    case "equals":
      return `${c} >= ${esc} AND ${c} < DATE_ADD(${esc}, INTERVAL 1 DAY)`;
    case "notequal":
      return `(${c} < ${esc} OR ${c} >= DATE_ADD(${esc}, INTERVAL 1 DAY))`;
    case "lessthan":
      return `${c} < ${esc}`;
    case "greaterthan":
      return `${c} > ${esc}`;
    case "lessthanorequal":
      return `${c} <= ${esc}`;
    case "greaterthanorequal":
      return `${c} >= ${esc}`;
    default:
      return `${c} >= ${esc} AND ${c} < DATE_ADD(${esc}, INTERVAL 1 DAY)`;
  }
}

function combineDate(field: string, model: Record<string, unknown>): string | null {
  const op = String(model.operator ?? "AND").toUpperCase();
  const joiner = op === "OR" ? " OR " : " AND ";
  const conditions = model.conditions;
  if (Array.isArray(conditions) && conditions.length > 0) {
    const parts: string[] = [];
    for (const c of conditions) {
      if (c && typeof c === "object") {
        const p = dateCondition(field, c as Record<string, unknown>);
        if (p) parts.push(`(${p})`);
      }
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0] : `(${parts.join(joiner)})`;
  }
  return dateCondition(field, model);
}

function columnFilterToSql(field: string, raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const model = raw as Record<string, unknown>;
  const ft = String(model.filterType ?? "text").toLowerCase();

  if (ft === "number") {
    return combineNumber(field, model);
  }
  if (ft === "date") {
    return combineDate(field, model);
  }
  if (ft === "set") {
    return null;
  }
  return combineText(field, model);
}

/**
 * 返回不含 WHERE 关键字的条件表达式，或空串（无有效条件）
 */
export function buildMySqlWhereFromAgGridFilterModel(
  filterModel: Record<string, unknown> | null | undefined,
  columnDefs: ColDef[]
): string {
  if (!filterModel || typeof filterModel !== "object") return "";
  const allowed = new Set(
    columnDefs.map((c) => c.field).filter((f): f is string => typeof f === "string" && f.length > 0)
  );
  const parts: string[] = [];
  for (const [colId, raw] of Object.entries(filterModel)) {
    if (!allowed.has(colId)) continue;
    const expr = columnFilterToSql(colId, raw);
    if (expr) parts.push(`(${expr})`);
  }
  return parts.join(" AND ");
}

/** AG Grid 列排序状态（仅数据列） */
export type AgGridSortCol = { colId: string; sort: "asc" | "desc" };

/**
 * 返回不含 ORDER BY 关键字的排序片段，或空串
 */
export function buildMySqlOrderByFromSortModel(
  sortModel: AgGridSortCol[] | null | undefined,
  columnDefs: ColDef[]
): string {
  if (!sortModel?.length) return "";
  const allowed = new Set(
    columnDefs.map((c) => c.field).filter((f): f is string => typeof f === "string" && f.length > 0)
  );
  const parts: string[] = [];
  for (const s of sortModel) {
    if (!s || typeof s.colId !== "string" || !allowed.has(s.colId)) continue;
    const dir = s.sort === "desc" ? "DESC" : "ASC";
    parts.push(`${quoteIdent(s.colId)} ${dir}`);
  }
  return parts.join(", ");
}
