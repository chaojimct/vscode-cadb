/**
 * SELECT 查询在未指定 LIMIT 时自动追加 LIMIT，防止一次拉取过多行。
 * 条数使用 cadb.grid.pageSize；开关 cadb.query.autoAppendSelectLimit。
 */

/** 去除行首不可见字符（避免 CodeLens 等匹配失败） */
export function normalizeSqlLinePrefix(line: string): string {
  return line.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

function stripLeadingSqlComments(s: string): string {
  let t = s.trim();
  while (t.length > 0) {
    if (t.startsWith("--")) {
      const nl = t.indexOf("\n");
      if (nl === -1) return "";
      t = t.slice(nl + 1).trim();
      continue;
    }
    if (t.startsWith("/*")) {
      const end = t.indexOf("*/");
      if (end === -1) return t;
      t = t.slice(end + 2).trim();
      continue;
    }
    break;
  }
  return t;
}

/**
 * 若为主查询 SELECT/WITH 且末尾无 LIMIT，则追加 ` LIMIT n`（保留末尾分号习惯）
 * 复杂嵌套子查询若末尾无 LIMIT 可能产生不理想 SQL，可关闭 cadb.query.autoAppendSelectLimit。
 */
export function ensureSelectRowLimit(sql: string, limit: number): string {
  if (limit <= 0) return sql;
  const trimmed = sql.trim();
  if (!trimmed) return sql;

  const afterComments = stripLeadingSqlComments(trimmed);
  const u = afterComments.toUpperCase();
  if (!u.startsWith("SELECT") && !u.startsWith("WITH")) {
    return sql;
  }

  const withoutSemi = trimmed.replace(/;\s*$/, "");
  if (/\bLIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i.test(withoutSemi)) {
    return sql;
  }

  const hadSemi = /;\s*$/.test(trimmed);
  return `${withoutSemi} LIMIT ${limit}${hadSemi ? ";" : ""}`;
}
