import path from "path";
import { readFileSync } from "fs";
import * as vscode from "vscode";
import { Datasource, DatasourceInputData } from "./entity/datasource";
import type { DatabaseManager } from "./component/database_manager";

interface CachedNode {
  data: DatasourceInputData;
  children?: CachedNode[];
  collapsibleState?: vscode.TreeItemCollapsibleState;
}

/**
 * 树展开状态接口
 */
interface TreeState {
  expandedNodes: string[]; // 存储已展开节点的路径
  selectedDatabases?: Record<string, string[]>; // 存储每个连接选择显示的数据库
  selectedTables?: Record<string, string[]>; // 存储每个数据库选择显示的表，key格式为 "connectionName:databaseName"
  cachedTreeData?: Record<string, CachedNode[]>; // 存储缓存的树数据
}

export class DataSourceProvider implements vscode.TreeDataProvider<Datasource> {
  public context: vscode.ExtensionContext;
  public panels: Record<string, string>;
  public databaseManager?: DatabaseManager;
  private treeState: TreeState;
  private rootNodes: Datasource[] = [];

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
    };

    // 加载树状态
    this.treeState = this.loadTreeState();
    
    // 初始化数据
    this.initialize();
  }

  public getConnections(): DatasourceInputData[] {
    return this.context.globalState.get("cadb.connections", []);
  }

  private async initialize() {
    const connections = this.getConnections();
    const cachedData = this.treeState.cachedTreeData;
    
    // 简单验证缓存是否有效（检查连接名称）
    const modelNames = connections.map(m => m.name).sort();
    const cacheNames = cachedData ? Object.keys(cachedData).sort() : [];
    const cacheValid = cachedData && JSON.stringify(modelNames) === JSON.stringify(cacheNames);

    if (cacheValid && cachedData) {
      this.rootNodes = connections.map(m => {
        const node = new Datasource(m);
        const cachedChildren = cachedData[m.name];
        if (cachedChildren) {
          node.children = this.deserializeChildren(cachedChildren, node);
          // 如果有子节点，设置为折叠状态
          if (node.children.length > 0) {
            node.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
          }
        }
        return node;
      });
      this._onDidChangeTreeData.fire();
    } else {
      this.rootNodes = connections.map(m => new Datasource(m));
      this._onDidChangeTreeData.fire();
      // 后台加载并缓存
      this.refreshAndCache();
    }
  }

  private deserializeChildren(cachedChildren: CachedNode[], parent: Datasource): Datasource[] {
    return cachedChildren.map(childCache => {
      // 创建节点，传入父节点的 dataloader 和父节点引用
      const childNode = new Datasource(childCache.data, parent.dataloader, parent);
      
      if (childCache.collapsibleState !== undefined) {
        childNode.collapsibleState = childCache.collapsibleState;
      }
      
      if (childCache.children) {
        childNode.children = this.deserializeChildren(childCache.children, childNode);
      }
      
      return childNode;
    });
  }

  private serializeChildren(nodes: Datasource[]): CachedNode[] {
    return nodes.map(node => ({
      data: node.data,
      collapsibleState: node.collapsibleState,
      children: node.children && node.children.length > 0 ? this.serializeChildren(node.children) : undefined
    }));
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

  public async refreshAndCache() {
    const connections = this.getConnections();
    this.rootNodes = connections.map(m => new Datasource(m));
    this._onDidChangeTreeData.fire();
    
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Window,
      title: "正在同步数据库结构...",
      cancellable: false
    }, async (progress) => {
      const cache: Record<string, CachedNode[]> = {};
      
      // 并行处理所有连接，大幅提升性能
      const nodePromises = this.rootNodes.map(async (node, index) => {
        try {
          progress.report({ 
            message: `正在加载 ${node.label} (${index + 1}/${this.rootNodes.length})`,
            increment: 100 / this.rootNodes.length
          });
          
          // 使用快速展开模式：只加载到表级别，不加载字段
          // 字段信息会在用户展开表时按需加载，避免初始同步时加载大量不必要的数据
          await this.expandRecursiveFast(node, 2);
          
          cache[node.label as string] = this.serializeChildren(node.children);
        } catch (error) {
          console.error(`加载连接 ${node.label} 失败:`, error);
          // 即使失败也保存空数组，避免重复尝试
          cache[node.label as string] = [];
        }
      });

      // 等待所有连接并行加载完成
      await Promise.all(nodePromises);
      
      this.treeState.cachedTreeData = cache;
      this.saveTreeState();
      this._onDidChangeTreeData.fire();
    });
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
      this.refreshAndCache();
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
   * 加载树状态
   */
  private loadTreeState(): TreeState {
    return this.context.globalState.get<TreeState>('cadb.treeState', {
      expandedNodes: [],
      selectedDatabases: {},
      selectedTables: {}
    });
  }

  /**
   * 保存树状态
   */
  private saveTreeState(): void {
    this.context.globalState.update('cadb.treeState', this.treeState);
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
    
    // 触发更新
    this._onDidChangeTreeData.fire(datasource);

    // 保存缓存
    const connectionName = datasource.label?.toString() || '';
    if (connectionName) {
       if (!this.treeState.cachedTreeData) {
         this.treeState.cachedTreeData = {};
       }
       this.treeState.cachedTreeData[connectionName] = this.serializeChildren(datasource.children);
       this.saveTreeState();
    }
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
   * 清除缓存的树数据
   * @param connectionName 连接名称
   */
  public clearCachedTreeData(connectionName: string): void {
    if (this.treeState.cachedTreeData && this.treeState.cachedTreeData[connectionName]) {
      delete this.treeState.cachedTreeData[connectionName];
      this.saveTreeState();
    }
  }
}
