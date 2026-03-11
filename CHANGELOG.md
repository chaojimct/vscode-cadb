# 更新日志

## [0.0.2]

### 新增

- 数据源视图「新建」入口统一为「新建数据源」命令（`cadb.datasource.new`），图标改为 `$(add)`。

### 变更

- **图标与资源**
  - 侧边栏活动栏图标路径改为 `./resources/icons/logo.png`。
  - 更新根目录扩展图标 `logo.png`（体积优化）。
  - 移除未使用的 `resources/icons/logo.svg`。

- **数据源与命令**
  - 原「新建数据库」命令 `cadb.datasource.addDatabase` 重命名为 `cadb.datasource.new`，文案改为「新建数据源」。
  - 「新建」逻辑收敛到 `Datasource.create()`：在数据源类型节点上执行新建时，由实体根据类型（如 MySQL）决定是创建数据源连接还是创建数据库。
  - 通过 `Datasource.createDatabaseHost` 注入 Webview、刷新与加载子节点能力，避免 commands 与 entity 循环依赖；创建数据库流程（collation 选择、保存、刷新、展开新库）保留在 `Datasource` 内。

- **SQL Notebook**
  - 执行结果统一为结构化输出：查询结果使用 MIME 类型 `application/x.sql-result`（含 `columns`、`data`、`rowCount`、`executionTime`、`message`），由 Notebook 渲染器以表格展示。
  - 执行错误使用 `application/x.sql-error`（含 `type: 'query-error'` 与 `error` 信息）。
  - 移除单元格内自绘 HTML 表格逻辑（`_generateHtmlTable`），不再同时输出 `text/html` 与 `application/json`。

### 移除

- 数据源树视图中按「类型」节点触发的「新建数据库」单独菜单项已移除；在对应类型节点上使用「新建数据源」即可创建数据库（仅当该类型支持时）。
