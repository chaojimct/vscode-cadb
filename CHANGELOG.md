# 更新日志

## [0.3.5]

### 新增

- **查询结果导出**：底部「查询」面板中，每个结果标签上方提供 **JSON / CSV / TSV** 导出按钮；右键结果标签亦可选择对应格式。通过 `showSaveDialog` 选择保存路径（默认文件名来自结果标题，默认目录为当前工作区根目录；无工作区时使用扩展全局存储目录）。CSV/TSV 含表头并对含分隔符、引号、换行的单元格做转义；JSON 为对象数组，对 `Date`、`Buffer`（含 Webview 传来的 `{ type, data }`）、`BigInt` 等做可读序列化。
- **SQL · 运行当前语句快捷键**：命令 `cadb.sql.runCurrent` 绑定 **Windows / Linux：`Ctrl+Enter`**，**macOS：`Cmd+Enter`**（`editorLangId == sql` 且非 Notebook 编辑器时生效）。

### 优化

- **\*.sql 智能补全**：触发补全前按当前 SQL 文档 URI 恢复已保存的数据源/库绑定；使用光标前跨行文本判断 `USE` / `FROM` / `JOIN` / `表.列` 等上下文；连接解析同时匹配配置的 `name` 与树节点展示名；字段与表补全的 **detail** 中分别标明「所属表」「所属数据库」；未选连接时仍提供 SQL 关键字提示。
- **`[sql]` 编辑器默认行为**：`configurationDefaults` 中为 SQL 增加 `editor.quickSuggestions`（普通代码区开启，注释与字符串内关闭），减少干扰并便于触发扩展补全。

## [0.3.4]

### 修复

- **Webview Codicons（数据表格 / 配置管理 / AI 助手）**：`grid.html`、`settings.html` 仍经 `node_modules` 的 Webview URI 加载 `@vscode/codicons` 时，与 AI 助手同类问题，易导致 Codicon 字体与图标不显示。现通过 `scripts/copy-ai-chat-vendor.cjs` 将 `codicon.css`、`codicon.ttf` 复制到 `resources/panels/common/vendor/codicons/dist/`（仅复制上述二文件，避免 `dist` 内 `.ts` 被 webpack 误编译）；`ai-chat.html`、`grid.html`、`settings.html` 统一经 `{{resources-uri}}/common/vendor/codicons/...` 引用；`resources/panels/common/vendor/` 列入 `.gitignore` 并由打包流程写入 `.vsix`。

### 变更

- **`.vscodeignore`**：移除对 `node_modules/@vscode/codicons/dist` 的打包白名单；运行时改由 `resources/panels/common/vendor` 提供 Codicons，并略减小 `.vsix` 体积。

## [0.3.3]

### 修复

- **AI 数据库助手 · 安装版 Webview 资源 404 / `ChatArea is not defined`（落地）**：从市场安装后，经 `node_modules` 的 Webview URI 加载 `chatarea`、`marked` 在新版 VS Code 本地资源管线下易失败。现通过 `scripts/copy-ai-chat-vendor.cjs` 在 `postinstall` 及 `compile` / `watch` / `package` 前将所需静态文件复制到 `resources/panels/ai-chat/vendor/`；`ai-chat.html` 改为仅从 `{{resources-uri}}/ai-chat/vendor/...` 引用；`resources/panels/ai-chat/vendor/` 列入 `.gitignore` 并由打包流程写入 `.vsix`。

## [0.3.2]

### 修复

- **AI 数据库助手 · 安装版 Webview 资源 404 / `ChatArea is not defined`**：问题与修复方向说明；`chatarea` / `marked` 落地见 **0.3.3**；Codicons 等 Webview 静态资源见 **0.3.4**。

## [0.3.1]

### 修复

- **AI 数据库助手 · 选库列表为空**：在扩展刚加载、数据源树尚未完成同步或未展开时，仅从树同步读取会得到空的「连接 / 数据库」选项。现改为树收集结果为空时，按 `getConnections()` 直连拉取库列表（逻辑与已有表名展开一致），并跳过已手动关闭的连接、遵守侧栏「过滤显示的数据库」；收到树刷新且仍停留在选库界面时会重新填充下拉框。

### 新增

