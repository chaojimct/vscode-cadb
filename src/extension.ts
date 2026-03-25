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
import { SqlNotebookSerializer } from "./provider/component/sql_notebook_serializer";
import { SqlNotebookController } from "./provider/component/sql_notebook_controller";
import { SqlNotebookRenderer } from "./provider/component/sql_notebook_renderer";
import { DatabaseManager } from "./provider/component/database_manager";
import { ResultWebviewProvider } from "./provider/result_provider";
import { CaCompletionItemProvider } from "./provider/completion_item_provider";
import { SqlCodeLensProvider } from "./provider/component/sql_codelens_provider";
import { SqlHoverProvider, lastHoveredTableInfo } from "./provider/component/sql_hover_provider";
import { SqlExecutor } from "./provider/component/sql_executor";
import { DatabaseStatusBar } from "./provider/component/database_status_bar";
import {
  MySQLTableWorkspaceSymbolProvider,
  CadbTableDocumentContentProvider,
  resolveTableDatasource,
} from "./provider/workspace_symbol_provider";
import { registerBuiltinDatabaseDrivers } from "./provider/drivers/builtin_drivers";
import { format as formatSql } from "sql-formatter";

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

    if (!inString && (ch === "-" && next === "-" || ch === "#")) {
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
    .map(span => text.slice(span.start, span.end).trim())
    .filter(Boolean);
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  registerBuiltinDatabaseDrivers();

  // 创建输出通道用于显示 SQL 执行日志
  const outputChannel = vscode.window.createOutputChannel("CADB SQL");
  context.subscriptions.push(outputChannel);
  const LAST_ACTIVE_TARGET_STATE_KEY = "cadb.lastActiveTarget";
  type LastActiveTargetState =
    | {
        kind: "file";
        uri: string;
        updatedAt: number;
      }
    | {
        kind: "tableData" | "tableEdit";
        connectionName: string;
        databaseName: string;
        tableName: string;
        updatedAt: number;
      };
  const revealLog = (message: string, data?: unknown): void => {
    const ts = new Date().toISOString();
    if (data === undefined) {
      outputChannel.appendLine(`[CADB REVEAL][${ts}] ${message}`);
      return;
    }
    try {
      outputChannel.appendLine(`[CADB REVEAL][${ts}] ${message} ${JSON.stringify(data)}`);
    } catch {
      outputChannel.appendLine(`[CADB REVEAL][${ts}] ${message}`);
    }
  };
  const persistLastActiveFileTarget = (uri: vscode.Uri | undefined): void => {
    if (!uri) {
      return;
    }
    // notebook 单元格 URI 不能作为可恢复目标（无法直接 openNotebookDocument）
    // 此类场景应由 onDidChangeActiveNotebookEditor 记录 notebook URI。
    if (uri.scheme === "vscode-notebook-cell") {
      return;
    }
    const fsPath = (uri.fsPath || "").toLowerCase();
    if (!fsPath.endsWith(".sql") && !fsPath.endsWith(".jsql")) {
      return;
    }
    void context.workspaceState.update(LAST_ACTIVE_TARGET_STATE_KEY, {
      kind: "file",
      uri: uri.toString(),
      updatedAt: Date.now(),
    } as LastActiveTargetState);
  };

  const provider = new DataSourceProvider(context);
  const treeView = vscode.window.createTreeView("cadb-datasource-tree", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  treeView.onDidExpandElement((e) => provider.addExpandedNode(e.element));
  treeView.onDidCollapseElement((e) => provider.removeExpandedNode(e.element));

  const datasourceCommands = registerDatasourceCommands(
    provider,
    treeView,
    outputChannel
  );
  datasourceCommands.forEach((cmd) => context.subscriptions.push(cmd));

  // 恢复展开状态（延迟执行，等待树视图初始化完成）
  setTimeout(() => {
    (async () => {
      try {
        const treeState = provider.getTreeState();
        if (treeState?.expandedNodes?.length) {
          const restoreExpandedState = async (
            element: Datasource,
            expandedNodes: string[]
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

  treeView.onDidChangeVisibility((e) => {
    if (e.visible) {
      provider.refresh();
      scheduleActiveEditorReveal("treeVisible");
    }
  });
  let ensureDatasourceVisibleTask: Promise<void> | undefined;
  const ensureDatasourceVisible = async (): Promise<void> => {
    if (ensureDatasourceVisibleTask) {
      return ensureDatasourceVisibleTask;
    }
    ensureDatasourceVisibleTask = (async () => {
      const sleepLocal = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const runCmd = async (cmd: string): Promise<void> => {
        try { await vscode.commands.executeCommand(cmd); } catch { /* ignore */ }
      };
      for (let attempt = 1; attempt <= 3; attempt++) {
        revealLog("ensureDatasourceVisible: 开始尝试", { attempt, visible: treeView.visible });
        if (treeView.visible) {
          revealLog("ensureDatasourceVisible: 视图已可见，直接返回");
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
          revealLog("ensureDatasourceVisible: 命令后视图可见，直接返回", { attempt });
          return;
        }
        await sleepLocal(500);
      }
      revealLog("ensureDatasourceVisible: 多次尝试后仍不可见，结束");
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
          await treeView.reveal(roots[0], { expand: true, select: false, focus: true });
        } catch (e) {
          console.warn("聚焦首个根节点失败:", e);
        }
      }
    })
  );
  // reload 后做双阶段拉起，兼容 Workbench 视图恢复延迟
  setTimeout(() => {
    void ensureDatasourceVisible();
  }, 0);
  setTimeout(() => {
    void ensureDatasourceVisible();
  }, 1200);

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

  const getChildrenSafe = async (element?: Datasource): Promise<Datasource[]> => {
    const result = provider.getChildren(element);
    if (Array.isArray(result)) {
      return result;
    }
    const resolved = await Promise.resolve(result);
    return resolved ?? [];
  };

  const findConnectionForUri = (
    uri: vscode.Uri
  ): { connectionName: string; fileName: string } | undefined => {
    revealLog("findConnectionForUri: 开始", {
      uri: uri.toString(),
      scheme: uri.scheme,
      fsPath: uri.fsPath,
    });
    const rawPath = uri.fsPath || "";
    if (!rawPath) {
      revealLog("findConnectionForUri: fsPath 为空，跳过");
      return undefined;
    }
    const filePath = toComparablePath(rawPath);
    const ext = path.extname(uri.fsPath).toLowerCase();
    if (ext !== ".sql" && ext !== ".jsql") {
      revealLog("findConnectionForUri: 非 sql/jsql，跳过", { ext });
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
      revealLog("findConnectionForUri: 未命中任何连接", {
        filePath,
        connections: provider.getConnections().map((c) => c.name || ""),
      });
      return undefined;
    }
    revealLog("findConnectionForUri: 命中连接", {
      connectionName: bestMatch.connectionName,
      fileName: path.basename(uri.fsPath),
      basePath: bestMatch.basePath,
    });
    return {
      connectionName: bestMatch.connectionName,
      fileName: path.basename(uri.fsPath),
    };
  };

  const findConnectionNode = (connectionName: string): { group: Datasource; connection: Datasource } | undefined => {
    const target = process.platform === "win32" ? connectionName.toLowerCase() : connectionName;
    for (const root of provider.getRootNodes()) {
      if (root.type !== "group") {
        continue;
      }
      const conn = (root.children || []).find(
        (child) => {
          if (child.type !== "datasource") {
            return false;
          }
          const label = child.label?.toString() || "";
          const comparable = process.platform === "win32" ? label.toLowerCase() : label;
          return comparable === target;
        }
      );
      if (conn) {
        revealLog("findConnectionNode: 命中连接节点", {
          connectionName,
          group: root.label?.toString() || "",
          connection: conn.label?.toString() || "",
        });
        return { group: root, connection: conn };
      }
    }
    const allConnectionNames = provider
      .getRootNodes()
      .flatMap((root) => (root.children || []).filter((c) => c.type === "datasource"))
      .map((c) => c.label?.toString() || "");
    revealLog("findConnectionNode: 未命中连接节点", {
      connectionName,
      allConnections: allConnectionNames,
      rootCount: provider.getRootNodes().length,
    });
    return undefined;
  };

  const equalsLabel = (left: string | undefined, right: string | undefined): boolean => {
    const l = (left || "").trim();
    const r = (right || "").trim();
    if (process.platform === "win32") {
      return l.toLowerCase() === r.toLowerCase();
    }
    return l === r;
  };

  const getFreshChildren = async (element: Datasource): Promise<Datasource[]> => {
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
    revealLog("revealTableInDatasource: 开始", target);
    const found = findConnectionNode(target.connectionName);
    if (!found) {
      revealLog("revealTableInDatasource: 连接节点未找到", target);
      return false;
    }
    try {
      const connectionChildren = await getFreshChildren(found.connection);
      const datasourceTypeNode = connectionChildren.find((c) => c.type === "datasourceType");
      if (!datasourceTypeNode) {
        revealLog("revealTableInDatasource: datasourceType 节点未找到", {
          connectionChildrenTypes: connectionChildren.map((c) => c.type),
          connectionChildrenLabels: connectionChildren.map((c) => c.label?.toString() || ""),
        });
        return false;
      }
      const dbNodes = await getFreshChildren(datasourceTypeNode);
      const dbNode = dbNodes.find(
        (db) => db.type === "collection" && equalsLabel(db.label?.toString(), target.databaseName)
      );
      if (!dbNode) {
        revealLog("revealTableInDatasource: database 节点未找到", {
          targetDatabase: target.databaseName,
          dbCandidates: dbNodes.map((n) => n.label?.toString() || ""),
        });
        return false;
      }
      const dbChildren = await getFreshChildren(dbNode);
      const collectionTypeNode = dbChildren.find((c) => c.type === "collectionType");
      if (!collectionTypeNode) {
        revealLog("revealTableInDatasource: collectionType 节点未找到", {
          database: dbNode.label?.toString() || "",
          dbChildrenTypes: dbChildren.map((c) => c.type),
          dbChildrenLabels: dbChildren.map((c) => c.label?.toString() || ""),
        });
        return false;
      }
      const tableNodes = await getFreshChildren(collectionTypeNode);
      const tableNode = tableNodes.find(
        (t) => t.type === "document" && equalsLabel(t.label?.toString(), target.tableName)
      );
      if (!tableNode) {
        revealLog("revealTableInDatasource: table 节点未找到", {
          targetTable: target.tableName,
          tableCandidates: tableNodes.map((n) => n.label?.toString() || ""),
        });
        return false;
      }
      // 仅对最终目标节点执行 reveal，避免中间节点多次滚动造成闪烁
      await treeView.reveal(tableNode, { expand: false, select: true, focus: false });
      revealLog("revealTableInDatasource: 定位成功", {
        table: tableNode.label?.toString() || "",
      });
      return true;
    } catch (error) {
      revealLog("revealTableInDatasource: 异常", {
        message: error instanceof Error ? error.message : String(error),
      });
      console.error("定位当前表到数据源视图失败:", error);
      return false;
    }
  };

  const getActiveDocumentUri = (): vscode.Uri | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      return editor.document.uri;
    }
    const notebookEditor = vscode.window.activeNotebookEditor;
    if (notebookEditor?.notebook) {
      return notebookEditor.notebook.uri;
    }
    return undefined;
  };

  const revealTargetInDatasource = async (
    target: { connectionName: string; fileName: string }
  ): Promise<boolean> => {
    revealLog("revealTargetInDatasource: 开始", target);
    const found = findConnectionNode(target.connectionName);
    if (!found) {
      revealLog("revealTargetInDatasource: 连接节点未找到", target);
      return false;
    }
    try {
      const connectionChildren = await getFreshChildren(found.connection);
      const fileTypeNode = connectionChildren.find((c) => c.type === "fileType");
      if (!fileTypeNode) {
        revealLog("revealTargetInDatasource: fileType 节点未找到", {
          connectionChildrenTypes: connectionChildren.map((c) => c.type),
          connectionChildrenLabels: connectionChildren.map((c) => c.label?.toString() || ""),
        });
        return false;
      }
      let fileNodes = await getFreshChildren(fileTypeNode);
      let targetFile = fileNodes.find(
        (file) => file.type === "file" && equalsLabel(file.label?.toString(), target.fileName)
      );
      if (!targetFile) {
        revealLog("revealTargetInDatasource: file 首次未命中，准备强制重载", {
          targetFile: target.fileName,
          fileCandidates: fileNodes.map((n) => n.label?.toString() || ""),
        });
        // 文件列表可能有缓存，未命中时强制重载一次
        fileTypeNode.children = [];
        fileNodes = await getChildrenSafe(fileTypeNode);
        targetFile = fileNodes.find(
          (file) => file.type === "file" && equalsLabel(file.label?.toString(), target.fileName)
        );
      }
      if (!targetFile) {
        revealLog("revealTargetInDatasource: file 仍未命中", {
          targetFile: target.fileName,
          fileCandidates: fileNodes.map((n) => n.label?.toString() || ""),
        });
        return false;
      }
      // 仅对最终目标节点执行 reveal，避免中间节点多次滚动造成闪烁
      await treeView.reveal(targetFile, { expand: false, select: true, focus: false });
      revealLog("revealTargetInDatasource: 定位成功", {
        file: targetFile.label?.toString() || "",
      });
      return true;
    } catch (error) {
      revealLog("revealTargetInDatasource: 异常", {
        message: error instanceof Error ? error.message : String(error),
      });
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
        revealLog("enqueueReveal: 开始", { reason });
        await job();
        revealLog("enqueueReveal: 完成", { reason });
      })
      .catch((error) => {
        revealLog("enqueueReveal: 异常", {
          reason,
          message: error instanceof Error ? error.message : String(error),
        });
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
      revealLog("revealActiveEditorInDatasource: 视图不可见，跳过本次定位");
      return;
    }
    const uri = getActiveDocumentUri();
    if (!uri) {
      revealLog("revealActiveEditorInDatasource: 当前无激活文档");
      return;
    }
    const target = findConnectionForUri(uri);
    if (!target) {
      revealLog("revealActiveEditorInDatasource: 当前文档无关联连接", {
        uri: uri.toString(),
      });
      return;
    }
    const activeKey = `${target.connectionName}|${target.fileName}`;
    const now = Date.now();
    if (
      activeKey === lastActiveEditorRevealKey &&
      now - lastActiveEditorRevealAt < ACTIVE_EDITOR_REVEAL_DEDUP_MS
    ) {
      revealLog("revealActiveEditorInDatasource: 命中去重窗口，跳过重复定位", {
        activeKey,
        elapsedMs: now - lastActiveEditorRevealAt,
      });
      return;
    }
    revealLog("revealActiveEditorInDatasource: 解析到目标", target);
    // 初始化期间根节点/连接节点可能尚未准备好，做短暂重试
    for (let i = 0; i < 6; i++) {
      const ok = await revealTargetInDatasource(target);
      if (ok) {
        lastActiveEditorRevealKey = activeKey;
        lastActiveEditorRevealAt = Date.now();
        revealLog("revealActiveEditorInDatasource: 定位成功", { attempt: i + 1 });
        return;
      }
      revealLog("revealActiveEditorInDatasource: 本轮定位失败，继续重试", { attempt: i + 1 });
      await sleep(200);
    }
    revealLog("revealActiveEditorInDatasource: 重试后仍失败", target);
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
        revealLog("cadb.datasource.revealByPath: 收到请求", payload);
        enqueueReveal("revealByPath", async () => {
          const connectionName = String(payload?.connectionName || "").trim();
          if (!connectionName) {
            revealLog("cadb.datasource.revealByPath: connectionName 为空，忽略");
            return;
          }
          const dedupKey = payload?.databaseName && payload?.tableName
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
              revealLog("cadb.datasource.revealByPath: 命中去重窗口，跳过重复请求", {
                dedupKey,
                elapsedMs: now - lastRevealByPathAt,
              });
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
                revealLog("cadb.datasource.revealByPath: 表定位成功", { attempt: i + 1, target });
                return;
              }
              if (i === 2) {
                revealLog("cadb.datasource.revealByPath: 表定位触发中途 refresh", { attempt: i + 1 });
                provider.refresh();
              }
              await sleep(180);
            }
            revealLog("cadb.datasource.revealByPath: 表定位最终失败", target);
            return;
          }
          if (payload?.fileName) {
            const target = { connectionName, fileName: String(payload.fileName) };
            for (let i = 0; i < 6; i++) {
              const ok = await revealTargetInDatasource(target);
              if (ok) {
                revealLog("cadb.datasource.revealByPath: 文件定位成功", { attempt: i + 1, target });
                return;
              }
              if (i === 2) {
                revealLog("cadb.datasource.revealByPath: 文件定位触发中途 refresh", { attempt: i + 1 });
                provider.refresh();
              }
              await sleep(180);
            }
            revealLog("cadb.datasource.revealByPath: 文件定位最终失败", target);
          }
        });
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.datasource.revealActiveEditor", async () => {
      scheduleActiveEditorReveal("manualCommand");
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      revealLog("事件: onDidChangeActiveTextEditor");
      persistLastActiveFileTarget(editor?.document.uri);
      scheduleActiveEditorReveal("onDidChangeActiveTextEditor");
    })
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      revealLog("事件: onDidChangeActiveNotebookEditor");
      persistLastActiveFileTarget(editor?.notebook.uri);
      scheduleActiveEditorReveal("onDidChangeActiveNotebookEditor");
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      revealLog("事件: onDidChangeWorkspaceFolders");
      provider.refresh();
      scheduleActiveEditorReveal("onDidChangeWorkspaceFolders");
    })
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
      })
    );
  }
  // 启动期兜底：树完成首轮恢复后再补一轮当前激活文件定位
  setTimeout(() => {
    scheduleActiveEditorReveal("startup-post-1800ms");
  }, 1800);
  setTimeout(() => {
    scheduleActiveEditorReveal("startup-post-3200ms");
  }, 3200);
  const restoreLastActiveTarget = async (reason: string): Promise<void> => {
    const target = context.workspaceState.get<LastActiveTargetState | undefined>(
      LAST_ACTIVE_TARGET_STATE_KEY
    );
    if (!target) {
      return;
    }
    revealLog("restoreLastActiveTarget: 尝试恢复", { reason, target });
    try {
      if (target.kind === "file" && target.uri) {
        let uri = vscode.Uri.parse(target.uri);
        // 兼容旧状态：若历史保存了 cell-uri，则转成文件 URI 再恢复
        if (uri.scheme === "vscode-notebook-cell") {
          uri = vscode.Uri.file(uri.fsPath);
        }
        if ((uri.fsPath || "").toLowerCase().endsWith(".jsql")) {
          const nb = await vscode.workspace.openNotebookDocument(uri);
          await vscode.window.showNotebookDocument(nb, {
            preserveFocus: false,
            preview: false,
            viewColumn: vscode.ViewColumn.Active,
          });
        } else {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, {
            preview: false,
            viewColumn: vscode.ViewColumn.Active,
          });
        }
        scheduleActiveEditorReveal(`restoreLastActiveTarget:${reason}:file`);
        return;
      }
      if (target.kind === "tableData" || target.kind === "tableEdit") {
        const ok = await vscode.commands.executeCommand<boolean>("cadb.internal.activateTablePanel", {
          kind: target.kind,
          connectionName: target.connectionName,
          databaseName: target.databaseName,
          tableName: target.tableName,
        });
        if (!ok) {
          revealLog("restoreLastActiveTarget: 表目标恢复未命中", { reason, target });
        }
      }
    } catch (error) {
      revealLog("restoreLastActiveTarget: 恢复失败", {
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  setTimeout(() => {
    void restoreLastActiveTarget("startup-2600ms");
  }, 2600);
  setTimeout(() => {
    void restoreLastActiveTarget("startup-4200ms");
  }, 4200);

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
      {}
    );
  };

  const persistSelectionForDocument = async (document: vscode.TextDocument): Promise<void> => {
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

  const applyStoredSelectionForDocument = async (document: vscode.TextDocument): Promise<boolean> => {
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

    const ok = await databaseManager.setActiveDatabase(saved.datasource, saved.database);
    if (!ok) {
      delete bindings[key];
      await context.workspaceState.update(SQL_FILE_DATABASE_STATE_KEY, bindings);
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
    vscode.commands.registerCommand('cadb.selectDatabase', async () => {
      await databaseManager.selectDatabase();
      await persistSelectionForActiveSqlEditor();
    })
  );

  // 数据库切换后，如果当前是 SQL 文件则自动记忆到该文件
  context.subscriptions.push(
    databaseManager.onDidChangeDatabase(() => {
      void persistSelectionForActiveSqlEditor();
    })
  );

  // 切换到 SQL 文件时自动恢复该文件上次使用的数据源
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.languageId === "sql") {
        void applyStoredSelectionForDocument(editor.document);
      }
    })
  );
  // 重载窗口时当前 SQL 编辑器可能不会触发 onDidChangeActiveTextEditor，需主动恢复一次绑定
  const initialEditor = vscode.window.activeTextEditor;
  if (initialEditor?.document.languageId === "sql") {
    void applyStoredSelectionForDocument(initialEditor.document);
  }
  persistLastActiveFileTarget(initialEditor?.document.uri);
  persistLastActiveFileTarget(vscode.window.activeNotebookEditor?.notebook.uri);

  // 数据项命令
  registerDatasourceItemCommands(provider, outputChannel, databaseManager);

  // 查询结果 Webview（底部面板）
  const resultProvider = new ResultWebviewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("query", resultProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );
  registerResultCommands(resultProvider);
  context.subscriptions.push(registerGridSidePanelCommand());

  // SQL Notebook API（用于打开 .jsql 文件）
  const notebookSerializer = new SqlNotebookSerializer();
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer('cadb.sqlNotebook', notebookSerializer)
  );

  // SQL Notebook 控制器（执行 SQL 代码单元格）
  const notebookController = new SqlNotebookController(
    'cadb.sql-notebook-controller',
    'cadb.sqlNotebook',
    'SQL Notebook',
    provider,
    context,
    databaseManager  // 传入 databaseManager 以获取当前选择的数据库
  );
  context.subscriptions.push(notebookController);

  // SQL Notebook 渲染器（渲染查询结果和错误）
  const notebookRenderer = new SqlNotebookRenderer(context);
  context.subscriptions.push(notebookRenderer);

  // 监听 Notebook 打开事件，自动设置数据库连接
  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument(async (notebook) => {
      // 只处理 SQL Notebook
      if (notebook.notebookType !== 'cadb.sqlNotebook') {
        return;
      }

      // 读取 Notebook 元数据中的数据库连接信息
      const metadata = notebook.metadata;
      const datasourceName = metadata?.datasource;
      const databaseName = metadata?.database;

      if (datasourceName && databaseName) {
        console.log(`[Notebook] 检测到连接信息: ${datasourceName} / ${databaseName}`);
        // 立即设置数据库状态，确保顶部工具栏/状态栏能回显（不依赖后续展开）
        const ok = await databaseManager.setActiveDatabase(datasourceName, databaseName);
        if (ok) {
          console.log(`[Notebook] 已回显数据库: ${datasourceName} / ${databaseName}`);
        }
        // 可选：后台尝试用完整节点更新（用于依赖树结构的逻辑）
        try {
          const connections = provider.getConnections();
          const connectionData = connections.find(
            (conn) => conn.name === datasourceName
          );
          if (connectionData) {
            const connection = new Datasource(connectionData);
            const objects = await connection.expand(context);
            const datasourceTypeNode = objects.find(
              (obj) => obj.type === 'datasourceType'
            );
            if (datasourceTypeNode) {
              const databases = await datasourceTypeNode.expand(context);
              const database = databases.find(
                (db) => db.label === databaseName
              );
              if (database) {
                databaseManager.setCurrentDatabase(database, true);
              }
            }
          }
        } catch (error) {
          console.error('[Notebook] 后台加载数据库节点失败:', error);
        }
      }
    })
  );

  // 已选择数据库时显示的按钮，点击可更换（同 selectDatabase）
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.currentDatabase', async () => {
      await databaseManager.selectDatabase();
    })
  );

  // Cell 底部执行栏（kernel 选择器左侧）：展示该 cell 的数据源/库，点击可设置或切换
  try {
    const registerFn = (vscode.notebooks as any).registerNotebookCellStatusBarItemProvider;
    if (typeof registerFn === 'function') {
      const Right = (vscode as any).NotebookCellStatusBarAlignment?.Right ?? 1;
      context.subscriptions.push(
        registerFn.call(vscode.notebooks, { viewType: 'cadb.sqlNotebook' }, {
          provideCellStatusBarItems: (cell: vscode.NotebookCell, _token: vscode.CancellationToken) => {
            const cadb = cell.metadata?.cadb as { datasource?: string; database?: string } | undefined;
            const ds = cadb?.datasource ?? '';
            const db = cadb?.database ?? '';
            const text = ds && db ? `${ds} / ${db}` : '$(database) 设置数据源';
            return [{
              text,
              alignment: Right,
              command: { command: 'cadb.notebook.setCellDatabase', arguments: [cell] },
              tooltip: ds && db ? `点击更换数据源：${ds} / ${db}` : '点击设置该 Cell 的数据源',
            }];
          },
        })
      );
    }
  } catch (e) {
    console.warn('[CADB] registerNotebookCellStatusBarItemProvider 不可用:', e);
  }

  // 为当前 Cell 单独设置数据库连接（保存到 cell.metadata）
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.setCellDatabase', async (cell?: vscode.NotebookCell) => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor || editor.notebook.notebookType !== 'cadb.sqlNotebook') return;
      let targetCell: vscode.NotebookCell | undefined = cell;
      if (!targetCell) {
        const sel = (editor as any).selection;
        if (sel && typeof sel.start === 'number') {
          targetCell = editor.notebook.cellAt(sel.start);
        }
        targetCell ??= editor.notebook.getCells()[0];
      }
      if (!targetCell || !targetCell.notebook) return;
      await databaseManager.selectDatabase();
      const conn = databaseManager.getCurrentConnection();
      const db = databaseManager.getCurrentDatabase();
      if (!conn || !db) return;
      const datasource = conn.label?.toString() ?? '';
      const database = db.label?.toString() ?? '';
      const edit = new vscode.WorkspaceEdit();
      const newMetadata = { ...targetCell.metadata, cadb: { datasource, database } };
      edit.set(targetCell.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(targetCell.index, newMetadata)]);
      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(`已为 Cell 设置: ${datasource} / ${database}`);
    })
  );

  // 收起/展开全部结果：通过 createRendererMessaging 发到 renderer
  const rendererMessaging = vscode.notebooks.createRendererMessaging('cadb.sql-notebook-renderer');
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.collapseAllResults', () => {
      const editor = vscode.window.activeNotebookEditor;
      if (editor?.notebook?.notebookType !== 'cadb.sqlNotebook') return;
      void rendererMessaging.postMessage({ type: 'collapseAll' }, editor);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.expandAllResults', () => {
      const editor = vscode.window.activeNotebookEditor;
      if (editor?.notebook?.notebookType !== 'cadb.sqlNotebook') return;
      void rendererMessaging.postMessage({ type: 'expandAll' }, editor);
    })
  );

  // 注册 Notebook 数据库状态显示命令（用于工具栏显示）
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.showDatabaseStatus', () => {
      const connection = databaseManager.getCurrentConnection();
      const database = databaseManager.getCurrentDatabase();
      
      if (connection && database) {
        vscode.window.showInformationMessage(
          `当前数据库: ${connection.label} / ${database.label}`
        );
      } else if (connection) {
        vscode.window.showWarningMessage(
          `已选择连接: ${connection.label}，但未选择数据库`
        );
      } else {
        vscode.window.showWarningMessage('未选择数据库连接');
      }
    })
  );

  // 注册 Notebook 相关命令
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.new', async () => {
      // 创建新的 .jsql 文件
      const uri = await vscode.window.showSaveDialog({
        filters: {
          'SQL Notebook': ['jsql']
        },
        defaultUri: vscode.Uri.file('untitled.jsql')
      });

      if (uri) {
        // 创建空的 notebook 内容
        const emptyNotebook = {
          datasource: null,
          database: null,
          cells: []
        };
        const content = JSON.stringify(emptyNotebook, null, 2);
        
        // 写入文件
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        
        // 打开文件
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showNotebookDocument(
          await vscode.workspace.openNotebookDocument(uri)
        );
      }
    })
  );

  // SQL 自动补全（仅支持 Notebook）
  const completionProvider = new CaCompletionItemProvider();
  completionProvider.setProvider(provider);
  completionProvider.setDatabaseManager(databaseManager);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { notebookType: "cadb.sqlNotebook" },
      completionProvider,
      ".", // 触发字符：点号用于 table.column
      " " // 触发字符：空格用于关键字后
    )
  );

  // SQL CodeLens 提供者（在 SQL 语句上方显示 Run 和 Explain）
  const sqlCodeLensProvider = new SqlCodeLensProvider(databaseManager);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: "sql" },
      sqlCodeLensProvider
    )
  );

  // SQL 悬浮提示（表名展示 DDL，字段名展示类型、备注等）
  const sqlHoverProvider = new SqlHoverProvider();
  sqlHoverProvider.setProvider(provider);
  sqlHoverProvider.setDatabaseManager(databaseManager);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: "sql" }, sqlHoverProvider)
  );

  // 表名悬浮弹窗的快捷命令：进入表数据、表编辑
  // 使用无参 command 链接，点击时从 lastHoveredTableInfo 读取（hover 内传参在某些环境下不生效）
  const resolveTableFromArgs = (args: unknown): [string, string, string] | null => {
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
    vscode.commands.registerCommand("cadb.hover.openTableData", async (args: unknown) => {
      const parsed = resolveTableFromArgs(args);
      if (!parsed) return;
      const [conn, db, table] = parsed;
      const ds = await resolveTableDatasource(provider, context, conn, db, table);
      if (ds) await vscode.commands.executeCommand("cadb.item.showData", ds);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.hover.editTable", async (args: unknown) => {
      const parsed = resolveTableFromArgs(args);
      if (!parsed) return;
      const [conn, db, table] = parsed;
      const ds = await resolveTableDatasource(provider, context, conn, db, table);
      if (ds) await vscode.commands.executeCommand("cadb.datasource.edit", ds);
    })
  );

  // 工作区符号：将 MySQL 数据表加入「转到工作区中的符号」(Ctrl/Cmd+T)，选择表可快速打开表数据
  const mysqlTableSymbolProvider = new MySQLTableWorkspaceSymbolProvider(
    provider,
    context
  );
  context.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider(mysqlTableSymbolProvider)
  );

  // cadb:// 虚拟文档：从工作区符号打开表时，提供占位内容并触发「查看数据」打开表面板
  const cadbTableContentProvider = new CadbTableDocumentContentProvider(
    provider,
    context
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "cadb",
      cadbTableContentProvider
    )
  );

  // SQL 执行器
  const sqlExecutor = new SqlExecutor(provider, databaseManager, resultProvider, outputChannel);
  context.subscriptions.push(sqlExecutor);

  const getActiveSqlEditor = (): vscode.TextEditor | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    if (editor.document.languageId !== "sql") return undefined;
    return editor;
  };

  const executeSqlStatements = async (document: vscode.TextDocument, sqlText: string): Promise<void> => {
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
    sqlCodeLensProvider.refresh();
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
        spans.find(s => cursorOffset >= s.start && cursorOffset <= s.end) ??
        spans.find(s => text.slice(s.start, s.end).trim().length > 0);
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
      sqlCodeLensProvider.refresh();
    })
  );

  // 运行当前行
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.sql.runLine", async (uri?: string, line?: number) => {
      const editor = vscode.window.activeTextEditor;
      const targetUri =
        typeof uri === "string" && uri.length > 0
          ? vscode.Uri.parse(uri)
          : editor?.document.uri;
      if (!targetUri) return;

      const document = await vscode.workspace.openTextDocument(targetUri);
      await applyStoredSelectionForDocument(document);
      const targetLine =
        typeof line === "number" ? line : editor?.document.uri.toString() === targetUri.toString()
          ? editor.selection.active.line
          : 0;
      if (targetLine < 0 || targetLine >= document.lineCount) {
        vscode.window.showWarningMessage("当前行无效");
        return;
      }
      const sql = document.lineAt(targetLine).text.trim();
      if (!sql || sql.startsWith("--") || sql.startsWith("/*")) {
        vscode.window.showWarningMessage("当前行没有可执行 SQL");
        return;
      }
      await sqlExecutor.executeSql(sql, document);
      await persistSelectionForDocument(document);
      sqlCodeLensProvider.refresh();
    })
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
    })
  );

  // 运行全文 SQL（支持多条）
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.sql.runAll", async () => {
      const editor = getActiveSqlEditor();
      if (!editor) return;
      await executeSqlStatements(editor.document, editor.document.getText());
    })
  );

  // SQL 文档格式化（file/untitled）
  const sqlFormatterProvider: vscode.DocumentFormattingEditProvider = {
    provideDocumentFormattingEdits(document, options) {
      try {
        const formatted = formatSql(document.getText(), {
          language: "mysql",
          tabWidth: Number(options.tabSize) || 2,
          useTabs: !options.insertSpaces,
          keywordCase: "upper",
        } as any);
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        return [vscode.TextEdit.replace(fullRange, formatted)];
      } catch (error) {
        vscode.window.showErrorMessage(
          `SQL 格式化失败: ${error instanceof Error ? error.message : String(error)}`
        );
        return [];
      }
    },
  };
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      [{ language: "sql", scheme: "file" }, { language: "sql", scheme: "untitled" }],
      sqlFormatterProvider
    )
  );

  // 注册 SQL 执行命令
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.sql.run",
      async (uri: string, range: vscode.Range) => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        await applyStoredSelectionForDocument(document);
        const sql = document.getText(range).trim();
        if (sql) {
          // 检查是否选择了数据库
          const currentConnection = databaseManager.getCurrentConnection();
          const currentDatabase = databaseManager.getCurrentDatabase();

          if (!currentConnection || !currentDatabase) {
            // 如果没有选择数据库，提示用户选择
            const choice = await vscode.window.showWarningMessage(
              '没有选择数据库连接，请先选择数据库连接',
              { modal: true },
              '选择数据库', '取消'
            );

            if (choice === '选择数据库') {
              await databaseManager.selectDatabase();
              
              // 再次检查是否选择了数据库
              const newConnection = databaseManager.getCurrentConnection();
              const newDatabase = databaseManager.getCurrentDatabase();
              
              if (!newConnection || !newDatabase) {
                vscode.window.showErrorMessage('未选择数据库连接，无法执行SQL');
                return;
              }
            } else {
              return; // 用户取消执行
            }
          }

          await sqlExecutor.executeSql(sql, document);
          await persistSelectionForDocument(document);
          // 刷新 CodeLens
          sqlCodeLensProvider.refresh();
        }
      }
    )
  );

  // 注册 SQL Explain 命令
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.sql.explain",
      async (uri: string, range: vscode.Range) => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        await applyStoredSelectionForDocument(document);
        const sql = document.getText(range).trim();
        if (sql) {
          // 检查是否选择了数据库
          const currentConnection = databaseManager.getCurrentConnection();
          const currentDatabase = databaseManager.getCurrentDatabase();

          if (!currentConnection || !currentDatabase) {
            // 如果没有选择数据库，提示用户选择
            const choice = await vscode.window.showWarningMessage(
              '没有选择数据库连接，请先选择数据库连接',
              { modal: true },
              '选择数据库', '取消'
            );

            if (choice === '选择数据库') {
              await databaseManager.selectDatabase();
              
              // 再次检查是否选择了数据库
              const newConnection = databaseManager.getCurrentConnection();
              const newDatabase = databaseManager.getCurrentDatabase();
              
              if (!newConnection || !newDatabase) {
                vscode.window.showErrorMessage('未选择数据库连接，无法执行SQL');
                return;
              }
            } else {
              return; // 用户取消执行
            }
          }

          await sqlExecutor.explainSql(sql, document);
          await persistSelectionForDocument(document);
          // 刷新 CodeLens
          sqlCodeLensProvider.refresh();
        }
      }
    )
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}
