import path from "path";
import { readFileSync } from "fs";
import * as vscode from "vscode";
import { Datasource, DatasourceInputData } from "./entity/datasource";
import type { DatabaseManager } from "./component/database_manager";
import {
  DEFAULT_CONNECTION_GROUP,
  getOrderedConnectionGroups,
  normalizeConnectionGroupLabel,
} from "./connection_groups";

/**
 * 树状态接口（仅持久化展开状态与用户过滤选项，不缓存树数据）
 */
interface TreeState {
  expandedNodes: string[]; // 存储已展开节点的路径
  selectedDatabases?: Record<string, string[]>; // 存储每个连接选择显示的数据库
  selectedTables?: Record<string, string[]>; // 存储每个数据库选择显示的表，key格式为 "connectionName:databaseName"
}

export class DataSourceProvider implements vscode.TreeDataProvider<Datasource> {
  public context: vscode.ExtensionContext;
  public panels: Record<string, string>;
  public databaseManager?: DatabaseManager;
  private treeState: TreeState;
  private rootNodes: Datasource[] = [];
  private workspaceConnections: DatasourceInputData[] = [];
  private refreshQueue: Promise<void> = Promise.resolve();

  public getRootNodes(): Datasource[] {
    return this.rootNodes;
  }

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.panels = {
      settings: readFileSync(
        path.join(
          this.context.extensionPath,
          "resources",
          "panels",
          "settings.html"
        ),
        "utf-8"
      ),
      datasourceTable: readFileSync(
        path.join(
          this.context.extensionPath,
          "resources",
          "panels",
          "grid.html"
        ),
        "utf-8"
      ),
			tableEdit: readFileSync(
        path.join(
          this.context.extensionPath,
          "resources",
          "panels",
          "edit.html"
        ),
        "utf-8"
      ),
      items: readFileSync(
        path.join(
          this.context.extensionPath,
          "resources",
          "panels",
          "items.html"
        ),
        "utf-8"
      ),
      redisPubsub: readFileSync(
        path.join(
          this.context.extensionPath,
          "resources",
          "panels",
          "redis-pubsub.html"
        ),
        "utf-8"
      ),
    };

    // 加载树状态
    this.treeState = this.loadTreeState();
    
