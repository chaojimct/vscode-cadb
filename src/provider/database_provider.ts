import path from "path";
import { readFileSync } from "fs";
import * as vscode from "vscode";
import { Datasource, DatasourceInputData } from "./entity/datasource";
import type { CaEditor } from "./component/editor";

/**
 * 树展开状态接口
 */
interface TreeState {
  expandedNodes: string[]; // 存储已展开节点的路径
  selectedDatabases?: Record<string, string[]>; // 存储每个连接选择显示的数据库
  cachedTreeData?: Record<string, any>; // 存储缓存的树数据
}

export class DataSourceProvider implements vscode.TreeDataProvider<Datasource> {
  public model: DatasourceInputData[];
  public context: vscode.ExtensionContext;
  public panels: Record<string, string>;
  public editor?: CaEditor;
  private treeState: TreeState;

  constructor(context: vscode.ExtensionContext) {
    this.model = [];
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
      book: readFileSync(
        path.join(
          this.context.extensionPath,
          "resources",
          "panels",
          "book",
          "book.html"
        ),
        "utf-8"
      ),
    };

    // 加载树状态
    this.treeState = this.loadTreeState();
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
          
          // 从缓存恢复数据库和表的描述
          if (connectionName && this.treeState.cachedTreeData?.[connectionName]) {
            await this.restoreDescriptionsFromCache(element, this.treeState.cachedTreeData[connectionName]);
          }
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
    return this.model.map((e) => new Datasource(e));
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

  public refresh = (): void => {
    this.model = this.context.globalState.get<DatasourceInputData[]>(
      "cadb.connections",
      []
    );
    this._onDidChangeTreeData.fire();
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

  public setEditor(editor: CaEditor): void {
    this.editor = editor;
  }

  /**
   * 加载树状态
   */
  private loadTreeState(): TreeState {
    return this.context.globalState.get<TreeState>('cadb.treeState', {
      expandedNodes: [],
      selectedDatabases: {}
    });
  }

  /**
   * 保存树状态
   */
  private saveTreeState(): void {
    this.context.globalState.update('cadb.treeState', this.treeState);
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

    // 加载第一层子节点（数据库、用户等）
    progress?.report({ message: `正在加载 ${datasource.label} 的子节点...` });
    let children = await datasource.expand(this.context);
    datasource.children = children || [];
    this._onDidChangeTreeData.fire(datasource);

    // 遍历每个子节点
    for (const child of datasource.children) {
      if (child.type === 'datasourceType') {
        // 加载数据库列表
        progress?.report({ message: `正在加载数据库列表...` });
        const databases = await child.expand(this.context);
        child.children = databases || [];
        this._onDidChangeTreeData.fire(child);

        // 检查是否有选择的数据库
        const connectionName = datasource.label?.toString() || '';
        const selectedDbs = this.getSelectedDatabases(connectionName);
        let databasesToLoad = child.children;
        
        // 如果用户选择了数据库，只加载选择的数据库
        if (selectedDbs.length > 0) {
          databasesToLoad = child.children.filter(db => 
            selectedDbs.includes(db.label?.toString() || '')
          );
        }

        // 遍历每个数据库
        for (const db of databasesToLoad) {
          if (db.type === 'collection') {
            // 加载数据库下的表
            progress?.report({ message: `正在加载数据库 ${db.label} 的表...` });
            await this.loadCollectionChildren(db);
          }
        }
      } else if (child.type === 'userType') {
        // 加载用户列表
        progress?.report({ message: `正在加载用户列表...` });
        const users = await child.expand(this.context);
        child.children = users || [];
        this._onDidChangeTreeData.fire(child);
      }
    }

    // 保存加载的数据
    this.saveCachedTreeData(datasource);
  }

  /**
   * 加载数据库（collection）的所有子节点
   * @param collection 数据库节点
   */
  private async loadCollectionChildren(collection: Datasource): Promise<void> {
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
   * 保存缓存的树数据
   * @param datasource 数据源节点
   */
  private saveCachedTreeData(datasource: Datasource): void {
    if (!this.treeState.cachedTreeData) {
      this.treeState.cachedTreeData = {};
    }

    const connectionName = datasource.label?.toString() || '';
    if (!connectionName) {
      return;
    }

    // 序列化树结构
    const treeData = this.serializeTreeData(datasource);
    this.treeState.cachedTreeData[connectionName] = treeData;
    this.saveTreeState();
  }

  /**
   * 序列化树数据
   * @param node 节点
   */
  private serializeTreeData(node: Datasource): any {
    const data: any = {
      type: node.type,
      name: node.label?.toString() || '',
      description: node.description,
      children: []
    };

    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        data.children.push(this.serializeTreeData(child));
      }
    }

    return data;
  }

