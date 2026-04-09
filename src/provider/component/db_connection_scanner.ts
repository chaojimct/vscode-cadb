/**
 * 扫描工作区文件，识别其中硬编码的数据库连接信息。
 * 目前支持：*.yaml / *.yml / *.py / *.properties / *.go / *.env.*
 */
import * as vscode from "vscode";
import * as path from "path";

// ─── 类型定义 ────────────────────────────────────────────────────────────────

export interface ScannedConnection {
  /** 数据库类型（mysql / postgres / redis / mongodb / ...） */
  dbType: string;
  host: string;
  port: string;
  database: string;
  username: string;
  /** 明文密码（仅扫描显示，不存储） */
  password: string;
  /** 扫描来源：相对路径 */
  sourceFile: string;
  /** 扫描来源：1-based 行号 */
  sourceLine: number;
  /** 原始匹配字符串（摘要） */
  rawSnippet: string;
}

// ─── 文件 glob ────────────────────────────────────────────────────────────────

const FILE_GLOB = "**/*.{yaml,yml,py,properties,go,env}";
/** 额外匹配 .env.* 如 .env.local / .env.production */
const DOTENV_GLOB = "**/.env.*";

// ─── 各文件类型的扫描规则 ────────────────────────────────────────────────────

interface ScanRule {
  /** 识别 DB 类型的关键字，小写匹配 */
  dbKeyword: RegExp;
  /** 从该行或上下文中提取连接信息的正则，可能跨行但每条规则仅拿整段 */
  pattern: RegExp;
  /** 从 pattern match 中提取结构化字段（返回 null 则跳过） */
  extract: (
    m: RegExpMatchArray,
    raw: string,
  ) => Partial<ScannedConnection> | null;
}

/** 通用 DSN / URL 规则：mysql://user:pass@host:port/db */
const DSN_RULE: ScanRule = {
  dbKeyword: /./,
  pattern:
    /(?<scheme>mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis(?:s)?|mariadb|mssql|sqlserver|clickhouse|tidb):\/\/(?:(?<user>[^:@/\s]+)(?::(?<pass>[^@\s]*))?@)?(?<host>[^:/\s]+)(?::(?<port>\d+))?(?:\/(?<db>[^?\s#]*))?([\s\S]{0,200})/gi,
  extract(m) {
    const g = m.groups ?? {};
    const scheme = (g.scheme ?? "").toLowerCase();
    return {
      dbType: normalizeScheme(scheme),
      host: g.host ?? "",
      port: g.port ?? defaultPort(scheme),
      database: g.db ?? "",
      username: g.user ?? "",
      password: g.pass ?? "",
    };
  },
};

/** YAML / Properties 键值型规则 */
const KV_RULES: Array<{
  /** 匹配含有连接信息的行块（多行） */
  pattern: RegExp;
  extract: (m: RegExpMatchArray) => Partial<ScannedConnection> | null;
}> = [
  // Spring Boot / JDBC datasource URL
  {
    pattern:
      /url\s*[=:]\s*["']?jdbc:(?<scheme>mysql|postgresql|mariadb|sqlserver|oracle)[:/]+(?:(?<user>[^:@\s]+)(?::(?<pass>[^@\s]*))?@)?(?<host>[^:/\s"']+)(?::(?<port>\d+))?[/](?<db>[^?\s"'#]*)/gi,
    extract(m) {
      const g = m.groups ?? {};
      const scheme = (g.scheme ?? "").toLowerCase();
      return {
        dbType: normalizeScheme(scheme),
        host: g.host ?? "",
        port: g.port ?? defaultPort(scheme),
        database: g.db ?? "",
        username: g.user ?? "",
        password: g.pass ?? "",
      };
    },
  },
  // host/port/database/user/password 分离写法（yaml 缩进块 or properties）
  // 捕获不超过 500 字符的上下文块内出现的 host + port + db
  {
    pattern:
      /(?:host|hostname|server)\s*[=:]\s*["']?(?<host>[\w.\-]+)["']?[\s\S]{0,300}?(?:port)\s*[=:]\s*["']?(?<port>\d+)["']?[\s\S]{0,300}?(?:database|db|dbname|schema)\s*[=:]\s*["']?(?<db>[\w\-]+)["']?/gi,
    extract(m) {
      const g = m.groups ?? {};
      return {
        host: g.host ?? "",
        port: g.port ?? "",
        database: g.db ?? "",
      };
    },
  },
];

/** Python 常用连接串 */
const PYTHON_RULES: ScanRule[] = [
  // SQLAlchemy create_engine("mysql+pymysql://...")
  {
    dbKeyword: /./,
    pattern:
      /create_engine\s*\(\s*["'](?<scheme>mysql|postgresql|postgres|mariadb|mssql|sqlite|oracle|mongodb|redis)[+\w]*:\/\/(?:(?<user>[^:@\s"']+)(?::(?<pass>[^@\s"']*))?@)?(?<host>[^:/\s"']+)(?::(?<port>\d+))?\/(?<db>[^?\s"'#]*)/gi,
    extract(m) {
      const g = m.groups ?? {};
      const scheme = (g.scheme ?? "").toLowerCase();
      return {
        dbType: normalizeScheme(scheme),
        host: g.host ?? "",
        port: g.port ?? defaultPort(scheme),
        database: g.db ?? "",
        username: g.user ?? "",
        password: g.pass ?? "",
      };
    },
  },
  // pymysql.connect(host=..., user=..., password=..., database=...)
  {
    dbKeyword: /./,
    pattern:
      /(?:pymysql|mysql\.connector|psycopg2|redis)\.(?:connect|Redis|from_url)\s*\((?<args>[^)]{0,400})\)/gi,
    extract(m) {
      const args = m.groups?.args ?? "";
      return {
        dbType: guessDbTypeFromText(args),
        host: extractKwarg(args, "host"),
        port: extractKwarg(args, "port"),
        database: extractKwarg(args, "database") || extractKwarg(args, "db"),
        username: extractKwarg(args, "user") || extractKwarg(args, "username"),
        password:
          extractKwarg(args, "password") || extractKwarg(args, "passwd"),
      };
    },
  },
];

/** Go database/sql 规则 */
const GO_RULES: ScanRule[] = [
  // sql.Open("mysql", "user:pass@tcp(host:port)/db")
  {
    dbKeyword: /./,
    pattern:
      /sql\.Open\s*\(\s*"(?<scheme>[^"]+)"\s*,\s*"(?:(?<user>[^:@"\s]+)(?::(?<pass>[^@"\s]*))?@)?(?:tcp|unix|cloudsql)?\s*\(?(?<host>[^:/)\s"]+)(?::(?<port>\d+))?\)?\/(?<db>[^?"\s]*)/gi,
    extract(m) {
      const g = m.groups ?? {};
      const scheme = (g.scheme ?? "").toLowerCase();
      return {
        dbType: normalizeScheme(scheme),
        host: g.host ?? "",
        port: g.port ?? defaultPort(scheme),
        database: g.db ?? "",
        username: g.user ?? "",
        password: g.pass ?? "",
      };
    },
  },
  // gorm.Open(mysql.Open("..."))
  {
    dbKeyword: /./,
    pattern:
      /(?:mysql|postgres|sqlserver|clickhouse)\.Open\s*\(\s*"(?<dsn>[^"]{0,300})"/gi,
    extract(m) {
      // DSN 内容再匹配一次
      const dsn = m.groups?.dsn ?? "";
      const sub = DSN_RULE.pattern.exec(dsn);
      DSN_RULE.pattern.lastIndex = 0;
      if (!sub) return null;
      return DSN_RULE.extract(sub, dsn);
    },
  },
];

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

