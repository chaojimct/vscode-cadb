// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import path from "path";
import { DataSourceProvider } from "./provider/database_provider";
import { Datasource } from "./provider/entity/datasource";
import {
  registerDatasourceCommands,
  registerDatasourceItemCommands,
  registerDatabaseCommands,
  registerResultCommands,
  registerGridSidePanelCommand,
} from "./provider/component/commands";
import { DatabaseManager } from "./provider/component/database_manager";
import { AiChatProvider } from "./provider/component/ai_chat_provider";
import { ResultWebviewProvider } from "./provider/result_provider";
import { CaCompletionItemProvider } from "./provider/completion_item_provider";
import {
  SqlHoverProvider,
  lastHoveredTableInfo,
} from "./provider/component/sql_hover_provider";
import { SqlExecutor } from "./provider/component/sql_executor";
import { DatabaseStatusBar } from "./provider/component/database_status_bar";
import {
  MySQLTableWorkspaceSymbolProvider,
  CadbTableDocumentContentProvider,
  resolveTableDatasource,
} from "./provider/workspace_symbol_provider";
import { registerBuiltinDatabaseDrivers } from "./provider/drivers/builtin_drivers";
import { driverSupportsSqlExecution } from "./provider/drivers/registry";
import { getMysqlPoolRegistry } from "./provider/mysql/pool_registry";
import {
  CADB_GLOBAL_DATASOURCE_SIDEBAR_LAST_VISIBLE_KEY,
  CADB_WORKSPACE_OPEN_TABLE_PANELS_KEY,
} from "./provider/cadb_storage_keys";
import { format as formatSql } from "sql-formatter";
import { CadbDragAndDropController } from "./provider/component/cadb_drag_drop_controller";
import { showScanResultsInQuickPick } from "./provider/component/db_connection_scanner";

interface SqlStatementSpan {
  start: number;
  end: number;
}

interface SqlFileDatabaseBinding {
  datasource: string;
  database: string;
  updatedAt: number;
}

const SQL_FILE_DATABASE_STATE_KEY = "cadb.sqlFileDatabaseBindings";

/** 快速执行 SQL（Ctrl+Alt+Q）记住的连接名（与配置 name 一致）与库名 */
interface QuickExecuteSqlLastTarget {
  connectionName: string;
  databaseName: string;
}

const QUICK_EXECUTE_SQL_LAST_KEY = "cadb.quickExecuteSql.lastTarget";

function getQuickExecuteSqlLastTarget(
  ctx: vscode.ExtensionContext,
): QuickExecuteSqlLastTarget | undefined {
  const v = ctx.globalState.get<QuickExecuteSqlLastTarget>(
    QUICK_EXECUTE_SQL_LAST_KEY,
  );
  if (!v?.connectionName?.trim() || !v?.databaseName?.trim()) {
    return undefined;
  }
  return {
    connectionName: v.connectionName.trim(),
    databaseName: v.databaseName.trim(),
  };
}

async function setQuickExecuteSqlLastTarget(
  ctx: vscode.ExtensionContext,
  conn: Datasource,
  db: Datasource,
): Promise<void> {
  const connectionName = String(conn.data?.name ?? conn.label ?? "").trim();
  const databaseName = String(db.label ?? "").trim();
  if (!connectionName || !databaseName) {
    return;
  }
  await ctx.globalState.update(QUICK_EXECUTE_SQL_LAST_KEY, {
    connectionName,
    databaseName,
  });
}

function isQuickExecuteSqlLastStillValid(
  provider: DataSourceProvider,
  last: QuickExecuteSqlLastTarget,
): boolean {
  const raw = provider
    .getConnections()
    .find((ds) => ds.name === last.connectionName);
  return !!raw && driverSupportsSqlExecution(raw.dbType);
}

const QUICK_EXECUTE_SQL_HISTORY_KEY = "cadb.quickExecuteSql.history";

function getQuickExecuteSqlHistoryMaxEntries(): number {
  const n =
    vscode.workspace
      .getConfiguration("cadb")
      .get<number>("quickExecuteSql.historyMaxEntries", 10) ?? 10;
  return Math.max(1, Math.min(200, Math.floor(n)));
}

/** 历史列表 QuickPick 主行：取首行并截断 */
function previewQuickExecuteHistoryLabel(sql: string, maxLen: number): string {
  const line = sql.trim().split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!line) {
    return "(空语句)";
  }
  if (line.length <= maxLen) {
    return line;
  }
  return `${line.slice(0, Math.max(1, maxLen - 1))}…`;
}

async function appendQuickExecuteSqlHistory(
  ctx: vscode.ExtensionContext,
  sql: string,
): Promise<void> {
  const max = getQuickExecuteSqlHistoryMaxEntries();
  const t = sql.trim();
  if (!t) {
    return;
  }
  const prev =
    ctx.globalState.get<string[]>(QUICK_EXECUTE_SQL_HISTORY_KEY) ?? [];
  await ctx.globalState.update(
    QUICK_EXECUTE_SQL_HISTORY_KEY,
    [t, ...prev].slice(0, max),
  );
}

function readQuickExecuteSqlHistory(ctx: vscode.ExtensionContext): string[] {
  const max = getQuickExecuteSqlHistoryMaxEntries();
  const prev =
    ctx.globalState.get<string[]>(QUICK_EXECUTE_SQL_HISTORY_KEY) ?? [];
  return prev.slice(0, max).filter((s) => s.trim());
}

/** 与编辑器缩进选项一致的 SQL 格式化（供普通 .sql 等 languageId 为 sql 的文档使用） */
function formatSqlWithEditorOptions(
  text: string,
  options: vscode.FormattingOptions,
): string {
  return formatSql(text, {
    language: "mysql",
    tabWidth: Number(options.tabSize) || 2,
    useTabs: !options.insertSpaces,
    keywordCase: "upper",
  } as any);
}