    // 初始化数据
    this.initialize();
  }

  /** 供扩展恢复展开状态等使用，只读 */
  public getTreeState(): TreeState {
    return this.treeState;
  }

  public getConnections(): DatasourceInputData[] {
    const userConnections =
      this.context.globalState.get<DatasourceInputData[]>("cadb.connections", []) ||
      [];
    const workspaceConnections = this.workspaceConnections || [];

    const userByName = new Map<string, DatasourceInputData>();
    for (const c of userConnections) {
      if (c && typeof c.name === "string") {
        userByName.set(c.name, { ...c, saveLocation: c.saveLocation ?? "user" });
      }
    }

    const merged: DatasourceInputData[] = [];
    for (const c of workspaceConnections) {
      if (!c || typeof c.name !== "string") continue;
      merged.push({ ...c, saveLocation: "workspace" });
      userByName.delete(c.name);
    }
    for (const c of userByName.values()) {
      merged.push(c);
    }

    return merged;
  }

  public getUserConnections(): DatasourceInputData[] {
    return (
      this.context.globalState.get<DatasourceInputData[]>("cadb.connections", []) ||
      []
    );
  }

  public getWorkspaceConnections(): DatasourceInputData[] {
    return this.workspaceConnections || [];
  }

  public async addConnection(payload: DatasourceInputData): Promise<void> {
    const saveLocation =
      payload.saveLocation === "workspace" ? "workspace" : "user";
    const normalized: DatasourceInputData = { ...payload, saveLocation };

    if (saveLocation === "workspace") {
      if (!this.getWorkspaceConnectionsFileUri()) {
        const existing = this.getUserConnections();
        existing.push({ ...normalized, saveLocation: "user" });
        await this.context.globalState.update("cadb.connections", existing);
        return;
      }
      const existing = this.getWorkspaceConnections();
      this.workspaceConnections = [...existing, normalized];
      await this.persistWorkspaceConnections(this.workspaceConnections);
      return;
    }

    const existing = this.getUserConnections();
    existing.push(normalized);
    await this.context.globalState.update("cadb.connections", existing);
  }

  /**
   * 更新连接配置。若表单中修改了「保存位置」，会将该数据源从当前存储移除并写入目标存储
   * （用户 ↔ 工作区），树状态（过滤显示的库/表、展开路径）会保留（仍按连接名关联）。
   */
  public async updateConnectionByName(
    originalName: string,
    payload: DatasourceInputData
  ): Promise<void> {
    const wantWorkspace = payload.saveLocation === "workspace";
    const idxWorkspace = this.workspaceConnections.findIndex(
      (c) => c.name === originalName
    );
    const inWorkspace = idxWorkspace !== -1;

    const userConnections = this.getUserConnections();
    const idxUser = userConnections.findIndex((c) => c.name === originalName);
    const inUser = idxUser !== -1;

    if (!inWorkspace && !inUser) {
      throw new Error("未找到要更新的连接配置");
    }

    const nameChanged = (payload.name || originalName) !== originalName;
    const finalName = (payload.name || originalName).trim() || originalName;
    const moveToWorkspace = wantWorkspace && !inWorkspace;
    const moveToUser = !wantWorkspace && inWorkspace;

    if (moveToWorkspace || moveToUser) {
      // 从当前存储移除
      if (inWorkspace) {
        this.workspaceConnections = this.workspaceConnections.filter(
          (c) => c.name !== originalName
        );
        await this.persistWorkspaceConnections(this.workspaceConnections);
      } else {
        const nextUser = userConnections.filter((c) => c.name !== originalName);
        await this.context.globalState.update("cadb.connections", nextUser);
      }
      // 写入目标存储
      const normalized: DatasourceInputData = {
        ...payload,
        name: finalName,
        type: "datasource",
        saveLocation: wantWorkspace ? "workspace" : "user",
      };
      if (wantWorkspace) {
        if (!this.getWorkspaceConnectionsFileUri()) {
          const existing = this.getUserConnections();
          existing.push({ ...normalized, saveLocation: "user" });
          await this.context.globalState.update("cadb.connections", existing);
        } else {
          const existing = this.getWorkspaceConnections();
          this.workspaceConnections = [...existing, normalized];
          await this.persistWorkspaceConnections(this.workspaceConnections);
        }
      } else {
        const existing = this.getUserConnections();
        existing.push(normalized);
        await this.context.globalState.update("cadb.connections", existing);
      }
      if (nameChanged) {
        this.renameConnection(originalName, finalName);
      }
      return;
    }

    // 未更换保存位置：原地更新
    if (inWorkspace) {
      this.workspaceConnections[idxWorkspace] = {
        ...payload,
        name: finalName,
        type: "datasource",
        saveLocation: "workspace",
      };
      await this.persistWorkspaceConnections(this.workspaceConnections);
    } else {
      userConnections[idxUser] = {
        ...payload,
        name: finalName,
        type: "datasource",
        saveLocation: "user",
      };
      await this.context.globalState.update("cadb.connections", userConnections);
    }
    if (nameChanged) {
      this.renameConnection(originalName, finalName);
    }
  }

  /**
   * 从「管理连接分组」列表中移除的分组：其下连接全部改为「默认」分组
   */
  public async migrateConnectionsToDefaultForGroups(
    removedGroups: Set<string>
  ): Promise<void> {
    if (removedGroups.size === 0) {
      return;
    }
    const target = DEFAULT_CONNECTION_GROUP;
    const shouldMigrate = (g: unknown): boolean =>
      removedGroups.has(normalizeConnectionGroupLabel(g));

    let wsChanged = false;
    const ws = [...this.workspaceConnections];
    for (let i = 0; i < ws.length; i++) {
      if (shouldMigrate(ws[i].group)) {
        ws[i] = { ...ws[i], group: target };
        wsChanged = true;
      }
    }
    if (wsChanged) {
      this.workspaceConnections = ws;
      await this.persistWorkspaceConnections(this.workspaceConnections);
    }

    const user = this.getUserConnections();
    let userChanged = false;
    const nextUser = user.map((c) => {
      if (shouldMigrate(c.group)) {
        userChanged = true;
        return { ...c, group: target };
      }
      return c;
    });
    if (userChanged) {
      await this.context.globalState.update("cadb.connections", nextUser);
    }
  }

  public async renameConnectionRecord(
    oldName: string,
    newName: string
  ): Promise<void> {
    const idxWorkspace = this.workspaceConnections.findIndex(
      (c) => c.name === oldName
    );
    if (idxWorkspace !== -1) {
      this.workspaceConnections[idxWorkspace] = {
        ...this.workspaceConnections[idxWorkspace],
        name: newName,
        saveLocation: "workspace",
      };
      await this.persistWorkspaceConnections(this.workspaceConnections);
      return;
    }

    const userConnections = this.getUserConnections();
    const idxUser = userConnections.findIndex((c) => c.name === oldName);
    if (idxUser === -1) {
      throw new Error("未找到要重命名的连接");
    }
    userConnections[idxUser] = {
      ...userConnections[idxUser],
      name: newName,
      saveLocation: "user",
    };
    await this.context.globalState.update("cadb.connections", userConnections);
  }

  public async deleteConnectionRecord(name: string): Promise<void> {
    const idxWorkspace = this.workspaceConnections.findIndex((c) => c.name === name);
    if (idxWorkspace !== -1) {
      this.workspaceConnections = this.workspaceConnections.filter((c) => c.name !== name);
      await this.persistWorkspaceConnections(this.workspaceConnections);
      return;
    }

    const userConnections = this.getUserConnections();
    const idxUser = userConnections.findIndex((c) => c.name === name);
    if (idxUser === -1) {
      throw new Error("未找到要删除的连接");
    }
    const next = userConnections.filter((c) => c.name !== name);
    await this.context.globalState.update("cadb.connections", next);
  }

  private async initialize() {
    try {
      this.workspaceConnections = await this.loadWorkspaceConnections();
      this.rootNodes = this.buildRootGroupNodes();
      this.rebuildConnectionChildrenUnderGroups();
      this._onDidChangeTreeData.fire();
      // 每次加载都拉取最新数据，过滤显示仍按 treeState 中的 selectedDatabases/selectedTables 应用
      await this.enqueueRefreshAndCache();
    } catch (error) {
      console.error("初始化数据源树失败:", error);
      this.rootNodes = this.buildRootGroupNodes();
      this.rebuildConnectionChildrenUnderGroups();
      this._onDidChangeTreeData.fire();
    }
  }

  private normalizeGroupName(name: any): string {
    return normalizeConnectionGroupLabel(name);
  }

  /** 根节点：用户自定义顺序 + 连接中出现的分组（见 connection_groups） */
  private buildRootGroupNodes(): Datasource[] {
    const labels = getOrderedConnectionGroups(this.context, this.getConnections());
    return labels.map(
      (label) =>
        new Datasource({
          type: "group",
          name: label,
          tooltip: "",
          group: label,
          extra: "",
        })
    );
  }

  /** 按连接的 group 字段将连接挂到对应分组节点下 */
  public rebuildConnectionChildrenUnderGroups(): void {
    const all = this.getConnections();
    for (const g of this.rootNodes) {
      if (g.type !== "group") {
        continue;
      }
      const groupName = this.normalizeGroupName(g.data.group ?? g.label?.toString() ?? "");
      const conns = all.filter(
        (c) => this.normalizeGroupName((c as { group?: string }).group) === groupName
      );
      g.children = conns.map((c) => new Datasource(c, undefined, g));
      const n = conns.length;
      g.description = n > 0 ? String(n) : "";
      g.data.extra = g.description;
    }
  }

  private getWorkspaceRootUri(): vscode.Uri | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }
    return folders[0].uri;
  }

  private getWorkspaceCadbDirUri(): vscode.Uri | null {
    const root = this.getWorkspaceRootUri();
    if (!root) return null;
    return vscode.Uri.joinPath(root, ".cadb");
  }

  private getWorkspaceConnectionsFileUri(): vscode.Uri | null {
    const dir = this.getWorkspaceCadbDirUri();
    if (!dir) return null;
    return vscode.Uri.joinPath(dir, "connections.json");
  }

  /**
   * 获取某连接下 JSQL/查询文件的根目录，随该连接的保存位置变化：
   * - 若连接保存在工作区：返回工作区 .cadb/<连接名>
   * - 若保存在用户或无法使用工作区：返回 globalStorageUri/<连接名>
   */
  public getConnectionFilesDirUri(connectionName: string): vscode.Uri {
    const connections = this.getConnections();
    const conn = connections.find(
      (c) => (c.name || "").trim() === (connectionName || "").trim()
    );
    const useWorkspace =
      conn?.saveLocation === "workspace" && this.getWorkspaceCadbDirUri();
    if (useWorkspace) {
      const cadbDir = this.getWorkspaceCadbDirUri()!;
      return vscode.Uri.joinPath(cadbDir, connectionName.trim());
    }
    return vscode.Uri.joinPath(
      this.context.globalStorageUri,
      connectionName.trim()
    );
  }

  private async loadWorkspaceConnections(): Promise<DatasourceInputData[]> {
    const fileUri = this.getWorkspaceConnectionsFileUri();
    if (!fileUri) return [];
    try {
      const raw = await vscode.workspace.fs.readFile(fileUri);
      const json = new TextDecoder("utf-8").decode(raw);
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return [];
      return parsed as DatasourceInputData[];
    } catch {
      // 读取异常（时序/文件系统瞬时错误）时保留当前内存数据，避免树被误清空
      return this.workspaceConnections || [];
    }
  }

  private enqueueRefreshAndCache(): Promise<void> {
    this.refreshQueue = this.refreshQueue
      .then(() => this.refreshAndCache())
      .catch((error) => {
        console.error("数据源刷新队列执行失败:", error);
      });
    return this.refreshQueue;
  }

  private async persistWorkspaceConnections(
    connections: DatasourceInputData[]
  ): Promise<void> {
    const dir = this.getWorkspaceCadbDirUri();
    const fileUri = this.getWorkspaceConnectionsFileUri();
    if (!dir || !fileUri) {
      return;
    }
    await vscode.workspace.fs.createDirectory(dir);
    const content = JSON.stringify(connections, null, 2);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, "utf-8"));
  }

  /**
   * 快速展开节点（只加载到表级别，不加载字段）
   * @param node 要展开的节点
   * @param maxDepth 最大递归深度，默认2（连接->数据库->表）
   */
  private async expandRecursiveFast(node: Datasource, maxDepth: number = 2, currentDepth: number = 0): Promise<void> {
    if (currentDepth >= maxDepth) {
      return;
    }

    try {
      const children = await node.expand(this.context);
      node.children = children || [];
      
      // 保存总个数（过滤前）
      const totalCount = node.children.length;
      
      // 如果是 datasourceType (Databases)，可能需要过滤
      if (node.type === 'datasourceType' && node.parent) {
         const connectionName = node.parent.label?.toString();
         if (connectionName && this.treeState.selectedDatabases?.[connectionName]) {
            const selectedDbs = this.treeState.selectedDatabases[connectionName];
            if (selectedDbs.length > 0) {
              node.children = node.children.filter(child => 
                selectedDbs.includes(child.label?.toString() || '')
              );
            }
         }
      }

      // 如果是 collectionType 节点，根据选择过滤表
      if (node.type === 'collectionType' && node.parent) {
        const databaseName = node.parent.label?.toString();
        // 向上查找连接节点
        let connectionNode: Datasource | undefined = node.parent;
        while (connectionNode && connectionNode.type !== 'datasource') {
          connectionNode = connectionNode.parent;
        }
        const connectionName = connectionNode?.label?.toString();
        
        if (connectionName && databaseName) {
          const key = `${connectionName}:${databaseName}`;
          if (this.treeState.selectedTables?.[key]) {
            const selectedTables = this.treeState.selectedTables[key];
            if (selectedTables.length > 0) {
              node.children = node.children.filter(child => 
                selectedTables.includes(child.label?.toString() || '')
              );
            }
          }
        }
      }

      // 更新 datasourceType 和 collectionType 节点的 extra 属性为 x/N 格式
      if (node.type === 'datasourceType' || node.type === 'collectionType') {
        const displayedCount = node.children.length;
        const extraText = `${displayedCount}/${totalCount}`;
        node.data.extra = extraText;
        node.description = extraText;
      }

      // 并行处理子节点，提高性能
      const childPromises = node.children.map(async (child) => {
        // 只展开容器类型，不加载字段（字段按需加载）
        if (['datasourceType', 'collectionType', 'folder', 'collection'].includes(child.type)) {
          await this.expandRecursiveFast(child, maxDepth, currentDepth + 1);
        }
        // document（表）节点不在这里加载字段，字段会在用户展开时按需加载
      });

      await Promise.all(childPromises);
    } catch (e) {
      console.error(`展开节点 ${node.label} 失败:`, e);
    }
  }

  /**
   * 完整展开节点（包含所有层级，包括字段）
   * @param node 要展开的节点
   */
  private async expandRecursive(node: Datasource): Promise<void> {
    try {
      const children = await node.expand(this.context);
      node.children = children || [];
      
      // 保存总个数（过滤前）
      const totalCount = node.children.length;
      
      // 如果是 datasourceType (Databases)，可能需要过滤
      if (node.type === 'datasourceType' && node.parent) {
         const connectionName = node.parent.label?.toString();
         if (connectionName && this.treeState.selectedDatabases?.[connectionName]) {
            const selectedDbs = this.treeState.selectedDatabases[connectionName];
            if (selectedDbs.length > 0) {
              node.children = node.children.filter(child => 
                selectedDbs.includes(child.label?.toString() || '')
              );
            }
         }
      }

      // 如果是 collectionType 节点，根据选择过滤表
      if (node.type === 'collectionType' && node.parent) {
        const databaseName = node.parent.label?.toString();
        // 向上查找连接节点
        let connectionNode: Datasource | undefined = node.parent;
        while (connectionNode && connectionNode.type !== 'datasource') {
          connectionNode = connectionNode.parent;
        }
        const connectionName = connectionNode?.label?.toString();
        
        if (connectionName && databaseName) {
          const key = `${connectionName}:${databaseName}`;
          if (this.treeState.selectedTables?.[key]) {
            const selectedTables = this.treeState.selectedTables[key];
            if (selectedTables.length > 0) {
              node.children = node.children.filter(child => 
                selectedTables.includes(child.label?.toString() || '')
              );
            }
          }
        }
      }

      // 更新 datasourceType 和 collectionType 节点的 extra 属性为 x/N 格式
      if (node.type === 'datasourceType' || node.type === 'collectionType') {
        const displayedCount = node.children.length;
        const extraText = `${displayedCount}/${totalCount}`;
        node.data.extra = extraText;
        node.description = extraText;
      }

      for (const child of node.children) {
        // 递归展开
        // 防止无限递归：只展开特定的容器类型
        if (['datasourceType', 'collectionType', 'folder', 'collection'].includes(child.type)) {
           await this.expandRecursive(child);
        } else if (child.type === 'document') { // 表 -> 字段
           await this.loadDocumentChildren(child);
           // 表的子节点（字段）不需要再展开了
        }
      }
    } catch (e) {
      console.error(`展开节点 ${node.label} 失败:`, e);
    }
  }

  /**
   * 从服务器拉取最新树数据并刷新视图，不写本地缓存。
   * 仍根据 treeState 中的 selectedDatabases/selectedTables 过滤显示。
   */
  public async refreshAndCache() {
    try {
      // 工作区连接文件可能在激活早期尚不可读；每次刷新前重读一次，避免出现空白树
      this.workspaceConnections = await this.loadWorkspaceConnections();
      // 每次同步须重建分组根：连接中的 group 与 globalState 中的分组顺序会变；
      // 若沿用旧 rootNodes，仅 rebuildConnectionChildrenUnderGroups 无法出现新分组名。
      this.rootNodes = this.buildRootGroupNodes();
      this.rebuildConnectionChildrenUnderGroups();
      this._onDidChangeTreeData.fire();

      const connectionRoots = this.rootNodes.flatMap((g) =>
        g.type === "group" ? g.children || [] : []
      );

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "正在同步数据库结构...",
          cancellable: false,
        },
        async (progress) => {
          const total = Math.max(1, connectionRoots.length);
          const nodePromises = connectionRoots.map(async (node, index) => {
            try {
              progress.report({
                message: `正在加载 ${node.label} (${index + 1}/${total})`,
                increment: 100 / total,
              });
              await this.expandRecursiveFast(node, 2);
            } catch (error) {
              console.error(`加载连接 ${node.label} 失败:`, error);
            }
          });

          await Promise.all(nodePromises);
          this._onDidChangeTreeData.fire();
        }
      );
    } catch (error) {
      console.error("刷新数据源树失败:", error);
      this._onDidChangeTreeData.fire();
    }
  }

  private _onDidChangeTreeData: vscode.EventEmitter<
    Datasource | undefined | null | void
  > = new vscode.EventEmitter<Datasource | undefined | null | void>();

  readonly onDidChangeTreeData:
    | vscode.Event<void | Datasource | Datasource[] | null | undefined>
    | undefined = this._onDidChangeTreeData.event;

  getTreeItem(
    element: Datasource
  ): vscode.TreeItem | Thenable<vscode.TreeItem> {
    // Keep getTreeItem synchronous — child loading is handled in getChildren
    // 确保 description 从 data.extra 同步（优先使用 data.extra）
    if (element.data && element.data.extra) {
      element.description = element.data.extra;
    }
    return element;
  }
  
  getChildren(
    element?: Datasource | undefined
  ): vscode.ProviderResult<Datasource[]> {
    if (element) {
      // If children already loaded, return them
      if (element.children && element.children.length) {
        // 如果是 datasourceType 或 collectionType，确保计数显示正确
        if (element.type === 'datasourceType' || element.type === 'collectionType') {
          const currentCount = element.children.length;
          // 尝试从 extra 中解析总数，如果无法解析则使用当前数量
          let totalCount = currentCount;
          if (element.data.extra) {
            const match = element.data.extra.match(/(\d+)\/(\d+)/);
            if (match) {
              totalCount = parseInt(match[2], 10);
            } else {
              // 如果 extra 不是 x/N 格式，说明还没有设置过，使用当前数量
              totalCount = currentCount;
            }
          }
          // 如果 datasourceType 被过滤了，当前显示数量可能小于总数
          // 但总数应该保持不变（从 extra 中获取）
          const extraText = `${currentCount}/${totalCount}`;
          element.data.extra = extraText;
          element.description = extraText;
        }
        // 确保子节点的描述已从 data.extra 同步
        for (const child of element.children) {
          if (child.data && child.data.extra && !child.description) {
            child.description = child.data.extra;
          }
        }
        return element.children;
      }

      // Otherwise load children asynchronously. Return a Promise so VS Code shows a loading indicator
      return element.expand(this.context).then(async (children) => {
        element.children = children || [];
        
        // 保存总个数（过滤前）
        const totalCount = element.children.length;
        
        // 如果是 datasourceType 节点，根据选择过滤数据库
        if (element.type === 'datasourceType' && element.parent) {
          const connectionName = element.parent.label?.toString();
          if (connectionName && this.treeState.selectedDatabases?.[connectionName]) {
            const selectedDbs = this.treeState.selectedDatabases[connectionName];
            if (selectedDbs.length > 0) {
              // 过滤只显示选中的数据库
              element.children = element.children.filter(child => 
                selectedDbs.includes(child.label?.toString() || '')
              );
            }
          }
        }
        
        // 如果是 collectionType 节点，根据选择过滤表
        if (element.type === 'collectionType' && element.parent) {
          const databaseName = element.parent.label?.toString();
          // 向上查找连接节点
          let connectionNode: Datasource | undefined = element.parent;
          while (connectionNode && connectionNode.type !== 'datasource') {
            connectionNode = connectionNode.parent;
          }
          const connectionName = connectionNode?.label?.toString();
          
          if (connectionName && databaseName) {
            const key = `${connectionName}:${databaseName}`;
            if (this.treeState.selectedTables?.[key]) {
              const selectedTables = this.treeState.selectedTables[key];
              if (selectedTables.length > 0) {
                // 过滤只显示选中的表
                element.children = element.children.filter(child => 
                  selectedTables.includes(child.label?.toString() || '')
                );
              }
            }
          }
        }
        
        // 更新 datasourceType 和 collectionType 节点的 extra 属性为 x/N 格式
        if (element.type === 'datasourceType' || element.type === 'collectionType') {
          const displayedCount = element.children.length;
          const extraText = `${displayedCount}/${totalCount}`;
          element.data.extra = extraText;
          element.description = extraText;
        }
        
        // 如果是表节点（document），加载字段并更新描述
        if (element.type === 'document') {
          await this.loadDocumentChildren(element);
        }
        
        // 确保所有子节点的描述已从 data.extra 同步
        for (const child of element.children) {
          if (child.data && child.data.extra) {
            child.description = child.data.extra;
          }
        }
        
        // Set collapsible state depending on whether children exist
        element.collapsibleState =
          element.children && element.children.length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        // Fire change for the parent so UI updates if needed
        this._onDidChangeTreeData.fire(element);
        return element.children;
      });
    }
    // Root items
    if (this.rootNodes.length === 0) {
      // 自愈：若初始为空，后台再触发一次刷新（常见于启动时序问题）
      void this.refreshAndCache();
    }
    return this.rootNodes;
  }
  
  getParent?(element: Datasource): vscode.ProviderResult<Datasource> {
    return element.parent;
  }
  
  resolveTreeItem?(
    item: vscode.TreeItem,
    element: Datasource,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.TreeItem> {
    return null;
  }

  public refresh = (item?: Datasource): void => {
    if (item) {
      item.children = [];
      this._onDidChangeTreeData.fire(item);
    } else {
      void this.enqueueRefreshAndCache();
    }
    // 刷新后保存树状态
    this.saveTreeState();
  };

  public createChildren = (
    parent: Datasource,
    children: Datasource[]
  ): void => {
    parent.children.push(...children);
    this._onDidChangeTreeData.fire(parent);
    // 创建子节点后保存树状态
    this.saveTreeState();
  };

  public setDatabaseManager(databaseManager: DatabaseManager): void {
    this.databaseManager = databaseManager;
  }

  /**
   * 加载树状态（仅展开状态与用户过滤选项，不包含树数据缓存）
   */
  private loadTreeState(): TreeState {
    const stored = this.context.globalState.get<TreeState>('cadb.treeState');
    if (!stored) {
      return { expandedNodes: [], selectedDatabases: {}, selectedTables: {} };
    }
    return {
      expandedNodes: stored.expandedNodes ?? [],
      selectedDatabases: stored.selectedDatabases ?? {},
      selectedTables: stored.selectedTables ?? {}
    };
  }

  /**
   * 保存树状态（仅持久化展开状态与过滤选项）
   */
  private saveTreeState(): void {
    this.context.globalState.update('cadb.treeState', {
      expandedNodes: this.treeState.expandedNodes,
      selectedDatabases: this.treeState.selectedDatabases,
      selectedTables: this.treeState.selectedTables
    });
  }

  /**
   * 获取节点的唯一路径标识符
   */
  public getNodePath(element: Datasource): string {
    const path: string[] = [];
    let current: Datasource | undefined = element;

    while (current) {
      const label = current.label?.toString() || '';
      const type = current.type || '';
      // 使用 type:label 作为路径段
      path.unshift(`${type}:${label}`);
      current = current.parent;
    }

    return path.join('/');
  }

  /**
   * 获取节点可读路径（用于搜索框展示），如：连接名 > 数据库名 > 表名
   */
  public getReadablePath(element: Datasource): string {
    const segments: string[] = [];
    let current: Datasource | undefined = element;
    while (current) {
      const label = current.label?.toString()?.trim();
      if (label) {
        segments.unshift(label);
      }
      current = current.parent;
    }
    return segments.join(' > ');
  }

  /**
   * 递归收集已加载的树节点（DFS），用于搜索
   */
  public getFlattenedNodes(): Datasource[] {
    const result: Datasource[] = [];
    const visit = (node: Datasource) => {
      result.push(node);
      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          visit(child);
        }
      }
    };
    for (const root of this.rootNodes) {
      visit(root);
    }
    return result;
  }

  /**
   * 检查节点是否应该展开
   */
  public shouldExpandNode(element: Datasource): boolean {
    const nodePath = this.getNodePath(element);
    return this.treeState.expandedNodes.includes(nodePath);
  }

  /**
   * 添加展开的节点
   */
  public addExpandedNode(element: Datasource): void {
    const nodePath = this.getNodePath(element);
    if (!this.treeState.expandedNodes.includes(nodePath)) {
      this.treeState.expandedNodes.push(nodePath);
      this.saveTreeState();
    }
  }

  /**
   * 移除展开的节点
   */
  public removeExpandedNode(element: Datasource): void {
    const nodePath = this.getNodePath(element);
    const index = this.treeState.expandedNodes.indexOf(nodePath);
    if (index !== -1) {
      this.treeState.expandedNodes.splice(index, 1);
      this.saveTreeState();
    }
  }

  /**
   * 设置连接的选中数据库
   */
  public setSelectedDatabases(connectionName: string, databases: string[]): void {
    if (!this.treeState.selectedDatabases) {
      this.treeState.selectedDatabases = {};
    }
    this.treeState.selectedDatabases[connectionName] = databases;
    this.saveTreeState();
  }

  /**
   * 获取连接的选中数据库
   */
  public getSelectedDatabases(connectionName: string): string[] {
    return this.treeState.selectedDatabases?.[connectionName] || [];
  }

  /**
   * 设置数据库的选中表
   */
  public setSelectedTables(connectionName: string, databaseName: string, tables: string[]): void {
    if (!this.treeState.selectedTables) {
      this.treeState.selectedTables = {};
    }
    const key = `${connectionName}:${databaseName}`;
    this.treeState.selectedTables[key] = tables;
    this.saveTreeState();
  }

  /**
   * 获取数据库的选中表
   */
  public getSelectedTables(connectionName: string, databaseName: string): string[] {
    const key = `${connectionName}:${databaseName}`;
    return this.treeState.selectedTables?.[key] || [];
  }

  /**
   * 递归加载数据源的所有子节点
   * @param datasource 数据源节点
   * @param progress 进度回调
   */
  public async loadAllChildren(
    datasource: Datasource,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    if (!datasource.dataloader) {
      return;
    }

    // 使用 expandRecursive 递归加载
    // 注意：expandRecursive 不支持 progress 回调，这里只能简单的报告开始
    progress?.report({ message: `正在加载 ${datasource.label} 的子节点...` });
    
    await this.expandRecursive(datasource);
    
    this._onDidChangeTreeData.fire(datasource);
  }

  /**
   * 加载数据库（collection）的所有子节点
   * @param collection 数据库节点
   */
  public async loadCollectionChildren(collection: Datasource): Promise<void> {
    // 加载数据库下的对象类型（表、用户）
    const objectTypes = await collection.expand(this.context);
    collection.children = objectTypes || [];
    this._onDidChangeTreeData.fire(collection);

    // 查找"表"类型节点
    const tableTypeNode = collection.children.find(child => child.type === 'collectionType');
    if (tableTypeNode) {
      // 加载所有表
      const tables = await tableTypeNode.expand(this.context);
      tableTypeNode.children = tables || [];
      
      // 保存总个数（过滤前）
      const totalCount = tableTypeNode.children.length;
      
      // 应用过滤逻辑
      const databaseName = collection.label?.toString();
      // 向上查找连接节点
      let connectionNode: Datasource | undefined = collection;
      while (connectionNode && connectionNode.type !== 'datasource') {
        connectionNode = connectionNode.parent;
      }
      const connectionName = connectionNode?.label?.toString();
      
      if (connectionName && databaseName) {
        const key = `${connectionName}:${databaseName}`;
        if (this.treeState.selectedTables?.[key]) {
          const selectedTables = this.treeState.selectedTables[key];
          if (selectedTables.length > 0) {
            // 过滤只显示选中的表
            tableTypeNode.children = tableTypeNode.children.filter(child => 
              selectedTables.includes(child.label?.toString() || '')
            );
          }
        }
      }
      
      // 更新 collectionType 节点的计数显示为 x/N 格式
      const displayedCount = tableTypeNode.children.length;
      const extraText = `${displayedCount}/${totalCount}`;
      tableTypeNode.data.extra = extraText;
      tableTypeNode.description = extraText;
      this._onDidChangeTreeData.fire(tableTypeNode);

      // 更新数据库描述为表的数量
      const tableCount = tableTypeNode.children.length;
      const descriptionText = `${tableCount} 个表`;
      collection.description = descriptionText;
      if (collection.data) {
        collection.data.extra = descriptionText;
      }
      // 强制刷新该节点及其父节点
      this._onDidChangeTreeData.fire(collection);
      if (collection.parent) {
        this._onDidChangeTreeData.fire(collection.parent);
      }

      // 遍历每个表，加载字段和索引
      for (const table of tableTypeNode.children) {
        if (table.type === 'document') {
          await this.loadDocumentChildren(table);
        }
      }
    }
  }

  /**
   * 加载表（document）的所有子节点
   * @param document 表节点
   */
  private async loadDocumentChildren(document: Datasource): Promise<void> {
    // 如果已经加载过字段，检查描述是否已设置
    if (document.children && document.children.length > 0) {
      const fieldTypeNode = document.children.find(child => child.type === 'fieldType');
      if (fieldTypeNode && fieldTypeNode.children && fieldTypeNode.children.length > 0) {
        // 字段已加载，只需更新描述（如果还没有）
        if (!document.description || !document.data?.extra) {
          const fieldCount = fieldTypeNode.children.length;
          const descriptionText = `${fieldCount} 个字段`;
          document.description = descriptionText;
          if (document.data) {
            document.data.extra = descriptionText;
          }
          this._onDidChangeTreeData.fire(document);
        }
        return;
      }
    }
    
    // 加载表下的对象类型（字段、索引）
    const objectTypes = await document.expand(this.context);
    document.children = objectTypes || [];
    this._onDidChangeTreeData.fire(document);

    // 查找"字段"类型节点
    const fieldTypeNode = document.children.find(child => child.type === 'fieldType');
    if (fieldTypeNode) {
      // 加载所有字段
      const fields = await fieldTypeNode.expand(this.context);
      fieldTypeNode.children = fields || [];
      this._onDidChangeTreeData.fire(fieldTypeNode);

      // 更新表描述为字段的数量
      const fieldCount = fieldTypeNode.children.length;
      const descriptionText = `${fieldCount} 个字段`;
      document.description = descriptionText;
      if (document.data) {
        document.data.extra = descriptionText;
      }
      // 强制刷新该节点及其父节点
      this._onDidChangeTreeData.fire(document);
      if (document.parent) {
        this._onDidChangeTreeData.fire(document.parent);
      }
    }

    // 查找"索引"类型节点
    const indexTypeNode = document.children.find(child => child.type === 'indexType');
    if (indexTypeNode) {
      // 加载所有索引
      const indexes = await indexTypeNode.expand(this.context);
      indexTypeNode.children = indexes || [];
      this._onDidChangeTreeData.fire(indexTypeNode);
    }
  }

  /**
   * 清除缓存的树数据（已移除本地缓存，保留此方法仅为兼容调用）
   */
  public clearCachedTreeData(_connectionName: string): void {}

  /**
   * 重命名连接：迁移树状态中所有以旧连接名为 key 的数据到新名称
   * @param oldName 原连接名称
   * @param newName 新连接名称
   */
  public renameConnection(oldName: string, newName: string): void {
    if (oldName === newName) return;
    if (this.treeState.selectedDatabases?.[oldName] !== undefined) {
      if (!this.treeState.selectedDatabases) this.treeState.selectedDatabases = {};
      this.treeState.selectedDatabases[newName] = this.treeState.selectedDatabases[oldName];
      delete this.treeState.selectedDatabases[oldName];
    }
    if (this.treeState.selectedTables) {
      const newSelectedTables: Record<string, string[]> = {};
      for (const [key, tables] of Object.entries(this.treeState.selectedTables)) {
        if (key.startsWith(`${oldName}:`)) {
          newSelectedTables[`${newName}:${key.slice(oldName.length + 1)}`] = tables;
        } else {
          newSelectedTables[key] = tables;
        }
      }
      this.treeState.selectedTables = newSelectedTables;
    }
    if (this.treeState.expandedNodes?.length) {
      const segmentOld = `datasource:${oldName}`;
      const segmentNew = `datasource:${newName}`;
      this.treeState.expandedNodes = this.treeState.expandedNodes.map((path) => {
        const parts = path.split("/");
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] === segmentOld) {
            parts[i] = segmentNew;
          }
        }
        return parts.join("/");
      });
    }
    this.saveTreeState();
  }
}
