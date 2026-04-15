import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { DataSourceProvider } from "../database_provider";
import { DatabaseManager } from "./database_manager";
import { createWebview } from "../webview_helper";
import { driverSupportsSqlExecution } from "../drivers/registry";
import {
  Datasource,
  type DatasourceInputData,
} from "../entity/datasource";
import { runAgent, type AgentRunConfig, type AgentStreamCallbacks } from "./ai_agent";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface StoredChatMessage {
  role: "user" | "assistant";
  content: string;
  html?: string;
}

interface StoredSession {
  id: string;
  title: string;
  dbId?: string;
  history: StoredChatMessage[];
}

interface TagItem {
  id: string;
  name: string;
}

const AI_SESSIONS_KEY = "cadb.aiChat.sessions.v1";
const AI_CURRENT_SESSION_KEY = "cadb.aiChat.currentSessionId.v1";
const AI_SESSIONS_MAX = 80;

export class AiChatProvider {
  private panel?: vscode.WebviewPanel;
  private provider?: DataSourceProvider;
  private context?: vscode.ExtensionContext;
  private databaseManager?: DatabaseManager;
  private treeChangeDisposable?: vscode.Disposable;
  private treeRefreshTimer?: ReturnType<typeof setTimeout>;

  public open(
    provider: DataSourceProvider,
    context: vscode.ExtensionContext,
    databaseManager: DatabaseManager,
  ): void {
    this.provider = provider;
    this.context = context;
    this.databaseManager = databaseManager;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      void this._sendInit();
      return;
    }

    this.panel = createWebview(provider, "aiChat", "AI 数据库助手");

    this.treeChangeDisposable?.dispose();
    if (provider.onDidChangeTreeData) {
      this.treeChangeDisposable = provider.onDidChangeTreeData(() => {
        this._scheduleTreeRefresh();
      });
    }