/** 不限定 scheme，覆盖 file / untitled 等任意 scheme 的 sql 文档 */
const SQL_DOCUMENT_SELECTOR: vscode.DocumentSelector = { language: "sql" };

function parseSqlStatementSpans(text: string): SqlStatementSpan[] {
  const spans: SqlStatementSpan[] = [];
  let start = 0;
  let i = 0;
  let inString = false;
  let stringChar = "";
  let inLineComment = false;
  let inBlockComment = false;

  while (i < text.length) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : "";

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (!inString && ((ch === "-" && next === "-") || ch === "#")) {
      inLineComment = true;
      i += ch === "-" ? 2 : 1;
      continue;
    }
    if (!inString && ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      if (!inString) {
        inString = true;
        stringChar = ch;
      } else if (stringChar === ch) {
        const escaped = text[i - 1] === "\\" || next === ch;
        if (!escaped) {
          inString = false;
          stringChar = "";
        } else if (next === ch) {
          i++;
        }
      }
      i++;
      continue;
    }

    if (!inString && ch === ";") {
      spans.push({ start, end: i + 1 });
      start = i + 1;
    }
    i++;
  }

  if (start < text.length) {
    spans.push({ start, end: text.length });
  }
  return spans;
}

function splitSqlStatements(text: string): string[] {
  return parseSqlStatementSpans(text)
    .map((span) => text.slice(span.start, span.end).trim())
    .filter(Boolean);
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  registerBuiltinDatabaseDrivers();

  // 创建输出通道用于显示 SQL 执行日志
  const outputChannel = vscode.window.createOutputChannel("CADB SQL");
  context.subscriptions.push(outputChannel);
  const shouldAutoShowDatasourceSidebar =
    context.globalState.get<boolean>(
      CADB_GLOBAL_DATASOURCE_SIDEBAR_LAST_VISIBLE_KEY,
    ) === true;

  if (!shouldAutoShowDatasourceSidebar) {
    void context.workspaceState.update(
      CADB_WORKSPACE_OPEN_TABLE_PANELS_KEY,
      [],
    );
  }

  const provider = new DataSourceProvider(context);
  const treeView = vscode.window.createTreeView("cadb-datasource-tree", {
    treeDataProvider: provider,
    showCollapseAll: true,
    dragAndDropController: new CadbDragAndDropController(),
  });
  context.subscriptions.push(treeView);
  treeView.onDidExpandElement((e) => provider.addExpandedNode(e.element));
  treeView.onDidCollapseElement((e) => provider.removeExpandedNode(e.element));

  const datasourceCommands = registerDatasourceCommands(
    provider,
    treeView,
    outputChannel,
  );
  datasourceCommands.forEach((cmd) => context.subscriptions.push(cmd));

  // 恢复展开状态（延迟执行，等待树视图初始化完成）；上次未停在数据源侧栏时不做，减少 reveal 与 Workbench 抢焦点
  setTimeout(() => {
    if (!shouldAutoShowDatasourceSidebar) {
      return;
    }
    (async () => {
      try {
        const treeState = provider.getTreeState();
        if (treeState?.expandedNodes?.length) {
          const restoreExpandedState = async (
            element: Datasource,
            expandedNodes: string[],
          ): Promise<void> => {
            const nodePath = provider.getNodePath(element);
            if (expandedNodes.includes(nodePath)) {
              try {
                await treeView.reveal(element, { expand: true });
                await new Promise((resolve) => setTimeout(resolve, 100));
              } catch (_e) {
                /* 节点可能尚未加载 */
              }
            }
            if (element.children && element.children.length > 0) {
              for (const child of element.children) {
                await restoreExpandedState(child, expandedNodes);
              }
            }
          };
          const rootItems = provider.getRootNodes();
          for (const rootItem of rootItems) {
            await restoreExpandedState(rootItem, treeState.expandedNodes);
          }
        }
      } catch (error) {
        console.error("恢复展开状态失败:", error);
      }
    })();
  }, 1000);

  /** 启动后短时内忽略 visible=true，减轻 Workbench 先恢复 CADB 侧栏导致的误判 */
  const ignoreDatasourceSidebarTrueUntil = Date.now() + 2600;
  const persistDatasourceSidebarVisible = (visible: boolean): void => {
    if (
      visible &&
      !shouldAutoShowDatasourceSidebar &&
      Date.now() < ignoreDatasourceSidebarTrueUntil
    ) {
      return;
    }
    void context.globalState.update(
      CADB_GLOBAL_DATASOURCE_SIDEBAR_LAST_VISIBLE_KEY,
      visible,
    );
  };
  treeView.onDidChangeVisibility((e) => {
    persistDatasourceSidebarVisible(e.visible);
    if (e.visible) {
      provider.refresh();
      scheduleActiveEditorReveal("treeVisible");
    }
  });
  /** 扩展停用/重载时落盘，避免仅依赖 visibility 事件（异常退出时上一轮值仍可用） */
  context.subscriptions.push({
    dispose: () => {
      void context.globalState.update(
        CADB_GLOBAL_DATASOURCE_SIDEBAR_LAST_VISIBLE_KEY,
        treeView.visible,
      );
    },
  });
  setTimeout(() => {
    void context.globalState.update(
      CADB_GLOBAL_DATASOURCE_SIDEBAR_LAST_VISIBLE_KEY,
      treeView.visible,
    );
  }, 3000);
  let ensureDatasourceVisibleTask: Promise<void> | undefined;
  const ensureDatasourceVisible = async (): Promise<void> => {
    if (ensureDatasourceVisibleTask) {
      return ensureDatasourceVisibleTask;
    }
    ensureDatasourceVisibleTask = (async () => {
      const sleepLocal = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const runCmd = async (cmd: string): Promise<void> => {
        try {
          await vscode.commands.executeCommand(cmd);
        } catch {
          /* ignore */
        }
      };
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (treeView.visible) {
          return;
        }
        await runCmd("workbench.action.focusSideBar");
        await runCmd("workbench.view.extension.cadb-datasource");
        await runCmd("cadb-datasource-tree.focus");
        if (!treeView.visible) {
          await runCmd("workbench.view.explorer");
          await runCmd("cadb-datasource-tree.focus");
        }
        await sleepLocal(180);
        if (treeView.visible) {
          return;
        }
        await sleepLocal(500);
      }
    })().finally(() => {
      ensureDatasourceVisibleTask = undefined;
    });
    return ensureDatasourceVisibleTask;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.datasource.focus", async () => {
      await ensureDatasourceVisible();
      const roots = provider.getRootNodes();
      if (roots.length > 0) {
        try {
          await treeView.reveal(roots[0], {
            expand: true,
            select: false,
            focus: true,
          });
        } catch (e) {
          console.warn("聚焦首个根节点失败:", e);
        }
      }
    }),
  );
  // 仅当用户上次关闭前停留在 CADB 数据源视图时，启动后再尝试拉起侧栏（避免每次打开 VS Code 都强制切 Activity Bar）
  if (shouldAutoShowDatasourceSidebar) {
    setTimeout(() => {
      void ensureDatasourceVisible();
    }, 500);
  } else {
    const focusExplorerSidebar = async (): Promise<void> => {
      try {
        await vscode.commands.executeCommand("workbench.view.explorer");
      } catch {
        /* ignore */
      }
    };
    setTimeout(() => {
      void focusExplorerSidebar();
    }, 500);
    setTimeout(() => {
      void focusExplorerSidebar();
    }, 1600);
  }

  const toComparablePath = (inputPath: string): string => {
    const normalized = path.resolve(inputPath).replace(/\\/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };

  const isSameOrSubPath = (targetPath: string, basePath: string): boolean => {
    if (targetPath === basePath) {
      return true;
    }
    const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
    return targetPath.startsWith(base);
  };

  const getChildrenSafe = async (
    element?: Datasource,
  ): Promise<Datasource[]> => {
    const result = provider.getChildren(element);
    if (Array.isArray(result)) {
      return result;
    }
    const resolved = await Promise.resolve(result);
    return resolved ?? [];
  };

  const findConnectionForUri = (
    uri: vscode.Uri,
  ): { connectionName: string; fileName: string } | undefined => {
    const rawPath = uri.fsPath || "";
    if (!rawPath) {
      return undefined;
    }
    const filePath = toComparablePath(rawPath);
    const ext = path.extname(uri.fsPath).toLowerCase();
    if (ext !== ".sql") {
      return undefined;
    }

    let bestMatch: { connectionName: string; basePath: string } | undefined;
    for (const conn of provider.getConnections()) {
      const connName = (conn.name || "").trim();
      if (!connName) {
        continue;
      }
      const baseUri = provider.getConnectionFilesDirUri(connName);
      const basePath = toComparablePath(baseUri.fsPath);
      if (!isSameOrSubPath(filePath, basePath)) {
        continue;
      }
      if (!bestMatch || basePath.length > bestMatch.basePath.length) {
        bestMatch = { connectionName: connName, basePath };
      }
    }
    if (!bestMatch) {
      return undefined;
    }
    return {
      connectionName: bestMatch.connectionName,
      fileName: path.basename(uri.fsPath),
    };
  };

  const findConnectionNode = (
    connectionName: string,
  ): { group: Datasource; connection: Datasource } | undefined => {
    const target =
      process.platform === "win32"
        ? connectionName.toLowerCase()
        : connectionName;
    for (const root of provider.getRootNodes()) {
      if (root.type !== "group") {
        continue;
      }
      const conn = (root.children || []).find((child) => {
        if (child.type !== "datasource") {
          return false;
        }
        const label = child.label?.toString() || "";
        const comparable =
          process.platform === "win32" ? label.toLowerCase() : label;
        return comparable === target;
      });
      if (conn) {
        return { group: root, connection: conn };
      }
    }
    return undefined;
  };

  const equalsLabel = (
    left: string | undefined,
    right: string | undefined,
  ): boolean => {
    const l = (left || "").trim();
    const r = (right || "").trim();
    if (process.platform === "win32") {
      return l.toLowerCase() === r.toLowerCase();
    }
    return l === r;
  };

  const getFreshChildren = async (
    element: Datasource,
  ): Promise<Datasource[]> => {
    const children = await getChildrenSafe(element);
    if (children.length > 0) {
      return children;
    }
    // 某些场景 children 可能被旧缓存卡住，空列表时强制重载一次
    element.children = [];
    return getChildrenSafe(element);
  };

  const revealTableInDatasource = async (target: {
    connectionName: string;
    databaseName: string;
    tableName: string;
  }): Promise<boolean> => {
    const found = findConnectionNode(target.connectionName);
    if (!found) {
      return false;
    }
    try {
      const connectionChildren = await getFreshChildren(found.connection);
      const datasourceTypeNode = connectionChildren.find(
        (c) => c.type === "datasourceType",
      );
      if (!datasourceTypeNode) {
        return false;
      }
      const dbNodes = await getFreshChildren(datasourceTypeNode);
      const dbNode = dbNodes.find(
        (db) =>
          db.type === "collection" &&
          equalsLabel(db.label?.toString(), target.databaseName),
      );
      if (!dbNode) {
        return false;
      }
      const dbChildren = await getFreshChildren(dbNode);
      const collectionTypeNode = dbChildren.find(
        (c) => c.type === "collectionType",
      );
      if (!collectionTypeNode) {
        return false;
      }
      const tableNodes = await getFreshChildren(collectionTypeNode);
      const tableNode = tableNodes.find(
        (t) =>
          t.type === "document" &&
          equalsLabel(t.label?.toString(), target.tableName),
      );
      if (!tableNode) {
        return false;
      }
      // 仅对最终目标节点执行 reveal，避免中间节点多次滚动造成闪烁
      await treeView.reveal(tableNode, {
        expand: false,
        select: true,
        focus: false,
      });
      return true;
    } catch (error) {
      console.error("定位当前表到数据源视图失败:", error);
      return false;
    }
  };

  const getActiveDocumentUri = (): vscode.Uri | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      return editor.document.uri;
    }
    return undefined;
  };

  const revealTargetInDatasource = async (target: {
    connectionName: string;
    fileName: string;
  }): Promise<boolean> => {
    const found = findConnectionNode(target.connectionName);
    if (!found) {
      return false;
    }
    try {
      const connectionChildren = await getFreshChildren(found.connection);
      const fileTypeNode = connectionChildren.find(
        (c) => c.type === "fileType",
      );
      if (!fileTypeNode) {
        return false;
      }
      let fileNodes = await getFreshChildren(fileTypeNode);
      let targetFile = fileNodes.find(
        (file) =>
          file.type === "file" &&
          equalsLabel(file.label?.toString(), target.fileName),
      );
      if (!targetFile) {
        // 文件列表可能有缓存，未命中时强制重载一次
        fileTypeNode.children = [];
        fileNodes = await getChildrenSafe(fileTypeNode);
        targetFile = fileNodes.find(
          (file) =>
            file.type === "file" &&
            equalsLabel(file.label?.toString(), target.fileName),
        );
      }
      if (!targetFile) {
        return false;
      }
      // 仅对最终目标节点执行 reveal，避免中间节点多次滚动造成闪烁
      await treeView.reveal(targetFile, {
        expand: false,
        select: true,
        focus: false,
      });
      return true;
    } catch (error) {
      console.error("定位当前文件到数据源视图失败:", error);
      return false;
    }
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  let revealQueue: Promise<void> = Promise.resolve();
  let activeEditorRevealTimer: ReturnType<typeof setTimeout> | undefined;
  let lastActiveEditorRevealKey = "";
  let lastActiveEditorRevealAt = 0;
  let lastRevealByPathKey = "";
  let lastRevealByPathAt = 0;
  const ACTIVE_EDITOR_REVEAL_DEBOUNCE_MS = 120;
  const ACTIVE_EDITOR_REVEAL_DEDUP_MS = 400;
  const REVEAL_BY_PATH_DEDUP_MS = 280;
  const enqueueReveal = (reason: string, job: () => Promise<void>): void => {
    revealQueue = revealQueue
      .then(async () => {
        await job();
      })
      .catch((error) => {
        console.error("[CADB] enqueueReveal 异常", reason, error);
      });
  };

  const scheduleActiveEditorReveal = (reason: string): void => {
    if (activeEditorRevealTimer) {
      clearTimeout(activeEditorRevealTimer);
    }
    activeEditorRevealTimer = setTimeout(() => {
      enqueueReveal(`activeEditor:${reason}`, revealActiveEditorInDatasource);
    }, ACTIVE_EDITOR_REVEAL_DEBOUNCE_MS);
  };
  context.subscriptions.push({
    dispose: () => {
      if (activeEditorRevealTimer) {
        clearTimeout(activeEditorRevealTimer);
      }
    },
  });
  let treeDataSettleTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push({
    dispose: () => {
      if (treeDataSettleTimer) {
        clearTimeout(treeDataSettleTimer);
      }
    },
  });

  const revealActiveEditorInDatasource = async (): Promise<void> => {
    if (!treeView.visible) {
      return;
    }
    const uri = getActiveDocumentUri();
    if (!uri) {
      return;
    }
    const target = findConnectionForUri(uri);
    if (!target) {
      return;
    }
    const activeKey = `${target.connectionName}|${target.fileName}`;
    const now = Date.now();
    if (
      activeKey === lastActiveEditorRevealKey &&
      now - lastActiveEditorRevealAt < ACTIVE_EDITOR_REVEAL_DEDUP_MS
    ) {
      return;
    }
    // 初始化期间根节点/连接节点可能尚未准备好，做短暂重试
    for (let i = 0; i < 6; i++) {
      const ok = await revealTargetInDatasource(target);
      if (ok) {
        lastActiveEditorRevealKey = activeKey;
        lastActiveEditorRevealAt = Date.now();
        return;
      }
      await sleep(200);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.datasource.revealByPath",
      async (payload: {
        connectionName?: string;
        databaseName?: string;
        tableName?: string;
        fileName?: string;
      }) => {
        enqueueReveal("revealByPath", async () => {
          const connectionName = String(payload?.connectionName || "").trim();
          if (!connectionName) {
            return;
          }
          const dedupKey =
            payload?.databaseName && payload?.tableName
              ? `table|${connectionName}|${String(payload.databaseName)}|${String(payload.tableName)}`
              : payload?.fileName
                ? `file|${connectionName}|${String(payload.fileName)}`
                : "";
          if (dedupKey) {
            const now = Date.now();
            if (
              dedupKey === lastRevealByPathKey &&
              now - lastRevealByPathAt < REVEAL_BY_PATH_DEDUP_MS
            ) {
              return;
            }
            lastRevealByPathKey = dedupKey;
            lastRevealByPathAt = now;
          }
          await ensureDatasourceVisible();
          if (payload?.databaseName && payload?.tableName) {
            const target = {
              connectionName,
              databaseName: String(payload.databaseName),
              tableName: String(payload.tableName),
            };
            for (let i = 0; i < 6; i++) {
              const ok = await revealTableInDatasource(target);
              if (ok) {
                return;
              }
              if (i === 2) {
                provider.refresh();
              }
              await sleep(180);
            }
            return;
          }
          if (payload?.fileName) {
            const target = {
              connectionName,
              fileName: String(payload.fileName),
            };
            for (let i = 0; i < 6; i++) {
              const ok = await revealTargetInDatasource(target);
              if (ok) {
                return;
              }
              if (i === 2) {
                provider.refresh();
              }
              await sleep(180);
            }
          }
        });
      },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.datasource.revealActiveEditor",
      async () => {
        scheduleActiveEditorReveal("manualCommand");
      },
    ),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      scheduleActiveEditorReveal("onDidChangeActiveTextEditor");
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.refresh();
      scheduleActiveEditorReveal("onDidChangeWorkspaceFolders");
    }),
  );
  if (provider.onDidChangeTreeData) {
    context.subscriptions.push(
      provider.onDidChangeTreeData(() => {
        if (!treeView.visible) {
          return;
        }
        if (treeDataSettleTimer) {
          clearTimeout(treeDataSettleTimer);
        }
        treeDataSettleTimer = setTimeout(() => {
          scheduleActiveEditorReveal("treeDataSettled");
        }, 220);
      }),
    );
  }
  // 数据库管理器（替代 CaEditor，只保留数据库选择功能）
  const databaseManager = new DatabaseManager(provider);
  provider.setDatabaseManager(databaseManager);

  const getSqlFileKey = (document: vscode.TextDocument): string | undefined => {
    if (document.languageId !== "sql") return undefined;
    return document.uri.toString();
  };

  const getSqlFileBindings = (): Record<string, SqlFileDatabaseBinding> => {
    return context.workspaceState.get<Record<string, SqlFileDatabaseBinding>>(
      SQL_FILE_DATABASE_STATE_KEY,
      {},
    );
  };

  const persistSelectionForDocument = async (
    document: vscode.TextDocument,
  ): Promise<void> => {
    const key = getSqlFileKey(document);
    if (!key) return;
    const connection = databaseManager.getCurrentConnection();
    const database = databaseManager.getCurrentDatabase();
    if (!connection || !database) return;
    const datasource = connection.label?.toString() ?? "";
    const databaseName = database.label?.toString() ?? "";
    if (!datasource || !databaseName) return;

    const bindings = getSqlFileBindings();
    bindings[key] = {
      datasource,
      database: databaseName,
      updatedAt: Date.now(),
    };
    await context.workspaceState.update(SQL_FILE_DATABASE_STATE_KEY, bindings);
  };

  const persistSelectionForActiveSqlEditor = async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    await persistSelectionForDocument(editor.document);
  };

  const applyStoredSelectionForDocument = async (
    document: vscode.TextDocument,
  ): Promise<boolean> => {
    const key = getSqlFileKey(document);
    if (!key) return false;
    const bindings = getSqlFileBindings();
    const saved = bindings[key];
    if (!saved?.datasource || !saved?.database) return false;

    const currentConnection = databaseManager.getCurrentConnection();
    const currentDatabase = databaseManager.getCurrentDatabase();
    const sameAsCurrent =
      currentConnection?.label?.toString() === saved.datasource &&
      currentDatabase?.label?.toString() === saved.database;
    if (sameAsCurrent) return true;

    const ok = await databaseManager.setActiveDatabase(
      saved.datasource,
      saved.database,
    );
    if (!ok) {
      delete bindings[key];
      await context.workspaceState.update(
        SQL_FILE_DATABASE_STATE_KEY,
        bindings,
      );
      return false;
    }
    return true;
  };

  // 创建数据库状态栏管理器
  const databaseStatusBar = new DatabaseStatusBar(databaseManager);
  context.subscriptions.push(databaseStatusBar);

  const databaseSelector = registerDatabaseCommands(databaseManager);
  context.subscriptions.push(databaseSelector); // 注册数据库选择器

  // 注册选择数据库命令
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.selectDatabase", async () => {
      await databaseManager.selectDatabase();
      await persistSelectionForActiveSqlEditor();
    }),
  );

  // 数据库切换后，如果当前是 SQL 文件则自动记忆到该文件
  context.subscriptions.push(
    databaseManager.onDidChangeDatabase(() => {
      void persistSelectionForActiveSqlEditor();
    }),
  );

  // 切换到 SQL 文件时自动恢复该文件上次使用的数据源
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.languageId === "sql") {
        void applyStoredSelectionForDocument(editor.document);
      }
    }),
  );
  // 重载窗口时当前 SQL 编辑器可能不会触发 onDidChangeActiveTextEditor，需主动恢复一次绑定
  const initialEditor = vscode.window.activeTextEditor;
  if (initialEditor?.document.languageId === "sql") {
    void applyStoredSelectionForDocument(initialEditor.document);
  }

  // 数据项命令
  registerDatasourceItemCommands(provider, outputChannel, databaseManager, {
    restorePersistedTablePanelsOnStartup: shouldAutoShowDatasourceSidebar,
  });

  // 查询结果 Webview（底部面板）
  const resultProvider = new ResultWebviewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("query", resultProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  );
  registerResultCommands(resultProvider);
  context.subscriptions.push(registerGridSidePanelCommand());

  // AI 数据库聊天助手
  const aiChatProvider = new AiChatProvider();
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.ai.openChat", () => {
      aiChatProvider.open(provider, context, databaseManager);
    }),
    new vscode.Disposable(() => aiChatProvider.dispose()),
  );

  // SQL 自动补全（基于当前数据源/库选择，适用于 *.sql 等）
  const completionProvider = new CaCompletionItemProvider();
  completionProvider.setProvider(provider);
  completionProvider.setDatabaseManager(databaseManager);
  completionProvider.setPrepareSqlDocument(async (doc) => {
    await applyStoredSelectionForDocument(doc);
  });
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      SQL_DOCUMENT_SELECTOR,
      completionProvider,
      ".", // table.column
      " ", // 关键字后
      "`", // MySQL 标识符
    ),
  );

  // SQL 悬浮提示（表名展示 DDL，字段名展示类型、备注等）
  const sqlHoverProvider = new SqlHoverProvider();
  sqlHoverProvider.setProvider(provider);
  sqlHoverProvider.setDatabaseManager(databaseManager);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { language: "sql" },
      sqlHoverProvider,
    ),
  );
  context.subscriptions.push(
    new vscode.Disposable(() => sqlHoverProvider.dispose()),
  );

  // 表名悬浮弹窗的快捷命令：进入表数据、表编辑
  // 使用无参 command 链接，点击时从 lastHoveredTableInfo 读取（hover 内传参在某些环境下不生效）
  const resolveTableFromArgs = (
    args: unknown,
  ): [string, string, string] | null => {
    if (Array.isArray(args) && args.length >= 3) {
      return [String(args[0]), String(args[1]), String(args[2])];
    }
    if (typeof args === "string") {
      try {
        const arr = JSON.parse(args);
        return Array.isArray(arr) && arr.length >= 3
          ? [String(arr[0]), String(arr[1]), String(arr[2])]
          : null;
      } catch {
        return null;
      }
    }
    const last = lastHoveredTableInfo;
    return last ? [last.conn, last.db, last.table] : null;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.hover.openTableData",
      async (args: unknown) => {
        const parsed = resolveTableFromArgs(args);
        if (!parsed) return;
        const [conn, db, table] = parsed;
        const ds = await resolveTableDatasource(
          provider,
          context,
          conn,
          db,
          table,
        );
        if (ds) await vscode.commands.executeCommand("cadb.item.showData", ds);
      },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.hover.editTable",
      async (args: unknown) => {
        const parsed = resolveTableFromArgs(args);
        if (!parsed) return;
        const [conn, db, table] = parsed;
        const ds = await resolveTableDatasource(
          provider,
          context,
          conn,
          db,
          table,
        );
        if (ds)
          await vscode.commands.executeCommand("cadb.datasource.edit", ds);
      },
    ),
  );

  // 工作区符号：将 MySQL 数据表加入「转到工作区中的符号」(Ctrl/Cmd+T)，选择表可快速打开表数据
  const mysqlTableSymbolProvider = new MySQLTableWorkspaceSymbolProvider(
    provider,
    context,
  );
  context.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider(mysqlTableSymbolProvider),
  );

  // cadb:// 虚拟文档：从工作区符号打开表时，提供占位内容并触发「查看数据」打开表面板
  const cadbTableContentProvider = new CadbTableDocumentContentProvider(
    provider,
    context,
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "cadb",
      cadbTableContentProvider,
    ),
  );

  // SQL 执行器
  const sqlExecutor = new SqlExecutor(
    provider,
    databaseManager,
    resultProvider,
    outputChannel,
  );
  context.subscriptions.push(sqlExecutor);

  const getDocumentForQuickSqlExecution = (): Thenable<vscode.TextDocument> => {
    const ed = vscode.window.activeTextEditor;
    if (ed?.document.languageId === "sql") {
      return Promise.resolve(ed.document);
    }
    return vscode.workspace.openTextDocument({
      language: "sql",
      content: "",
    });
  };

  const runBundledQuickSqlStatements = async (
    trimmed: string,
  ): Promise<boolean> => {
    const docForExec = await getDocumentForQuickSqlExecution();
    const statements = splitSqlStatements(trimmed);
    if (statements.length === 0) {
      vscode.window.showWarningMessage("没有可执行的 SQL 语句");
      return false;
    }
    for (const stmt of statements) {
      await sqlExecutor.executeSql(stmt, docForExec);
    }
    return true;
  };

  // Ctrl+Alt+Q / Cmd+Alt+Q：快速选择连接与库（可「使用上次选择」）→ 输入 SQL → Enter 执行
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.quickExecuteSql", async () => {
      try {
        const last = getQuickExecuteSqlLastTarget(context);

        const picked = await databaseManager.selectConnectionAndDatabase(
          last && isQuickExecuteSqlLastStillValid(provider, last)
            ? last
            : undefined,
        );
        if (!picked) {
          return;
        }

        databaseManager.setCurrentDatabase(picked.database, true);
        const connForSave = picked.connection;
        const dbForSave = picked.database;

        const connLabel = connForSave.label?.toString() ?? "";
        const dbLabel = dbForSave.label?.toString() ?? "";

        const sqlText = await vscode.window.showInputBox({
          title: "CADB：快速执行 SQL",
          prompt: `将在「${connLabel} / ${dbLabel}」上执行，结果在查询结果视图`,
          placeHolder: "输入 SQL，按 Enter 执行；多条语句请用分号分隔",
          ignoreFocusOut: true,
        });
        if (sqlText === undefined) {
          return;
        }
        const trimmed = sqlText.trim();
        if (!trimmed) {
          vscode.window.showWarningMessage("SQL 为空");
          return;
        }

        const ok = await runBundledQuickSqlStatements(trimmed);
        if (ok) {
          await setQuickExecuteSqlLastTarget(context, connForSave, dbForSave);
          await appendQuickExecuteSqlHistory(context, trimmed);
        }
      } catch (e) {
        vscode.window.showErrorMessage(
          `快速执行 SQL 失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }),
  );

  // Ctrl+Alt+A / Cmd+Alt+A：从快速执行历史中选一条，用当前连接与库立即执行
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.quickExecuteSqlFromHistory",
      async () => {
        try {
          const list = readQuickExecuteSqlHistory(context);
          if (list.length === 0) {
            vscode.window.showInformationMessage(
              "暂无快速执行 SQL 历史，请先使用 Ctrl+Alt+Q（macOS：Cmd+Alt+Q）执行",
            );
            return;
          }

          interface HistPick extends vscode.QuickPickItem {
            fullSql: string;
          }
          const detailCap = 400;
          const items: HistPick[] = list.map((sql, i) => {
            const detail =
              sql.length <= detailCap ? sql : `${sql.slice(0, detailCap - 1)}…`;
            return {
              label: `${i + 1}. ${previewQuickExecuteHistoryLabel(sql, 56)}`,
              description:
                sql.includes("\n") || sql.length > 80
                  ? `(${sql.length} 字符)`
                  : undefined,
              detail,
              fullSql: sql,
            };
          });

          const pick = await vscode.window.showQuickPick(items, {
            placeHolder:
              "选择一条历史 SQL 立即执行（使用当前 CADB 连接与数据库）",
            matchOnDetail: true,
          });
          if (!pick) {
            return;
          }

          let conn = databaseManager.getCurrentConnection();
          let db = databaseManager.getCurrentDatabase();
          if (!conn || !db) {
            const choice = await vscode.window.showWarningMessage(
              "当前未选择数据源或数据库，执行前请先选择",
              "选择数据库",
              "取消",
            );
            if (choice !== "选择数据库") {
              return;
            }
            await databaseManager.selectDatabase();
            conn = databaseManager.getCurrentConnection();
            db = databaseManager.getCurrentDatabase();
            if (!conn || !db) {
              return;
            }
          }

          const sqlRun = pick.fullSql.trim();
          if (!sqlRun) {
            vscode.window.showWarningMessage("所选历史为空");
            return;
          }

          const ok = await runBundledQuickSqlStatements(sqlRun);
          if (ok) {
            await appendQuickExecuteSqlHistory(context, sqlRun);
          }
        } catch (e) {
          vscode.window.showErrorMessage(
            `从历史执行 SQL 失败: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      },
    ),
  );

  const getActiveSqlEditor = (): vscode.TextEditor | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    if (editor.document.languageId !== "sql") return undefined;
    return editor;
  };

  const executeSqlStatements = async (
    document: vscode.TextDocument,
    sqlText: string,
  ): Promise<void> => {
    await applyStoredSelectionForDocument(document);
    const statements = splitSqlStatements(sqlText);
    if (statements.length === 0) {
      vscode.window.showWarningMessage("没有可执行的 SQL 语句");
      return;
    }
    for (const stmt of statements) {
      await sqlExecutor.executeSql(stmt, document);
    }
    await persistSelectionForDocument(document);
  };

  // 运行当前语句（按分号拆分，取光标所在语句）
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.sql.runCurrent", async () => {
      const editor = getActiveSqlEditor();
      if (!editor) return;
      await applyStoredSelectionForDocument(editor.document);
      const text = editor.document.getText();
      const spans = parseSqlStatementSpans(text);
      if (spans.length === 0) {
        vscode.window.showWarningMessage("没有可执行的 SQL 语句");
        return;
      }
      const cursorOffset = editor.document.offsetAt(editor.selection.active);
      const currentSpan =
        spans.find((s) => cursorOffset >= s.start && cursorOffset <= s.end) ??
        spans.find((s) => text.slice(s.start, s.end).trim().length > 0);
      if (!currentSpan) {
        vscode.window.showWarningMessage("没有可执行的 SQL 语句");
        return;
      }
      const sql = text.slice(currentSpan.start, currentSpan.end).trim();
      if (!sql) {
        vscode.window.showWarningMessage("当前语句为空");
        return;
      }
      await sqlExecutor.executeSql(sql, editor.document);
      await persistSelectionForDocument(editor.document);
    }),
  );

  // 运行「当前行所在语句」：按分号切分后执行光标所在语句（多行格式化后仍为整条语句）
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.sql.runLine",
      async (uri?: string, line?: number) => {
        const editor = vscode.window.activeTextEditor;
        const targetUri =
          typeof uri === "string" && uri.length > 0
            ? vscode.Uri.parse(uri)
            : editor?.document.uri;
        if (!targetUri) return;

        const document = await vscode.workspace.openTextDocument(targetUri);
        await applyStoredSelectionForDocument(document);
        const targetLine =
          typeof line === "number"
            ? line
            : editor?.document.uri.toString() === targetUri.toString()
              ? editor.selection.active.line
              : 0;
        if (targetLine < 0 || targetLine >= document.lineCount) {
          vscode.window.showWarningMessage("当前行无效");
          return;
        }
        const lineObj = document.lineAt(targetLine);
        const lineText = lineObj.text;
        const rel = lineText.search(/\S/);
        const anchorOffset =
          rel >= 0
            ? document.offsetAt(new vscode.Position(targetLine, rel))
            : document.offsetAt(new vscode.Position(targetLine, 0));

        const text = document.getText();
        const spans = parseSqlStatementSpans(text);
        const span = spans.find(
          (s) => anchorOffset >= s.start && anchorOffset < s.end,
        );
        if (!span) {
          vscode.window.showWarningMessage("当前行没有可执行 SQL");
          return;
        }
        const sql = text.slice(span.start, span.end).trim();
        if (
          !sql ||
          sql.startsWith("--") ||
          sql.startsWith("#") ||
          sql.startsWith("/*")
        ) {
          vscode.window.showWarningMessage("当前行没有可执行 SQL");
          return;
        }
        await sqlExecutor.executeSql(sql, document);
        await persistSelectionForDocument(document);
      },
    ),
  );

  // 运行选中 SQL（支持多条）
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.sql.runSelection", async () => {
      const editor = getActiveSqlEditor();
      if (!editor) return;
      const selected = editor.document.getText(editor.selection).trim();
      if (!selected) {
        vscode.window.showWarningMessage("请先选中要执行的 SQL");
        return;
      }
      await executeSqlStatements(editor.document, selected);
    }),
  );

  // 运行全文 SQL（支持多条）
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.sql.runAll", async () => {
      const editor = getActiveSqlEditor();
      if (!editor) return;
      await executeSqlStatements(editor.document, editor.document.getText());
    }),
  );

  // 从资源管理器右键菜单运行 *.sql 文件（先选择连接与数据库，再执行文件中的所有 SQL）
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.sql.runFile",
      async (fileUri?: vscode.Uri) => {
        // 确定目标文件 URI
        const targetUri =
          fileUri ??
          (() => {
            const ed = vscode.window.activeTextEditor;
            return ed?.document.languageId === "sql"
              ? ed.document.uri
              : undefined;
          })();

        if (!targetUri) {
          vscode.window.showWarningMessage("未找到要执行的 SQL 文件");
          return;
        }

        // 一次性选择连接与数据库
        const picked = await databaseManager.selectConnectionAndDatabase();
        if (!picked) {
          return;
        }

        // 将所选连接和数据库写入 databaseManager，以便 sqlExecutor 读取
        const connectionName = picked.connection.label?.toString() ?? "";
        const databaseName = picked.database.label?.toString() ?? "";
        await databaseManager.setActiveDatabase(connectionName, databaseName);

        // 步骤 3：读取文件内容
        let sqlText: string;
        try {
          const bytes = await vscode.workspace.fs.readFile(targetUri);
          sqlText = Buffer.from(bytes).toString("utf-8");
        } catch (e) {
          vscode.window.showErrorMessage(
            `读取 SQL 文件失败: ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }

        const statements = splitSqlStatements(sqlText);
        if (statements.length === 0) {
          vscode.window.showWarningMessage("SQL 文件中没有可执行的语句");
          return;
        }

        // 步骤 4：打开文档（用于 sqlExecutor 接口），显示输出面板
        const document = await vscode.workspace.openTextDocument(targetUri);
        outputChannel.show(true);
        const fileName = targetUri.fsPath.split(/[\\/]/).pop() ?? "";
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        outputChannel.appendLine(
          `\n[${ts}] 开始执行文件 ${fileName} (${statements.length} 条语句) @ ${connectionName} / ${databaseName}`,
        );

        // 步骤 5：逐条执行
        for (const stmt of statements) {
          await sqlExecutor.executeSql(stmt, document);
        }

        outputChannel.appendLine(
          `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] 文件 ${fileName} 执行完毕`,
        );

        // 记忆本次选择，供该文件下次自动恢复
        await persistSelectionForDocument(document);
      },
    ),
  );

  // SQL 文档格式化：*.sql、未保存 SQL 等
  const sqlFormatterProvider: vscode.DocumentFormattingEditProvider = {
    provideDocumentFormattingEdits(document, options) {
      try {
        const formatted = formatSqlWithEditorOptions(
          document.getText(),
          options,
        );
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        );
        return [vscode.TextEdit.replace(fullRange, formatted)];
      } catch (error) {
        vscode.window.showErrorMessage(
          `SQL 格式化失败: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    },
  };
  const sqlRangeFormatterProvider: vscode.DocumentRangeFormattingEditProvider =
    {
      provideDocumentRangeFormattingEdits(document, range, options) {
        try {
          const fragment = document.getText(range);
          const formatted = formatSqlWithEditorOptions(fragment, options);
          return [vscode.TextEdit.replace(range, formatted)];
        } catch (error) {
          vscode.window.showErrorMessage(
            `SQL 格式化失败: ${error instanceof Error ? error.message : String(error)}`,
          );
          return [];
        }
      },
    };
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      SQL_DOCUMENT_SELECTOR,
      sqlFormatterProvider,
    ),
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      SQL_DOCUMENT_SELECTOR,
      sqlRangeFormatterProvider,
    ),
  );

  // 注册 SQL 执行命令
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.sql.run",
      async (uri: string, range: vscode.Range) => {
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.parse(uri),
        );
        await applyStoredSelectionForDocument(document);
        const sql = document.getText(range).trim();
        if (sql) {
          // 检查是否选择了数据库
          const currentConnection = databaseManager.getCurrentConnection();
          const currentDatabase = databaseManager.getCurrentDatabase();

          if (!currentConnection || !currentDatabase) {
            // 如果没有选择数据库，提示用户选择
            const choice = await vscode.window.showWarningMessage(
              "没有选择数据库连接，请先选择数据库连接",
              { modal: true },
              "选择数据库",
              "取消",
            );

            if (choice === "选择数据库") {
              await databaseManager.selectDatabase();

              // 再次检查是否选择了数据库
              const newConnection = databaseManager.getCurrentConnection();
              const newDatabase = databaseManager.getCurrentDatabase();

              if (!newConnection || !newDatabase) {
                vscode.window.showErrorMessage("未选择数据库连接，无法执行SQL");
                return;
              }
            } else {
              return; // 用户取消执行
            }
          }

          await sqlExecutor.executeSql(sql, document);
          await persistSelectionForDocument(document);
        }
      },
    ),
  );

  // 注册 SQL Explain 命令
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.sql.explain",
      async (uri: string, range: vscode.Range) => {
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.parse(uri),
        );
        await applyStoredSelectionForDocument(document);
        const fullText = document.getText();
        const anchorOffset = document.offsetAt(range.start);
        const spans = parseSqlStatementSpans(fullText);
        const span = spans.find(
          (s) => anchorOffset >= s.start && anchorOffset < s.end,
        );
        const sql = (
          span ? fullText.slice(span.start, span.end) : document.getText(range)
        ).trim();
        if (sql) {
          // 检查是否选择了数据库
          const currentConnection = databaseManager.getCurrentConnection();
          const currentDatabase = databaseManager.getCurrentDatabase();

          if (!currentConnection || !currentDatabase) {
            // 如果没有选择数据库，提示用户选择
            const choice = await vscode.window.showWarningMessage(
              "没有选择数据库连接，请先选择数据库连接",
              { modal: true },
              "选择数据库",
              "取消",
            );

            if (choice === "选择数据库") {
              await databaseManager.selectDatabase();

              // 再次检查是否选择了数据库
              const newConnection = databaseManager.getCurrentConnection();
              const newDatabase = databaseManager.getCurrentDatabase();

              if (!newConnection || !newDatabase) {
                vscode.window.showErrorMessage("未选择数据库连接，无法执行SQL");
                return;
              }
            } else {
              return; // 用户取消执行
            }
          }

          await sqlExecutor.explainSql(sql, document);
          await persistSelectionForDocument(document);
        }
      },
    ),
  );

  // 扫描工作区文件中的数据库连接配置
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.scanDbConnections", () =>
      showScanResultsInQuickPick(),
    ),
  );
}

// This method is called when your extension is deactivated
export function deactivate() {
  getMysqlPoolRegistry().dispose();
}