function normalizeScheme(s: string): string {
  const map: Record<string, string> = {
    mysql: "MySQL",
    mariadb: "MySQL",
    tidb: "MySQL",
    postgresql: "PostgreSQL",
    postgres: "PostgreSQL",
    mssql: "SQLServer",
    sqlserver: "SQLServer",
    sqlite: "SQLite",
    mongodb: "MongoDB",
    "mongodb+srv": "MongoDB",
    redis: "Redis",
    rediss: "Redis",
    clickhouse: "ClickHouse",
  };
  return map[s.toLowerCase()] ?? s;
}

function defaultPort(scheme: string): string {
  const ports: Record<string, string> = {
    mysql: "3306",
    mariadb: "3306",
    tidb: "4000",
    postgresql: "5432",
    postgres: "5432",
    mssql: "1433",
    sqlserver: "1433",
    mongodb: "27017",
    "mongodb+srv": "27017",
    redis: "6379",
    rediss: "6380",
    clickhouse: "9000",
  };
  return ports[scheme.toLowerCase()] ?? "";
}

function guessDbTypeFromText(text: string): string {
  if (/pymysql|mysql/i.test(text)) return "MySQL";
  if (/psycopg2|postgres/i.test(text)) return "PostgreSQL";
  if (/redis/i.test(text)) return "Redis";
  if (/mongo/i.test(text)) return "MongoDB";
  return "Unknown";
}

function extractKwarg(args: string, key: string): string {
  const m = args.match(
    new RegExp(`${key}\\s*=\\s*["']?([\\w.\\-]+)["']?`, "i"),
  );
  return m ? m[1] : "";
}