    this.panel.onDidDispose(() => {
      if (this.treeRefreshTimer !== undefined) {
        clearTimeout(this.treeRefreshTimer);
        this.treeRefreshTimer = undefined;
      }
      this.treeChangeDisposable?.dispose();
      this.treeChangeDisposable = undefined;
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((msg) =>
      this._handleMessage(msg),
    );
  }

  private async _handleMessage(msg: {
    command: string;
    [key: string]: unknown;
  }): Promise<void> {
    switch (msg.command) {
      case "ready":
        await this._sendInit();
        break;

      case "send":
        await this._handleSend(
          msg.text as string,
          msg.dbId as string,
          msg.history as ChatMessage[],
        );
        break;

      case "saveConfig":
        await this._saveConfig(msg as {
          command: string;
          apiKey: string;
          baseUrl: string;
          model: string;
        });
        break;

      case "persistSessions":
        await this._persistSessions(
          msg as {
            command: string;
            sessions: StoredSession[];
            currentSessionId: string;
          },
        );
        break;

      case "requestTables":
        await this._handleRequestTables(msg.dbId as string);
        break;
    }
  }

  // ─── init / refresh ────────────────────────────────────────

  private async _sendInit(): Promise<void> {
    const config = vscode.workspace.getConfiguration("cadb.ai");
    const { sessions, currentId } = this._readSessions();
    this.panel?.webview.postMessage({
      type: "init",
      config: {
        apiKey: config.get<string>("apiKey", ""),
        baseUrl: config.get<string>("baseUrl", "https://api.openai.com/v1"),
        model: config.get<string>("model", "gpt-4o"),
      },
      dbOptions: this._collectDatabaseOptions(),
      sessions,
      currentSessionId: currentId,
    });
  }

  private _sendRefresh(): void {
    if (!this.panel) return;
    this.panel.webview.postMessage({
      type: "refresh",
      dbOptions: this._collectDatabaseOptions(),
    });
  }

  private _scheduleTreeRefresh(): void {
    if (!this.panel) return;
    if (this.treeRefreshTimer !== undefined) {
      clearTimeout(this.treeRefreshTimer);
    }
    this.treeRefreshTimer = setTimeout(() => {
      this.treeRefreshTimer = undefined;
      this._sendRefresh();
    }, 350);
  }

  // ─── 数据库选项（同步遍历已加载树节点） ────────────────────

  private _collectDatabaseOptions(): TagItem[] {
    if (!this.provider) return [];
    const options: TagItem[] = [];
    for (const group of this.provider.getRootNodes()) {
      if (group.type !== "group") continue;
      for (const conn of group.children || []) {
        if (conn.type !== "datasource" || !conn.connectionOpen) continue;
        if (!driverSupportsSqlExecution(conn.data.dbType)) continue;
        const connName = conn.label?.toString() || "";
        if (!connName) continue;
        for (const child of conn.children || []) {
          if (child.type !== "datasourceType") continue;
          for (const db of child.children || []) {
            if (db.type !== "collection") continue;
            const dbName = db.label?.toString() || "";
            if (dbName) {
              options.push({
                id: connName + "/" + dbName,
                name: connName + " / " + dbName,
              });
            }
          }
        }
      }
    }
    return options;
  }

  // ─── requestTables: 返回指定库的表名列表 ──────────────────

  private async _handleRequestTables(dbId: string): Promise<void> {
    if (!this.provider || !this.context) return;
    const idx = dbId.indexOf("/");
    if (idx < 1) return;
    const connName = dbId.slice(0, idx);
    const dbName = dbId.slice(idx + 1);

    let tags = this._getTablesFromTree(connName, dbName);
    if (tags.length === 0) {
      tags = await this._expandTablesForDatabase(connName, dbName);
    }
    this.panel?.webview.postMessage({
      type: "updateTableTags",
      tableTags: tags,
    });
  }

  private _getTablesFromTree(connName: string, dbName: string): TagItem[] {
    if (!this.provider) return [];
    const tags: TagItem[] = [];
    for (const group of this.provider.getRootNodes()) {
      if (group.type !== "group") continue;
      for (const conn of group.children || []) {
        if (conn.type !== "datasource") continue;
        if ((conn.label?.toString() || "") !== connName) continue;
        for (const child of conn.children || []) {
          if (child.type !== "datasourceType") continue;
          for (const db of child.children || []) {
            if (db.type !== "collection") continue;
            if ((db.label?.toString() || "") !== dbName) continue;
            for (const dbChild of db.children || []) {
              if (dbChild.type !== "collectionType") continue;
              for (const table of dbChild.children || []) {
                if (table.type !== "document") continue;
                const name = table.label?.toString() || "";
                if (name) tags.push({ id: name, name });
              }
            }
            return tags;
          }
        }
      }
    }
    return tags;
  }

  private async _expandTablesForDatabase(
    connName: string,
    dbName: string,
  ): Promise<TagItem[]> {
    if (!this.provider || !this.context) return [];
    const raw = this.provider
      .getConnections()
      .find((c) => (c.name || "").trim() === connName);
    if (!raw || !driverSupportsSqlExecution(raw.dbType)) return [];

    try {
      const connNode = new Datasource(
        { ...raw, type: "datasource" } as DatasourceInputData,
      );
      if (!connNode.dataloader) return [];
      const top = await connNode.expand(this.context);
      const dbTypeNode = top.find((o) => o.type === "datasourceType");
      if (!dbTypeNode) return [];
      const databases = await dbTypeNode.expand(this.context);
      const dbNode = databases.find(
        (d) => d.type === "collection" && d.label?.toString() === dbName,
      );
      if (!dbNode) return [];
      const dbChildren = await dbNode.expand(this.context);
      const tableTypeNode = dbChildren.find((o) => o.type === "collectionType");
      if (!tableTypeNode) return [];
      const tables = await tableTypeNode.expand(this.context);
      return tables
        .filter((t) => t.type === "document" && t.label?.toString())
        .map((t) => ({ id: t.label!.toString(), name: t.label!.toString() }));
    } catch {
      return [];
    }
  }

  // ─── Agent 流式发送 ────────────────────────────────────────

  private async _handleSend(
    _text: string,
    dbId: string,
    history: ChatMessage[],
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration("cadb.ai");
    const apiKey = config.get<string>("apiKey", "");
    const baseUrl = config.get<string>("baseUrl", "https://api.openai.com/v1");
    const model = config.get<string>("model", "gpt-4o");

    if (!apiKey) {
      this.panel?.webview.postMessage({
        type: "stream-error",
        error: "请先在右上角设置中配置 API Key",
      });
      return;
    }

    const idx = dbId.indexOf("/");
    if (idx < 1) {
      this.panel?.webview.postMessage({
        type: "stream-error",
        error: "会话未绑定数据库，请新建会话并选择数据库",
      });
      return;
    }
    const connName = dbId.slice(0, idx);
    const dbName = dbId.slice(idx + 1);

    const connData = this.provider
      ?.getConnections()
      .find((ds) => ds.name === connName);
    if (!connData) {
      this.panel?.webview.postMessage({
        type: "stream-error",
        error: `找不到数据源: ${connName}`,
      });
      return;
    }

    let tableNames: string[] = [];
    try {
      const tags = this._getTablesFromTree(connName, dbName);
      if (tags.length > 0) {
        tableNames = tags.map((t) => t.name);
      } else {
        const expanded = await this._expandTablesForDatabase(connName, dbName);
        tableNames = expanded.map((t) => t.name);
      }
    } catch {
      // 忽略
    }

    const agentConfig: AgentRunConfig = {
      apiKey,
      baseUrl,
      model,
      connData: connData as DatasourceInputData,
      connName,
      databaseName: dbName,
      tableNames,
    };

    this.panel?.webview.postMessage({ type: "stream-start" });

    const callbacks: AgentStreamCallbacks = {
      onToken: (token) => {
        this.panel?.webview.postMessage({ type: "stream-chunk", text: token });
      },
      onToolStart: (toolName, input) => {
        this.panel?.webview.postMessage({ type: "tool-start", toolName, input });
      },
      onToolEnd: (toolName, output) => {
        this.panel?.webview.postMessage({ type: "tool-end", toolName, output });
      },
      onError: (err) => {
        this.panel?.webview.postMessage({ type: "stream-error", error: err });
      },
      onEnd: () => {
        this.panel?.webview.postMessage({ type: "stream-end" });
      },
    };

    await runAgent(agentConfig, history, callbacks);
  }

  // ─── 会话持久化 ──────────────────────────────────────────

  private _readSessions(): { sessions: StoredSession[]; currentId: string } {
    const ctx = this.context!;
    const raw = ctx.globalState.get<unknown>(AI_SESSIONS_KEY);
    let sessions: StoredSession[] = [];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        const id = typeof o.id === "string" ? o.id : "";
        const title = typeof o.title === "string" ? o.title : "会话";
        const dbId = typeof o.dbId === "string" ? o.dbId : "";
        const histRaw = o.history;
        const history: StoredChatMessage[] = [];
        if (Array.isArray(histRaw)) {
          for (const m of histRaw) {
            if (!m || typeof m !== "object") continue;
            const msg = m as Record<string, unknown>;
            const role =
              msg.role === "user" || msg.role === "assistant" ? msg.role : null;
            const content = typeof msg.content === "string" ? msg.content : "";
            const html = typeof msg.html === "string" ? msg.html : undefined;
            if (role) history.push({ role, content, html });
          }
        }
        if (id) sessions.push({ id, title, dbId, history });
      }
    }
    let currentId = ctx.globalState.get<string>(AI_CURRENT_SESSION_KEY) || "";
    if (sessions.length === 0) {
      const id = randomUUID();
      sessions = [{ id, title: "新会话", dbId: "", history: [] }];
      currentId = id;
    } else if (!currentId || !sessions.some((s) => s.id === currentId)) {
      currentId = sessions[0].id;
    }
    return { sessions, currentId };
  }

  private async _persistSessions(msg: {
    sessions: StoredSession[];
    currentSessionId: string;
  }): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    const list = Array.isArray(msg.sessions) ? msg.sessions : [];
    if (list.length === 0) return;
    const trimmed = list.slice(0, AI_SESSIONS_MAX).map((s) => ({
      id: String(s.id || "").trim() || randomUUID(),
      title: String(s.title || "会话").slice(0, 200),
      dbId: String(s.dbId || ""),
      history: (Array.isArray(s.history) ? s.history : [])
        .filter(
          (m): m is StoredChatMessage =>
            !!m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string",
        )
        .map((m) => ({
          role: m.role,
          content: m.content.slice(0, 200_000),
          ...(m.html ? { html: m.html.slice(0, 200_000) } : {}),
        })),
    }));
    let currentId = String(msg.currentSessionId || "").trim();
    if (!trimmed.some((s) => s.id === currentId)) currentId = trimmed[0].id;
    await ctx.globalState.update(AI_SESSIONS_KEY, trimmed);
    await ctx.globalState.update(AI_CURRENT_SESSION_KEY, currentId);
  }

  private async _saveConfig(msg: {
    apiKey: string;
    baseUrl: string;
    model: string;
    command: string;
  }): Promise<void> {
    const config = vscode.workspace.getConfiguration("cadb.ai");
    const target = vscode.ConfigurationTarget.Global;
    if (msg.apiKey !== undefined) await config.update("apiKey", msg.apiKey, target);
    if (msg.baseUrl !== undefined) await config.update("baseUrl", msg.baseUrl, target);
    if (msg.model !== undefined) await config.update("model", msg.model, target);
    vscode.window.showInformationMessage("AI 配置已保存");
  }

  public dispose(): void {
    if (this.treeRefreshTimer !== undefined) {
      clearTimeout(this.treeRefreshTimer);
      this.treeRefreshTimer = undefined;
    }
    this.treeChangeDisposable?.dispose();
    this.treeChangeDisposable = undefined;
    this.panel?.dispose();
  }
}
