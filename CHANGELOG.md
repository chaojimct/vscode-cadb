# 更新日志

## [0.0.4]

### 新增

- **工作区符号（MySQL 表）**：在「转到工作区中的符号」（`Ctrl+T` / `Cmd+T`）中展示所有 MySQL 数据表，选择表可快速打开表数据视图。仅扫描当前「过滤显示」的数据库下的表。
- **重命名文件自动补全后缀**：`cadb.file.rename` 会检查原文件后缀，若用户输入的新文件名未带后缀则自动补上原后缀；若已带后缀则不再补充。

### 变更

- **工作区符号**：仅扫描「显示的数据库」——当某连接设置了过滤显示的数据库时，只将这些库下的表加入工作区符号。
- **数据源树不再使用本地缓存**：每次加载插件均从服务器拉取最新树数据；用户设置的「过滤显示的数据库/表」与展开状态仍会持久化并继续生效。
- **Notebook 工具栏**：移除「选择表」入口，保留「选择数据库」与「显示数据库状态」。

### 移除

- 工作区符号相关调试日志（OutputChannel「CADB 工作区符号」及所有调试输出）。

---

## [0.0.3]

### 新增

- **数据源重命名**：数据源类型（连接）TreeItem 支持重命名。在侧边栏连接行可点击「重命名」或右键选择「重命名」，修改连接显示名称；树状态（缓存、选中数据库/表、展开路径）会随重命名迁移。
- **表格分页配置**：设置项 `cadb.grid.pageSize`（默认 2000，范围 1–10000），用于表格每页查询条数，用户可在插件设置中自定义。

### 变更

- **表格分页逻辑**
  - 单次查询最多返回 `pageSize` 条，不查询总条数。分页基于 `LIMIT offset, pageSize`：记录当前 `offset`，上一页在 `offset === 0` 时禁用，下一页在本页返回条数 `< pageSize` 时禁用。
  - 点击「上一页」请求 `offset - pageSize`，点击「下一页」请求 `offset + pageSize`；刷新时保持当前页（携带当前 offset 重新请求）。
  - `listData` 支持可选参数 `{ offset, limit }`，MySQL 使用 `LIMIT offset, limit` 查询；Redis/OSS 保持原行为。

---

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