function dedup(list: ScannedConnection[]): ScannedConnection[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = `${c.dbType}|${c.host}|${c.port}|${c.database}|${c.username}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── 核心扫描逻辑 ─────────────────────────────────────────────────────────────

async function scanFile(uri: vscode.Uri): Promise<ScannedConnection[]> {
  let text: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    text = Buffer.from(bytes).toString("utf-8");
  } catch {
    return [];
  }

  const results: ScannedConnection[] = [];
  const relPath = vscode.workspace.asRelativePath(uri);
  const ext = path.extname(uri.fsPath).toLowerCase();
  const basename = path.basename(uri.fsPath).toLowerCase();

  function lineOf(index: number): number {
    return text.slice(0, index).split("\n").length;
  }

  function addHit(
    partial: Partial<ScannedConnection>,
    matchIndex: number,
    raw: string,
  ) {
    if (!partial.host && !partial.database) return; // 过滤无意义结果
    results.push({
      dbType: partial.dbType ?? "Unknown",
      host: partial.host ?? "",
      port: partial.port ?? "",
      database: partial.database ?? "",
      username: partial.username ?? "",
      password: partial.password ?? "",
      sourceFile: relPath,
      sourceLine: lineOf(matchIndex),
      rawSnippet: raw.slice(0, 120).replace(/\n/g, " "),
    });
  }

  // 1. DSN / URL 全文扫描（所有文件类型通用）
  {
    const re = new RegExp(DSN_RULE.pattern.source, DSN_RULE.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const r = DSN_RULE.extract(m, text);
      if (r) addHit(r, m.index, m[0]);
    }
  }

  // 2. 键值型规则（yaml/yml/properties/env）
  if (
    [".yaml", ".yml", ".properties"].includes(ext) ||
    /\.env/.test(basename)
  ) {
    for (const rule of KV_RULES) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const r = rule.extract(m);
        if (r) addHit(r, m.index, m[0]);
      }
    }
  }

  // 3. Python
  if (ext === ".py") {
    for (const rule of PYTHON_RULES) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const r = rule.extract(m, text);
        if (r) addHit(r, m.index, m[0]);
      }
    }
  }

  // 4. Go
  if (ext === ".go") {
    for (const rule of GO_RULES) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const r = rule.extract(m, text);
        if (r) addHit(r, m.index, m[0]);
      }
    }
  }

  return results;
}

/** 扫描整个工作区，返回去重后的连接列表，progress 可选 */
export async function scanWorkspaceConnections(
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<ScannedConnection[]> {
  const uris: vscode.Uri[] = [];

  const [files1, files2] = await Promise.all([
    vscode.workspace.findFiles(FILE_GLOB, "**/node_modules/**"),
    vscode.workspace.findFiles(DOTENV_GLOB, "**/node_modules/**"),
  ]);
  uris.push(...files1, ...files2);

  const total = uris.length;
  const allResults: ScannedConnection[] = [];

  for (let i = 0; i < uris.length; i++) {
    const uri = uris[i];
    if (progress) {
      progress.report({
        message: `(${i + 1}/${total}) ${vscode.workspace.asRelativePath(uri)}`,
        increment: 100 / total,
      });
    }
    const hits = await scanFile(uri);
    allResults.push(...hits);
  }

  return dedup(allResults);
}

// ─── QuickPick 展示 ───────────────────────────────────────────────────────────

/**
 * 扫描并将结果展示到 QuickPick，允许用户跳转到来源行。
 */
export async function showScanResultsInQuickPick(): Promise<void> {
  let connections: ScannedConnection[] = [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "CADB：正在扫描数据库连接…",
      cancellable: false,
    },
    async (progress) => {
      connections = await scanWorkspaceConnections(progress);
    },
  );

  if (connections.length === 0) {
    vscode.window.showInformationMessage("未在工作区文件中发现数据库连接配置");
    return;
  }

  const items: (vscode.QuickPickItem & { conn: ScannedConnection })[] =
    connections.map((c) => {
      const portStr = c.port ? `:${c.port}` : "";
      const userStr = c.username ? `${c.username}@` : "";
      const dbStr = c.database ? `/${c.database}` : "";
      return {
        label: `$(database) ${c.dbType}  ${userStr}${c.host}${portStr}${dbStr}`,
        description: `${c.sourceFile}:${c.sourceLine}`,
        detail: c.rawSnippet,
        conn: c,
      };
    });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `发现 ${connections.length} 个数据库连接，选择后跳转到来源行`,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) return;

  // 跳转到来源文件
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return;

  const fileUri = vscode.Uri.joinPath(
    workspaceFolders[0].uri,
    picked.conn.sourceFile,
  );
  try {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const line = Math.max(0, picked.conn.sourceLine - 1);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(line, 0, line, 0),
    });
  } catch {
    vscode.window.showWarningMessage(`无法打开文件：${picked.conn.sourceFile}`);
  }
}
