/**
 * SQL Notebook 页面 - 类似 Jupyter Notebook 的 SQL 执行界面
 */

layui.use(["form", "layer", "element"], function () {
  const form = layui.form;
  const layer = layui.layer;
  const element = layui.element;
  const $ = layui.$;

  // 获取 VSCode API
  let vscode = null;
  if (window.vscode) {
    vscode = window.vscode;
  } else {
    vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  }

  // 当前选中的数据源和数据库
  let currentDatasource = null;
  let currentDatabase = null;
  let datasources = [];
  let databases = [];

  // Cell 计数器
  let cellCounter = 0;

  // Monaco Editor 实例存储
  let monacoEditors = new Map();

  // Cell 数据存储（用于保存）
  let cellDataMap = new Map(); // cellId -> { sql, result, error }

  // SQL 关键字列表
  const sqlKeywords = [
    "SELECT",
    "FROM",
    "WHERE",
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "DROP",
    "ALTER",
    "TABLE",
    "INDEX",
    "VIEW",
    "DATABASE",
    "SCHEMA",
    "TRUNCATE",
    "JOIN",
    "INNER",
    "LEFT",
    "RIGHT",
    "FULL",
    "OUTER",
    "ON",
    "AS",
    "AND",
    "OR",
    "NOT",
    "IN",
    "EXISTS",
    "LIKE",
    "BETWEEN",
    "IS",
    "NULL",
    "ORDER",
    "BY",
    "GROUP",
    "HAVING",
    "LIMIT",
    "OFFSET",
    "UNION",
    "ALL",
    "DISTINCT",
    "COUNT",
    "SUM",
    "AVG",
    "MAX",
    "MIN",
    "CAST",
    "CONVERT",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "IF",
    "ELSEIF",
    "WHILE",
    "FOR",
    "LOOP",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "TRANSACTION",
    "GRANT",
    "REVOKE",
    "PRIMARY",
    "KEY",
    "FOREIGN",
    "REFERENCES",
    "CONSTRAINT",
    "UNIQUE",
    "CHECK",
    "DEFAULT",
    "AUTO_INCREMENT",
    "CHAR",
    "VARCHAR",
    "TEXT",
    "INT",
    "BIGINT",
    "DECIMAL",
    "FLOAT",
    "DOUBLE",
    "DATE",
    "TIME",
    "DATETIME",
    "TIMESTAMP",
    "BOOLEAN",
  ];

  // 当前数据库的表和字段信息
  let currentTables = [];
  let currentColumns = new Map(); // tableName -> columns[]

  // 编辑器配置（默认值）
  let editorConfig = {
    fontFamily: "Consolas, Monaco, 'Courier New', monospace",
    fontSize: 13,
    lineHeight: 1.5,
  };

  // Monaco Editor 路径配置
  let monacoBasePath = "";

  // 优先使用全局变量中设置的路径
  if (window.MONACO_BASE_PATH) {
    monacoBasePath = window.MONACO_BASE_PATH;
    console.log("使用全局变量中的 Monaco 路径:", monacoBasePath);
  } else {
    // 从页面中提取 node-resources-uri
    const scripts = document.querySelectorAll("script[src]");
    for (let i = 0; i < scripts.length; i++) {
      const src = scripts[i].getAttribute("src");
      if (src && src.includes("monaco") && src.includes("loader.js")) {
        // 从 loader.js 的完整路径中提取基础 URI
        // 例如: https://xxx/monaco-editor/min/vs/loader.js
        // 提取: https://xxx
        const match = src.match(/(https?:\/\/[^\/]+)/);
        if (match) {
          monacoBasePath = match[1];
          console.log("从脚本提取 Monaco 基础路径:", monacoBasePath);
          break;
        }
      }
    }

    // 如果还是没找到，尝试从其他脚本中提取
    if (!monacoBasePath) {
      for (let i = 0; i < scripts.length; i++) {
        const src = scripts[i].getAttribute("src");
        if (src) {
          const match = src.match(/(https?:\/\/[^\/]+)/);
          if (match) {
            monacoBasePath = match[1];
            console.log("从其他脚本提取基础路径:", monacoBasePath);
            break;
          }
        }
      }
    }
  }

  /**
   * 初始化页面
   */
  function init() {
    // 加载数据源列表
    loadDatasources();

    // 绑定事件
    bindEvents();

    // 添加第一个 Cell
    addCell();
  }

  /**
   * 加载数据源列表
   */
  function loadDatasources() {
    if (vscode) {
      vscode.postMessage({
        command: "getDatasources",
      });
    }
  }

  /**
   * 加载数据库列表
   */
  function loadDatabases(datasourceName) {
    if (vscode) {
      vscode.postMessage({
        command: "getDatabases",
        datasource: datasourceName,
      });
    }
  }

  /**
   * 绑定事件
   */
  function bindEvents() {
    // 保存按钮
    $("#btnSaveNotebook").on("click", function () {
      saveNotebookAs();
    });

    // 添加 Cell 按钮
    $("#btnAddCell").on("click", function () {
      addCell();
    });

    // 添加保存快捷键 Ctrl+S / Cmd+S
    $(document).on("keydown", function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveNotebookAs();
        return false;
      }
    });

    // 数据源选择变化（使用原生 change 事件，避免 Layui 的 CSP 问题）
    $("#datasourceSelect").on("change", function () {
      const datasourceName = $(this).val();
      if (datasourceName) {
        currentDatasource = datasourceName;
        currentDatabase = null; // 清空当前数据库选择
        // 先禁用并清空数据库选择器
        const $dbSelect = $("#databaseSelect");
        $dbSelect.prop("disabled", true);
        $dbSelect.html('<option value="">加载中...</option>');
        // 加载数据库列表
        loadDatabases(datasourceName);
      } else {
        currentDatasource = null;
        currentDatabase = null;
        const $dbSelect = $("#databaseSelect");
        $dbSelect.prop("disabled", true);
        $dbSelect.html('<option value="">选择数据库</option>');
      }
      // 自动更新文档
      autoSaveNotebook();
    });

    // 数据库选择变化（使用原生 change 事件）
    $("#databaseSelect").on("change", function () {
      currentDatabase = $(this).val();
      if (currentDatabase && currentDatasource) {
        // 加载当前数据库的表和字段信息
        loadDatabaseSchema(currentDatasource, currentDatabase);
      }
      // 自动更新文档
      autoSaveNotebook();
    });

    // 监听来自 VSCode 的消息
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || !message.command) {
        return;
      }

      switch (message.command) {
        case "datasourcesList":
          updateDatasourcesList(message.datasources);
          break;
        case "databasesList":
          updateDatabasesList(message.databases);
          break;
        case "databaseSchema":
          updateDatabaseSchema(message.schema);
          break;
        case "editorConfig":
          updateEditorConfig(message.config);
          break;
        case "loadNotebook":
          loadNotebook(message.data);
          break;
        case "saveNotebookSuccess":
          layer.msg("保存成功", { icon: 1 });
          break;
        case "saveNotebookError":
          layer.msg("保存失败: " + (message.error || "未知错误"), { icon: 2 });
          break;
        case "queryResult":
          handleQueryResult(message.cellId, message.result);
          break;
        case "queryError":
          handleQueryError(message.cellId, message.error);
          break;
      }
    });
  }

  /**
   * 更新数据源列表
   */
  function updateDatasourcesList(datasourcesList) {
    datasources = datasourcesList || [];
    const $select = $("#datasourceSelect");
    $select.html('<option value="">选择数据源</option>');
    datasources.forEach((ds) => {
      $select.append(
        $("<option>")
          .attr("value", ds.name)
          .text(ds.label || ds.name)
      );
    });
    // 不使用 Layui 的 form.render，避免 CSP 问题
  }

  /**
   * 更新数据库列表
   */
  function updateDatabasesList(databasesList) {
    databases = databasesList || [];
    const $select = $("#databaseSelect");

    if (databases.length === 0) {
      $select.html('<option value="">无可用数据库</option>');
      $select.prop("disabled", true);
      return;
    }

    // 清空并填充选项
    $select.html('<option value="">选择数据库</option>');
    databases.forEach((db) => {
      $select.append(
        $("<option>")
          .attr("value", db.name)
          .text(db.label || db.name)
      );
    });

    // 启用数据库选择器（使用原生 DOM 操作确保生效）
    const selectElement = $select[0];
    if (selectElement) {
      selectElement.disabled = false;
    }
    $select.prop("disabled", false);
    $select.removeAttr("disabled");

    // 不使用 Layui 的 form.render，避免 CSP 问题
  }

  /**
   * 添加新的 SQL Cell
   */
  function addCell() {
    cellCounter++;
    const cellId = `cell-${cellCounter}`;
    const cellHtml = `
      <div class="sql-cell" id="${cellId}" data-cell-id="${cellId}">
        <div class="cell-toolbar">
          <button class="cell-btn cell-btn-run" title="运行 (Shift+Enter)">
            <i class="layui-icon layui-icon-play"></i> 运行
          </button>
          <button class="cell-btn cell-btn-clear" title="清除结果">
            <i class="layui-icon layui-icon-delete"></i> 清除
          </button>
          <button class="cell-btn cell-btn-delete" title="删除 Cell">
            <i class="layui-icon layui-icon-close"></i> 删除
          </button>
        </div>
        <div class="cell-input">
          <div class="sql-editor-container" id="${cellId}-editor"></div>
        </div>
        <div class="cell-output" style="display: none;">
          <div class="output-loading" style="display: none;">
            <i class="layui-icon layui-icon-loading layui-anim layui-anim-rotate layui-anim-loop"></i>
            <span>执行中...</span>
          </div>
          <div class="output-error" style="display: none;"></div>
          <div class="output-table"></div>
          <div class="output-info"></div>
        </div>
      </div>
    `;

    const $cell = $(cellHtml);
    $("#notebookContainer").append($cell);

    // 初始化 cell 数据
    cellDataMap.set(cellId, { sql: "", result: null, error: null });

    // 初始化 Monaco Editor
    initMonacoEditor(cellId, $cell);

    // 绑定 Cell 事件
    bindCellEvents($cell, cellId);

    // 自动更新文档
    autoSaveNotebook();
  }

  /**
   * 初始化 Monaco Editor
   */
  function initMonacoEditor(cellId, $cell, initialValue = "") {
    const editorContainer = document.getElementById(`${cellId}-editor`);
    if (!editorContainer) {
      return;
    }

    // 检查 require 是否可用
    if (typeof require === "undefined") {
      console.warn("Monaco Editor loader 未加载，使用 textarea 后备方案");
      const $textarea = $("<textarea>")
        .addClass("sql-textarea")
        .attr("placeholder", "输入 SQL 语句...")
        .val(initialValue || "")
        .css({
          width: "100%",
          minHeight: "120px",
          padding: "8px",
          border: "1px solid var(--vscode-input-border, #3c3c3c)",
          backgroundColor: "var(--vscode-input-background, #3c3c3c)",
          color: "var(--vscode-input-foreground, #cccccc)",
          fontFamily: editorConfig.fontFamily,
          fontSize: `${editorConfig.fontSize}px`,
          lineHeight: editorConfig.lineHeight,
          resize: "vertical",
          borderRadius: "2px",
        });
      $(editorContainer).replaceWith($textarea);
      return;
    }

    // 配置 Monaco Editor
    try {
      if (!monacoBasePath) {
        throw new Error("无法获取 Monaco Editor 路径");
      }

      // 构建完整的 vs 路径
      const vsPath = `${monacoBasePath}/monaco-editor/min/vs`;

      console.log("Monaco Editor 基础路径:", monacoBasePath);
      console.log("Monaco Editor vs 路径:", vsPath);

      // 确保 require 已加载
      if (typeof require === "undefined" || !require.config) {
        throw new Error("Monaco Editor loader 未正确加载");
      }

      require.config({
        paths: {
          vs: vsPath,
        },
        // 添加错误处理
        onError: function (err) {
          console.error("Monaco Editor require 错误:", err);
        },
      });

      // 配置 Web Worker
      window.MonacoEnvironment = {
        getWorkerUrl: function (moduleId, label) {
          if (label === "sql") {
            return `${monacoBasePath}/monaco-editor/min/vs/language/sql/sql.worker.js`;
          }
          return `${monacoBasePath}/monaco-editor/min/vs/base/worker/workerMain.js`;
        },
      };

      require(["vs/editor/editor.main"], function () {
        console.log("Monaco Editor 主模块加载成功");
        const editor = monaco.editor.create(editorContainer, {
          value: initialValue || "",
          language: "sql",
          theme: "vs-dark",
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: editorConfig.fontSize,
          lineNumbers: "on",
          roundedSelection: false,
          scrollbar: {
            vertical: "auto",
            horizontal: "auto",
          },
          wordWrap: "on",
          suggestOnTriggerCharacters: true,
          quickSuggestions: true,
          acceptSuggestionOnEnter: "on",
          fontFamily: editorConfig.fontFamily,
          lineHeight: editorConfig.lineHeight,
        });

        // 注册 SQL 语言补全提供者
        monaco.languages.registerCompletionItemProvider("sql", {
          provideCompletionItems: function (model, position) {
            const suggestions = [];

            // 添加 SQL 关键字
            sqlKeywords.forEach((keyword) => {
              suggestions.push({
                label: keyword,
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: keyword,
                documentation: `SQL 关键字: ${keyword}`,
                detail: "关键字",
              });
            });

            // 添加表和字段补全
            if (currentDatabase) {
              currentTables.forEach((table) => {
                suggestions.push({
                  label: table.name,
                  kind: monaco.languages.CompletionItemKind.Class,
                  insertText: table.name,
                  documentation: `表: ${table.name}`,
                  detail: "[表]",
                });
              });

              // 获取当前行的文本，尝试提取表名
              const textUntilPosition = model.getValueInRange({
                startLineNumber: 1,
                startColumn: 1,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
              });

              // 简单的表名提取（FROM 或 JOIN 后面）
              const fromMatch = textUntilPosition.match(
                /(?:FROM|JOIN)\s+(\w+)/i
              );
              if (fromMatch) {
                const tableName = fromMatch[1];
                const columns = currentColumns.get(tableName) || [];
                columns.forEach((column) => {
                  suggestions.push({
                    label: column.name,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: column.name,
                    documentation: `字段: ${column.name} (${column.type})`,
                    detail: `[字段] ${tableName}`,
                  });
                });
              } else {
                // 如果没有明确的表名，显示所有表的字段
                currentColumns.forEach((columns, tableName) => {
                  columns.forEach((column) => {
                    suggestions.push({
                      label: `${tableName}.${column.name}`,
                      kind: monaco.languages.CompletionItemKind.Field,
                      insertText: `${tableName}.${column.name}`,
                      documentation: `字段: ${column.name} (${column.type})`,
                      detail: `[字段] ${tableName}`,
                    });
                  });
                });
              }
            }

            return { suggestions: suggestions };
          },
        });

        // 存储编辑器实例
        monacoEditors.set(cellId, editor);

        // 快捷键：Shift+Enter 运行
        editor.addCommand(
          monaco.KeyMod.Shift | monaco.KeyCode.Enter,
          function () {
            executeCell($cell, cellId);
          }
        );
      }, function (err) {
        // require 加载失败的回调
        console.error("Monaco Editor 模块加载失败:", err);
        console.error("错误详情:", err);
        if (err && err.requireModules) {
          console.error("失败的模块:", err.requireModules);
        }
        // 使用 textarea 作为后备
        const $textarea = $("<textarea>")
          .addClass("sql-textarea")
          .attr("placeholder", "输入 SQL 语句...")
          .val(initialValue || "")
          .css({
            width: "100%",
            minHeight: "120px",
            padding: "8px",
            border: "1px solid var(--vscode-input-border, #3c3c3c)",
            backgroundColor: "var(--vscode-input-background, #3c3c3c)",
            color: "var(--vscode-input-foreground, #cccccc)",
            fontFamily: editorConfig.fontFamily,
            fontSize: `${editorConfig.fontSize}px`,
            lineHeight: editorConfig.lineHeight,
            resize: "vertical",
            borderRadius: "2px",
          });
        $(editorContainer).replaceWith($textarea);
      });
    } catch (error) {
      console.error("Monaco Editor 初始化失败:", error);
      // 使用 textarea 作为后备
      const $textarea = $("<textarea>")
        .addClass("sql-textarea")
        .attr("placeholder", "输入 SQL 语句...")
        .val(initialValue || "")
        .css({
          width: "100%",
          minHeight: "120px",
          padding: "8px",
          border: "1px solid var(--vscode-input-border, #3c3c3c)",
          backgroundColor: "var(--vscode-input-background, #3c3c3c)",
          color: "var(--vscode-input-foreground, #cccccc)",
          fontFamily: editorConfig.fontFamily,
          fontSize: `${editorConfig.fontSize}px`,
          lineHeight: editorConfig.lineHeight,
          resize: "vertical",
          borderRadius: "2px",
        });
      $(editorContainer).replaceWith($textarea);
    }
  }

  /**
   * 绑定 Cell 事件
   */
  function bindCellEvents($cell, cellId) {
    const $runBtn = $cell.find(".cell-btn-run");
    const $clearBtn = $cell.find(".cell-btn-clear");
    const $deleteBtn = $cell.find(".cell-btn-delete");
    const $output = $cell.find(".cell-output");

    // 运行按钮
    $runBtn.on("click", function () {
      executeCell($cell, cellId);
    });

    // 清除按钮
    $clearBtn.on("click", function () {
      $output.hide();
      $output.find(".output-table").empty();
      $output.find(".output-error").hide().empty();
      $output.find(".output-info").empty();
    });

    // 删除按钮
    $deleteBtn.on("click", function () {
      const editor = monacoEditors.get(cellId);
      if (editor) {
        editor.dispose();
        monacoEditors.delete(cellId);
      }
      cellDataMap.delete(cellId);
      $cell.fadeOut(300, function () {
        $(this).remove();
        // 自动更新文档
        autoSaveNotebook();
      });
    });

    // 监听 SQL 内容变化（Monaco Editor）
    const editor = monacoEditors.get(cellId);
    if (editor) {
      editor.onDidChangeModelContent(() => {
        // 延迟更新，避免频繁触发
        clearTimeout(window[`saveTimeout_${cellId}`]);
        window[`saveTimeout_${cellId}`] = setTimeout(() => {
          autoSaveNotebook();
        }, 500);
      });
    } else {
      // 监听 textarea 内容变化
      const $textarea = $cell.find(".sql-textarea");
      if ($textarea.length) {
        $textarea.on("input", function () {
          clearTimeout(window[`saveTimeout_${cellId}`]);
          window[`saveTimeout_${cellId}`] = setTimeout(() => {
            autoSaveNotebook();
          }, 500);
        });
      }
    }
  }

  /**
   * 执行 SQL Cell
   */
  function executeCell($cell, cellId) {
    const editor = monacoEditors.get(cellId);
    let sql = "";
    if (editor) {
      sql = editor.getValue().trim();
    } else {
      // 后备方案：从 textarea 获取
      const $textarea = $cell.find(".sql-textarea");
      if ($textarea.length) {
        sql = $textarea.val().trim();
      }
    }
    if (!sql) {
      layer.msg("请输入 SQL 语句", { icon: 0 });
      return;
    }

    if (!currentDatasource || !currentDatabase) {
      layer.msg("请先选择数据源和数据库", { icon: 0 });
      return;
    }

    const $output = $cell.find(".cell-output");
    const $loading = $output.find(".output-loading");
    const $error = $output.find(".output-error");
    const $table = $output.find(".output-table");
    const $info = $output.find(".output-info");

    // 显示输出区域
    $output.show();

    // 显示加载状态
    $loading.show();
    $error.hide().empty();
    $table.empty();
    $info.empty();

    // 发送执行请求
    if (vscode) {
      vscode.postMessage({
        command: "executeSql",
        cellId: cellId,
        sql: sql,
        datasource: currentDatasource,
        database: currentDatabase,
      });
    }
  }

  /**
   * 处理查询结果
   */
  function handleQueryResult(cellId, result) {
    const $cell = $(`#${cellId}`);
    if ($cell.length === 0) {
      return;
    }

    const $output = $cell.find(".cell-output");
    const $loading = $output.find(".output-loading");
    const $error = $output.find(".output-error");
    const $table = $output.find(".output-table");
    const $info = $output.find(".output-info");

    $loading.hide();
    $output.show();

    if (result.error) {
      // 显示错误
      $error
        .html(
          `<div class="error-message"><i class="layui-icon layui-icon-close-fill"></i> ${result.error}</div>`
        )
        .show();
      $table.empty();
      $info.empty();
    } else {
      // 显示结果表格
      $error.hide();
      displayResultTable($table, result);
      displayResultInfo($info, result);
    }
  }

  /**
   * 处理查询错误
   */
  function handleQueryError(cellId, error) {
    const $cell = $(`#${cellId}`);
    if ($cell.length === 0) {
      return;
    }

    const $output = $cell.find(".cell-output");
    const $loading = $output.find(".output-loading");
    const $error = $output.find(".output-error");
    const $table = $output.find(".output-table");
    const $info = $output.find(".output-info");

    $loading.hide();
    $error
      .html(
        `<div class="error-message"><i class="layui-icon layui-icon-close-fill"></i> ${error}</div>`
      )
      .show();
    $table.empty();
    $info.empty();

    // 保存错误数据
    if (!cellDataMap.has(cellId)) {
      cellDataMap.set(cellId, { sql: "", result: null, error: null });
    }
    const cellData = cellDataMap.get(cellId);
    cellData.error = error;
    cellData.result = null;
    cellDataMap.set(cellId, cellData);

    // 自动更新文档
    autoSaveNotebook();
  }

  /**
   * 显示结果表格
   */
  function displayResultTable($container, result) {
    if (!result.columns || !result.data) {
      $container.html('<div class="no-data">无数据</div>');
      return;
    }

    const columns = result.columns;
    const data = result.data;

    if (data.length === 0) {
      $container.html('<div class="no-data">查询成功，但无数据返回</div>');
      return;
    }

    // 创建表格 HTML
    let html = '<table class="layui-table result-table">';

    // 表头
    html += "<thead><tr>";
    columns.forEach((col) => {
      html += `<th>${escapeHtml(col.name || col)}</th>`;
    });
    html += "</tr></thead>";

    // 表体
    html += "<tbody>";
    data.forEach((row) => {
      html += "<tr>";
      columns.forEach((col) => {
        const colName = col.name || col;
        const value =
          row[colName] !== null && row[colName] !== undefined
            ? String(row[colName])
            : "";
        html += `<td>${escapeHtml(value)}</td>`;
      });
      html += "</tr>";
    });
    html += "</tbody></table>";

    $container.html(html);
  }

  /**
   * 显示结果信息
   */
  function displayResultInfo($container, result) {
    const rowCount = result.rowCount || (result.data ? result.data.length : 0);
    const executionTime = result.executionTime || 0;
    const timeStr =
      executionTime < 0.001 ? "<0.001s" : `${executionTime.toFixed(3)}s`;

    $container.html(
      `<div class="result-info">
        <span class="info-item"><i class="layui-icon layui-icon-chart"></i> ${rowCount} 行</span>
        <span class="info-item"><i class="layui-icon layui-icon-time"></i> ${timeStr}</span>
      </div>`
    );
  }

  /**
   * 加载数据库的表和字段信息
   */
  function loadDatabaseSchema(datasourceName, databaseName) {
    if (vscode) {
      vscode.postMessage({
        command: "getDatabaseSchema",
        datasource: datasourceName,
        database: databaseName,
      });
    }
  }

  /**
   * 更新数据库架构信息
   */
  function updateDatabaseSchema(schema) {
    currentTables = schema.tables || [];
    currentColumns.clear();

    if (schema.columns) {
      schema.columns.forEach((item) => {
        if (!currentColumns.has(item.table)) {
          currentColumns.set(item.table, []);
        }
        currentColumns.get(item.table).push({
          name: item.column,
          type: item.type || "",
        });
      });
    }
  }

  /**
   * 更新编辑器配置
   */
  function updateEditorConfig(config) {
    if (config) {
      editorConfig = {
        fontFamily: config.fontFamily || editorConfig.fontFamily,
        fontSize: config.fontSize || editorConfig.fontSize,
        lineHeight: config.lineHeight || editorConfig.lineHeight,
      };

      // 更新所有已存在的编辑器实例
      monacoEditors.forEach((editor) => {
        editor.updateOptions({
          fontSize: editorConfig.fontSize,
          fontFamily: editorConfig.fontFamily,
          lineHeight: editorConfig.lineHeight,
        });
      });

      // 更新所有 textarea 后备方案
      $(".sql-textarea").css({
        fontFamily: editorConfig.fontFamily,
        fontSize: `${editorConfig.fontSize}px`,
        lineHeight: editorConfig.lineHeight,
      });

      console.log("编辑器配置已更新:", editorConfig);
    }
  }

  /**
   * 自动保存 Notebook（更新文档内容，但不自动保存文件）
   */
  function autoSaveNotebook() {
    const cells = [];

    // 收集所有 cell 的数据
    $(".sql-cell").each(function () {
      const $cell = $(this);
      const cellId = $cell.attr("id");
      if (!cellId) {
        return;
      }

      // 获取 SQL 语句
      let sql = "";
      const editor = monacoEditors.get(cellId);
      if (editor) {
        sql = editor.getValue();
      } else {
        const $textarea = $cell.find(".sql-textarea");
        if ($textarea.length) {
          sql = $textarea.val();
        }
      }

      // 从 cellDataMap 获取保存的结果和错误
      const savedData = cellDataMap.get(cellId) || {
        sql: "",
        result: null,
        error: null,
      };

      const cellData = {
        id: cellId,
        sql: sql || "",
      };

      // 更新保存的 SQL
      savedData.sql = sql;
      cellDataMap.set(cellId, savedData);

      // 如果有错误
      if (savedData.error) {
        cellData.error = savedData.error;
      }
      // 如果有结果
      else if (savedData.result) {
        cellData.result = savedData.result;
      }

      cells.push(cellData);
    });

    // 构建 notebook 数据
    const notebookData = {
      datasource: currentDatasource,
      database: currentDatabase,
      cells: cells,
    };

    // 发送更新请求（更新文档内容，但不自动保存文件）
    if (vscode) {
      vscode.postMessage({
        command: "updateNotebook",
        data: notebookData,
      });
    }
  }

  /**
   * 加载 Notebook
   */
  function loadNotebook(data) {
    if (!data) {
      return;
    }

    // 清空现有 cells
    $("#notebookContainer").empty();
    monacoEditors.forEach((editor) => {
      editor.dispose();
    });
    monacoEditors.clear();
    cellCounter = 0;

    // 恢复数据源和数据库选择
    if (data.datasource) {
      currentDatasource = data.datasource;
      $("#datasourceSelect").val(data.datasource).trigger("change");

      // 等待数据库列表加载后再选择数据库
      setTimeout(() => {
        if (data.database) {
          currentDatabase = data.database;
          $("#databaseSelect").val(data.database).trigger("change");
        }
      }, 500);
    }

    // 恢复 cells
    if (data.cells && Array.isArray(data.cells)) {
      data.cells.forEach((cellData) => {
        cellCounter++;
        const cellId = cellData.id || `cell-${cellCounter}`;
        const cellHtml = `
          <div class="sql-cell" id="${cellId}" data-cell-id="${cellId}">
            <div class="cell-toolbar">
              <button class="cell-btn cell-btn-run" title="运行 (Shift+Enter)">
                <i class="layui-icon layui-icon-play"></i> 运行
              </button>
              <button class="cell-btn cell-btn-clear" title="清除结果">
                <i class="layui-icon layui-icon-delete"></i> 清除
              </button>
              <button class="cell-btn cell-btn-delete" title="删除 Cell">
                <i class="layui-icon layui-icon-close"></i> 删除
              </button>
            </div>
            <div class="cell-input">
              <div class="sql-editor-container" id="${cellId}-editor"></div>
            </div>
            <div class="cell-output" style="display: none;">
              <div class="output-loading" style="display: none;">
                <i class="layui-icon layui-icon-loading layui-anim layui-anim-rotate layui-anim-loop"></i>
                <span>执行中...</span>
              </div>
              <div class="output-error" style="display: none;"></div>
              <div class="output-table"></div>
              <div class="output-info"></div>
            </div>
          </div>
        `;

        const $cell = $(cellHtml);
        $("#notebookContainer").append($cell);

        // 初始化编辑器并设置 SQL
        initMonacoEditor(cellId, $cell, cellData.sql || "");

        // 如果有结果或错误，恢复显示
        if (cellData.result) {
          setTimeout(() => {
            handleQueryResult(cellId, cellData.result);
          }, 100);
        } else if (cellData.error) {
          setTimeout(() => {
            handleQueryError(cellId, cellData.error);
          }, 100);
        }

        // 绑定事件
        bindCellEvents($cell, cellId);
      });
    } else {
      // 如果没有 cells，添加一个空的
      addCell();
    }
  }

  /**
   * 保存 Notebook 为文件（从 WebviewPanel）
   */
  function saveNotebookAs() {
    const cells = [];
    
    // 收集所有 cell 的数据
    $(".sql-cell").each(function() {
      const $cell = $(this);
      const cellId = $cell.attr("id");
      if (!cellId) return;
      
      // 获取 SQL 语句
      let sql = "";
      const editor = monacoEditors.get(cellId);
      if (editor) {
        sql = editor.getValue();
      } else {
        const $textarea = $cell.find(".sql-textarea");
        if ($textarea.length) {
          sql = $textarea.val();
        }
      }
      
      // 从 cellDataMap 获取保存的结果和错误
      const savedData = cellDataMap.get(cellId) || { sql: "", result: null, error: null };
      
      const cellData = {
        id: cellId,
        sql: sql || ""
      };
      
      // 如果有错误
      if (savedData.error) {
        cellData.error = savedData.error;
      }
      // 如果有结果
      else if (savedData.result) {
        cellData.result = savedData.result;
      }
      
      cells.push(cellData);
    });
    
    // 构建 notebook 数据
    const notebookData = {
      datasource: currentDatasource,
      database: currentDatabase,
      cells: cells
    };
    
    // 发送保存请求（WebviewPanel 另存为）
    if (vscode) {
      vscode.postMessage({
        command: "saveNotebookAs",
        data: notebookData
      });
    }
  }

  /**
   * HTML 转义
   */
  function escapeHtml(text) {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return String(text).replace(/[&<>"']/g, (m) => map[m]);
  }

  // 初始化
  init();
  
  // 暴露函数以便调试
  window.saveNotebookAs = saveNotebookAs;

  // 通知 VSCode 页面已准备好
  if (vscode) {
    vscode.postMessage({
      command: "ready",
    });
  }
});