- **GitHub Actions 发版**：推送 `v*` 标签时执行 `vsce publish` 与 `ovsx publish`（见 `.github/workflows/publish.yml`）。需在仓库 **Actions Secrets** 中配置 `VSCE_PAT`（VS Marketplace）；`OVSX_PAT`（Open VSX）可选，未配置时跳过 Open VSX 步骤。

### 变更

- **.vscodeignore**：增加 `.github/**`，避免将 CI 工作流打入 `.vsix`。

## [0.3.0]

### 新增

- **AI 数据库助手**
  - 基于 Webview 的对话界面：绑定当前数据源与数据库，`@` 插入表名（ChatArea），流式展示助手回复；会话列表、清空、API Key / Base URL / Model 配置（`cadb.ai`）。
  - **快速查询**：输入区上方开关；开启时通过 [ChatArea `openTipTag`](https://www.jianfv.top/ChatAreaDoc/guide/api) 在输入框前展示模式说明；后端使用 OpenAI 兼容 **function calling**（`tool_choice: required` + 仅 `execute_sql` 工具），**单次**生成并执行最终 SQL，适合明确的数据查询场景。
  - **结果表格**：助手消息内 Markdown 表格默认收入 **可折叠** 区域（摘要显示行数，点击展开）；支持 **复制表格**（TSV，便于粘贴 Excel）。
  - **代码块复制**：代码块右上角复制操作与表格复制均改为 **VS Code Codicons** 图标按钮（`@vscode/codicons`）。

### 优化

- **AI 助手 Markdown**：正文与 GFM 表格之间仅单换行时自动补空行，避免「共 N 行。」紧贴 `|` 表头导致表格无法解析、整段显示为乱格式。
- **代码块展示**：`pre` / `pre code` 使用 `pre-wrap` 与换行策略，长 SQL **自动换行**，**不再出现横向滚动条**。
- **智能体提示词**：约束最终 SELECT 结果勿大段复述表格内容；强调表格块前须有空行，减少模型输出与渲染错位。

### 文档

- **README**：补充 **AI 数据库助手** 演示截图（`examples/example4.png`）。

## [0.1.8]

### 新增

- **Grid JSON 单元格编辑**：单元格预览面板中，对 JSON 类型内容提供内联编辑能力。点击「编辑」图标切换至可编辑的 Tree 模式；点击「应用」（✓）将修改后的 JSON 写回表格单元格并触发常规行变更跟踪；点击「取消」（discard）回退到只读覆览模式。预览面板工具栏按钮全部改为图标形式（fold / unfold / edit / check / discard）。
- **扫描数据库连接**：资源管理器右键菜单新增「扫描数据库连接」。扫描工作区内 `*.yaml`、`*.yml`、`*.py`、`*.properties`、`*.go`、`.env.*` 等文件，支持多种模式：
  - **DSN/URL**：`mysql://user:pass@host:port/db` 等通用连接串（全文件类型通用）
  - **YAML/Properties 键値型**：Spring Boot `jdbc:mysql://...` URL、`host` + `port` + `database` 分离写法
  - **Python**：SQLAlchemy `create_engine()`、pymysql / psycopg2 `connect()` 参数形式
  - **Go**：`database/sql` `sql.Open()`、GORM `mysql.Open()` 等
  - 结果自动去重，在 QuickPick 中展示；选定条目后跳转到来源文件对应行。
- **运行 SQL 文件**：资源管理器对 `*.sql` 文件添加右键菜单「运行 SQL 文件」，一次性选择连接与数据库后逐条执行并输出到 CADB SQL 日志面板。
- **拖放增强**：数据源树任意节点均可拖放（不再限于表节点），拖放至编辑器时插入 `` `节点名` ``；`fieldType` 节点（字段列表）拖放时自动展开为 `` `字段1`, `字段2`, ... `` 格式。

### 优化

- **连接与数据库选择**：将原两步选择（先选连接、再选数据库）并为单步 QuickPick，格式为「连接名 / 数据库名」；`description` 中展示数据源类型、`host:port`、用户名等连接信息。
- **自动展开所有连接**：`Promise.all` 并行加载各连接下的数据库列表，减少等待时间。

### 移除

- **运行全部 CodeLens**：移除文件顶部「运行全部」透镜以及所有 `sqlCodeLensProvider.refresh()` 调用；Explain 透镜保留。


### 新增

- **数据表格（Grid）复制与粘贴**
  - **Ctrl+V / ⌘V**（Windows/Linux 为 Ctrl，macOS 为 ⌘，下同）：从剪贴板按 TSV 粘贴到当前焦点单元格起，可向右下扩展；行不足时在表尾追加新行。
  - **Ctrl+C / ⌘C**：弹出**浮动菜单**，可选择将选中行复制为 **TSV**、**JSON** 或 **INSERT**（SQL，表名随当前加载的库表）；Webview 内 `navigator.clipboard` 受限时由扩展侧写入系统剪贴板。
- **数据源树 · 连接开关**：根连接节点支持 **打开 / 关闭**；右键 **「切换连接（打开/关闭）」**。关闭时断开底层连接（MySQL 池释放、Redis `quit`、OSS 客户端销毁）、清空子节点、节点描述为 **「已关闭」**；再次切换可重新挂载驱动。**已关闭**状态随数据源树状态一并写入 **全局状态**（`cadb.treeState.closedConnectionNames`），重载窗口后仍保持。
- **快捷键约定（Webview）**：表格侧栏、单元格预览触发、复制/粘贴/侧栏搜索等组合键统一为 **Windows / Linux 使用 Ctrl，macOS 使用 ⌘**（不再混用双修饰键判断）。

### 优化

- **数据源树 · 分组展开状态**：侧栏根分组（folder）的展开/折叠与 `cadb.treeState.expandedNodes` 中已有路径一致；在 `getTreeItem` 中按持久化状态设置 `collapsibleState`，重载窗口或同步刷新后仍保持上次分组开关状态。
- **Grid JSON 单元格预览（jsoneditor）**：加载后默认**全部展开**节点；预览区提供 **「全部收起 / 全部展开」** 一键切换。
- **表格行选择**：多选仅通过**左侧复选框**与表头全选；单击数据单元格不再切换行选中，避免与编辑、点选冲突。
- **复制选中行**：焦点停留在**行选复选框**上时仍可触发复制菜单；若 `getSelectedRows` 为空，则回退 `getSelectedNodes` / `forEachNode` + `isSelected` 收集行数据，无需先点数据格。

### 修复

- **AG Grid**：移除社区版不支持的 **`rowNumbers`** 配置，消除控制台 **error #200**（该行能力需 Enterprise）。

## [0.1.6]

### 新增

- **快速执行 SQL**：命令「快速执行 SQL…」与快捷键 **Ctrl+Alt+Q**（macOS：**Cmd+Alt+Q**）。依次选择支持 SQL 的连接与数据库（连接列表与选库时均可选「使用上次选择」），在输入框中输入 SQL 后回车执行；成功执行后记住本次连接与库，下次可跳过选择步骤。
- **从快速执行历史执行**：命令「从快速执行历史中选择并执行…」与快捷键 **Ctrl+Alt+A**（macOS：**Cmd+Alt+A**）。在列表中选取曾通过快速执行成功跑过的语句，使用**当前** CADB 连接与数据库立即执行；执行成功会再次记入历史。
- **配置** `cadb.quickExecuteSql.historyMaxEntries`：快速执行历史条数上限（默认 10，范围 1–200），列表最上方为最新。
- **数据表格（Grid）工具栏**：新增「复制表 DDL」按钮，通过 `SHOW CREATE TABLE` 将当前表建表语句写入剪贴板。

### 优化

- **SQL 格式化**：以 `language: sql` 注册文档与**选区**格式化；工作区默认将 SQL 的 `editor.defaultFormatter` 指向本扩展，适用于 `.sql`、未保存缓冲、SQL Notebook 单元格等场景。
- **SQL 语句边界**：`runLine`、Explain 等路径统一按分号拆分后的**完整语句**解析光标所在语句，多行格式化后执行/解释与预期一致。
- **SQL CodeLens**：移除逐行「运行」透镜，保留文件顶部「运行全部」及符合条件的 **Explain** 透镜，避免格式化多行 SQL 时界面杂乱。
- **Grid 工具栏**：「快捷查询」与后续操作按钮之间增加分隔线；导出区去掉 XLSX/JSON 导出入口，改为上述「复制表 DDL」能力。

### 移除

- **聊天参与者**：移除内置「CADB 数据表」（`@cadb-tables`）Chat Participant 及相关 `package.json` 贡献与激活项；数据源树拖放至聊天等场景时，`text/plain` 回退文案改为「数据表：`表名`…」形式的纯文本。

## [0.1.5]

### 新增

- **数据源树**：所有树节点右键菜单「复制」，一键复制节点显示名称。
- **数据表格（Grid）**
  - 分页工具栏增加「第一页」快捷按钮（客户端分页与服务端分页均支持）。
  - 分页区展示当前表名；悬停以自定义提示显示全路径「连接 / 数据库 / 表」（单行、即时显示）；编辑器内 WebView 标签标题仅显示表名。
  - 列宽策略：`autoSizeStrategy` 使用 `fitCellContents`，并配合列定义默认值优化展示（`defaultMaxWidth` / `defaultMinWidth` 等）。
- **SQL Notebook**
  - 查询**失败**时不再将本次错误写入结果历史；若已有历史结果，顶部展示「本次执行失败（未记入历史）」说明。
  - 多条结果 Tab 旁提供**删除**按钮，可移除单条历史结果（依赖渲染器与扩展双向消息；Notebook 渲染器 `requiresMessaging` 设为 `always`）。
  - 结果表格**表头 / 数据格**：**双击**将内容写入剪贴板（`NULL`、本地化日期、JSON 全文等与展示规则一致）；单击仍可拖选文本。

### 优化

- **远程开发**：删除侧栏 `.jsql` / `.sql` 文件及删除连接时清理 `globalStorage` 目录，若环境不支持回收站则自动回退为**永久删除**，避免 SSH Remote 等场景报错。

### 修复

- **远程 / 虚拟文件系统**：修复「无法通过回收站删除…提供程序不支持」导致的删除失败（`workspace.fs.delete` 在回收站不可用时回退 `useTrash: false`）。

## [0.1.4]

### 新增

- **Grid 单元格预览增强**：集成 JSON Editor 作为单元格预览能力，对 JSON 内容提供更友好的查看体验。
- **预览插件机制**：新增预览插件注册与启用存储能力，为后续扩展更多数据预览方式提供基础。

### 优化

- **数据源侧栏重构**：重构数据源侧栏管理逻辑，优化状态持久化与恢复流程，提升视图一致性与可维护性。
- **面板与资源整理**：同步调整 Grid 与设置面板相关资源组织，精简无用资源文件。

## [0.1.3]

### 新增

- **数据源管理增强**：改进数据源管理与交互体验，优化日常连接操作流程。

### 优化

- **表格配置体验**：增强字段配置能力，改进 tooltip 展示，并优化侧栏宽度调整交互。

### 修复

- **激活事件清理**：移除数据源树相关的未使用激活事件，减少不必要的激活配置。

## [0.1.2]

### 新增

- **MySQL 连接池**：按「主机 + 端口 + 用户 + 密码」复用 `mysql2` 连接池；新增配置项 `cadb.mysql.connectionPoolLimit`（默认 10，范围 1–100）。SQL 执行、Notebook、悬浮提示、库属性更新（`ALTER DATABASE`）及带事务的 SQL 文件执行等路径统一经池获取连接；需同一会话的场景使用 `withMysqlSession`（含 `changeUser`、事务）并在结束后 `release`。
- **扩展卸载**：`deactivate` 时关闭并清理全部 MySQL 连接池。

### 优化

- **驱动管理页**：校正各内置驱动对应的 npm 包说明（MySQL 仅展示 `mysql2`）；副标题补充运行时依赖版本解析说明；展示当前扩展版本；卡片区标签改为「运行时依赖（npm）」。
- **依赖精简**：移除未使用的 `mysql` 与 `@types/mysql`。

### 修复

- **类型与转义**：`Pool` 类型不包含 `escape` 时改为使用 `mysql2` 模块导出的 `escape`，消除编译错误并与运行时一致。

## [0.1.1]

### 新增

- **连接分组**：连接配置新增「分组」字段，支持按分组管理与展示连接。
- **Grid 侧栏字段筛选**：字段侧栏改为「搜索 + 显示/隐藏匹配字段」模式，支持一键清空与回车切换。
- **MySQL 树节点删除**：支持在侧栏直接删除连接/库/表/字段/索引/用户（按驱动能力约束）。
- **SQL 格式化增强**：支持 SQL 文件与 SQL Notebook 单元格格式化（基于 `sql-formatter`）。

### 优化

- **表格交互**：列头 tooltip 显示字段注释；列宽支持自由拖拽调整。
- **查询结果面板**：结果表格切换为 AG Grid 渲染，降低前端依赖与包体积。
- **发布体积**：优化 `.vscodeignore`，移除无关资源与历史产物，收紧打包白名单。

### 修复

- **MySQL 连接稳定性**：修复偶发 `write after end` 导致的连接失败问题（重连竞态与并发保护）。

## [0.1.0]

### 新增

- **数据库驱动管理**：新增统一的驱动管理界面，支持查看内置驱动、安装/卸载驱动，并在新增连接时按驱动启用状态展示可用类型。
- **数据源分组与过滤**：增强数据源管理能力，支持分组展示与过滤选项，便于在复杂连接列表中快速定位目标数据源。
- **Grid 侧栏筛选能力**：新增表格字段侧栏与筛选 SQL 生成功能，可在数据预览时基于字段配置快速构造查询条件。

### 优化

- **Grid 交互增强**：新增侧栏显示切换命令与快捷键，并改进数据表格处理逻辑，提升数据预览与字段浏览体验。
- **数据源配置流程**：配合驱动管理重构数据源配置与命令逻辑，统一连接创建、编辑和驱动启用状态的处理。
- **设置与结果面板**：完善设置面板与结果展示样式，增强驱动管理及查询结果相关界面的可用性。

### 文档

- **README 示例补充**：新增驱动管理、数据预览和 SQL Notebook 的示例图片，并修正相关图片路径。

## [0.0.9]

### 新增

- **字段搜索**：Grid 面板支持按字段名模糊搜索，快速定位目标列。
- **列可见性控制**：Grid 面板支持显示/隐藏列，可根据需要自定义展示字段。

## [0.0.8]

### 新增

- **SELECT 自动 LIMIT**：执行 SELECT/WITH 查询时，若语句末尾未写 LIMIT，自动追加（条数取 `cadb.grid.pageSize`），防止一次拉取过多行导致卡顿。可通过 `cadb.query.autoAppendSelectLimit` 配置开关。

## [0.0.7]

### 新增

- **SQL 格式化**：支持 SQL 文件格式化（右键 → 格式化文档 / `Shift+Alt+F`），基于 `sql-formatter`，自动适配编辑器缩进设置。

### 优化

- **表格列显示**：移除固定 `maxWidth` 限制，表格列可自适应内容宽度展开。
- **列注释提示**：表格列头支持 hover 显示字段注释信息。

## [0.0.6]

### 新增

- **工作区级别数据源保存**：数据源配置支持按工作区独立保存，不同项目可维护各自的数据库连接。
- **数据源颜色标记**：为数据源添加颜色标识，方便在数据源列表中快速区分不同连接。

## [0.0.5]

### 新增

- **SQL Hover Provider**：在 SQL Notebook 中悬停 SQL 关键字、表名、列名时显示提示信息（`sql_hover_provider.ts`，新增 360 行）。
- **SQL Notebook 命令增强**：新增多种 SQL Notebook 操作命令，支持更多交互方式。
- **结果面板增强**：新增 `ResultProvider`（`result_provider.ts`），提供结构化查询结果展示能力。
- **Grid 面板**：新增 Grid 面板（`grid.html`、`grid.js`、`grid.css`），支持网格视图展示数据。
- **Edit 面板增强**：Edit 面板新增字段配置与样式改进。

### 变更

- **SQL Notebook 控制器重构**：`sql_notebook_controller.ts` 大幅优化（+234/-232），改进执行与渲染逻辑。
- **SQL Notebook 序列化**：`sql_notebook_serializer.ts` 增强数据序列化能力。
- **MySQL 数据加载器**：`mysql_dataloader.ts` 扩展数据加载能力，支持更多查询场景。
- **补全提供器**：`completion_item_provider.ts` 优化自动补全体验。
- **数据库状态栏**：`database_status_bar.ts` 增强状态显示与交互。
- **Notebook 渲染器**：`renderer.js` 大幅重写（+408 行），提升结果渲染效果与性能。
- **通用组件**：`field-config.js`、`table.js` 等组件优化配置与表格展示。

---

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