  /**
   * 从缓存加载树数据
   * @param datasource 数据源节点
   */
  public async loadCachedTreeData(datasource: Datasource): Promise<boolean> {
    const connectionName = datasource.label?.toString() || '';
    if (!connectionName || !this.treeState.cachedTreeData?.[connectionName]) {
      return false;
    }

    const cachedData = this.treeState.cachedTreeData[connectionName];
    await this.deserializeTreeData(datasource, cachedData);
    this._onDidChangeTreeData.fire(datasource);
    return true;
  }

  /**
   * 反序列化树数据
   * @param node 节点
   * @param data 数据
   */
  private async deserializeTreeData(node: Datasource, data: any): Promise<void> {
    // 更新描述
    if (data.description) {
      node.description = data.description;
      if (node.data) {
        node.data.extra = data.description;
      }
    }

    // 递归处理子节点
    if (data.children && Array.isArray(data.children)) {
      // 先展开节点以获取子节点
      const children = await node.expand(this.context);
      node.children = children || [];
      
      // 更新子节点的描述
      for (const childData of data.children) {
        const child = node.children.find(c => 
          c.type === childData.type && c.label?.toString() === childData.name
        );
        if (child) {
          if (childData.description) {
            child.description = childData.description;
            if (child.data) {
              child.data.extra = childData.description;
            }
          }
          // 递归处理子节点的子节点
          if (childData.children && childData.children.length > 0) {
            await this.deserializeTreeData(child, childData);
          }
        }
      }
      
      this._onDidChangeTreeData.fire(node);
    }
  }

  /**
   * 从缓存恢复节点描述
   * @param node 当前节点
   * @param cachedData 缓存数据
   */
  private async restoreDescriptionsFromCache(node: Datasource, cachedData: any): Promise<void> {
    if (!cachedData || !cachedData.children) {
      return;
    }

    // 查找对应的缓存数据
    const findCachedNode = (children: any[], targetType: string, targetName: string): any => {
      for (const child of children) {
        if (child.type === targetType && child.name === targetName) {
          return child;
        }
        if (child.children) {
          const found = findCachedNode(child.children, targetType, targetName);
          if (found) {
						return found;
					}
        }
      }
      return null;
    };

    // 恢复数据库节点的描述
    if (node.type === 'datasourceType' && node.children) {
      for (const dbNode of node.children) {
        if (dbNode.type === 'collection') {
          const cachedDb = findCachedNode(cachedData.children, 'collection', dbNode.label?.toString() || '');
          if (cachedDb && cachedDb.description) {
            dbNode.description = cachedDb.description;
            if (dbNode.data) {
              dbNode.data.extra = cachedDb.description;
            }
            this._onDidChangeTreeData.fire(dbNode);
            
            // 恢复表节点的描述
            if (dbNode.children) {
              const tableTypeNode = dbNode.children.find(c => c.type === 'collectionType');
              if (tableTypeNode && tableTypeNode.children && cachedDb.children) {
                const cachedTableType = findCachedNode(cachedDb.children, 'collectionType', '表');
                if (cachedTableType && cachedTableType.children) {
                  for (const tableNode of tableTypeNode.children) {
                    if (tableNode.type === 'document') {
                      const cachedTable = findCachedNode(cachedTableType.children, 'document', tableNode.label?.toString() || '');
                      if (cachedTable && cachedTable.description) {
                        tableNode.description = cachedTable.description;
                        if (tableNode.data) {
                          tableNode.data.extra = cachedTable.description;
                        }
                        this._onDidChangeTreeData.fire(tableNode);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
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
