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

  // 当前数据库的表和字段信息（保留用于未来可能的代码提示功能）
  let currentTables = [];
  let currentColumns = new Map(); // tableName -> columns[]

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
    // 添加 Cell 按钮
    $("#btnAddCell").on("click", function () {
      addCell();
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
    });

    // 数据库选择变化（使用原生 change 事件）
    $("#databaseSelect").on("change", function () {
      currentDatabase = $(this).val();
      if (currentDatabase && currentDatasource) {
        // 加载当前数据库的表和字段信息
        loadDatabaseSchema(currentDatasource, currentDatabase);
      }
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
          <textarea
            class="sql-textarea"
            id="${cellId}-textarea"
            placeholder="输入 SQL 语句..."
            rows="5"
          ></textarea>
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

    // 绑定 Cell 事件
    bindCellEvents($cell, cellId);

    // 自动聚焦到新 Cell 的输入框
    $cell.find(".sql-textarea").focus();
  }

  /**
   * 绑定 Cell 事件
   */
  function bindCellEvents($cell, cellId) {
    const $textarea = $cell.find(".sql-textarea");
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
      $cell.fadeOut(300, function () {
        $(this).remove();
      });
    });

    // 快捷键：Shift+Enter 运行
    $textarea.on("keydown", function (e) {
      if (e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        executeCell($cell, cellId);
      }
    });
  }

  /**
   * 执行 SQL Cell
   */
  function executeCell($cell, cellId) {
    const $textarea = $cell.find(".sql-textarea");
    const sql = $textarea.val().trim();
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

    if (result.error) {
      // 显示错误
      $error
        .html(`<div class="error-message"><i class="layui-icon layui-icon-close-fill"></i> ${result.error}</div>`)
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
      .html(`<div class="error-message"><i class="layui-icon layui-icon-close-fill"></i> ${error}</div>`)
      .show();
    $table.empty();
    $info.empty();
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
        const value = row[colName] !== null && row[colName] !== undefined 
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
    const timeStr = executionTime < 0.001 
      ? "<0.001s" 
      : `${executionTime.toFixed(3)}s`;

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
          type: item.type || ""
        });
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

  // 通知 VSCode 页面已准备好
  if (vscode) {
    vscode.postMessage({
      command: "ready",
    });
  }
});

