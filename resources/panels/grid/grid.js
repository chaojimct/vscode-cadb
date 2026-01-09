// 页面初始化
$(function () {
  // 获取 VSCode API
  let vscode = null;
  if (window.vscode) {
    vscode = window.vscode;
  } else {
    vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  }

  // 初始化数据表格
  const dbTable = new DatabaseTableData({
    tableSelector: "#grid",
    vscode: vscode,
  });

  // 初始化 SQL 输入增强
  let whereInput, orderByInput;

  const initSQLInputs = (fields = []) => {
    // WHERE 输入框
    whereInput = new SQLInput("#input-where", {
      onEnter: applyFilter,
      fields: fields,
      keywords: [
        "AND",
        "OR",
        "NOT",
        "IN",
        "BETWEEN",
        "LIKE",
        "IS",
        "NULL",
        "TRUE",
        "FALSE",
        "EXISTS",
        "ANY",
        "ALL",
        "=",
        "!=",
        "<>",
        "<",
        ">",
        "<=",
        ">=",
        "COUNT",
        "SUM",
        "AVG",
        "MAX",
        "MIN",
        "UPPER",
        "LOWER",
        "LENGTH",
        "TRIM",
      ],
    });

    // ORDER BY 输入框
    orderByInput = new SQLInput("#input-orderby", {
      onEnter: applyFilter,
      fields: fields,
      keywords: ["ASC", "DESC", "NULLS", "FIRST", "LAST"],
    });
  };

  // 更新字段列表
  const updateSQLInputFields = (fields) => {
    if (whereInput) {
      whereInput.options.fields = fields;
    }
    if (orderByInput) {
      orderByInput.options.fields = fields;
    }
  };

  // 应用过滤
  const applyFilter = () => {
    if (!whereInput || !orderByInput) {
      console.warn("请等待数据加载完成");
      return;
    }

    const whereClause = whereInput.getValue();
    const orderByClause = orderByInput.getValue();

    // 应用过滤到表格
    dbTable.applyFilter(whereClause, orderByClause);
  };

  // 注意：SQL 输入会在数据加载时自动初始化（见 message 监听器）

  // 绑定按钮事件
  $("#btn-add").on("click", dbTable.addRow);
  $("#btn-refresh").on("click", () => {
    dbTable.refreshTable();
    // 清空过滤条件
    if (whereInput) {
      whereInput.clear();
    }
    if (orderByInput) {
      orderByInput.clear();
    }
  });
  $("#btn-delete").on("click", dbTable.deleteRow);
  $("#btn-export-csv").on("click", dbTable.exportCSV);
  $("#btn-export-json").on("click", dbTable.exportJSON);
  $("#btn-export-sql").on("click", dbTable.exportSQL);

  // 保存按钮
  $("#btn-save").on("click", () => {
    const changedRows = dbTable.getChangedRows();
    if (changedRows.length === 0) {
      if (vscode) {
        vscode.postMessage({
          command: "status",
          success: false,
          message: "没有需要保存的修改",
        });
      }
      return;
    }

    if (vscode) {
      vscode.postMessage({
        command: "save",
        data: changedRows,
      });
    }
  });

  // 监听来自 VSCode 的消息
  window.addEventListener("message", (event) => {
    const { command, data } = event.data;

    if (command === "load") {
      dbTable.init(data.columnDefs, data.rowData, data.queryTime);

      // 提取字段名称并更新到 SQL 输入组件
      const fields = data.columnDefs.map((col) => col.field);

      // 如果 SQL 输入还未初始化，先初始化
      if (!whereInput || !orderByInput) {
        initSQLInputs(fields);
      } else {
        // 否则更新字段列表
        updateSQLInputFields(fields);
      }
    } else if (command === "status") {
      const message = data.message || (data.success ? "操作完成" : "操作失败");
      if (data.success) {
        // 可以在这里添加成功提示，比如显示一个临时提示框
        if (window.showSuccessMessage) {
          window.showSuccessMessage(message);
        }
      } else {
        console.error('✗', message);
        // 可以在这里添加错误提示
        if (window.showErrorMessage) {
          window.showErrorMessage(message);
        } else {
          alert(message);
        }
      }
      // 如果保存成功，清除修改标记
      if (data.success && command === "status") {
        dbTable.refreshTable();
      }
    }
  });

  // 暴露到全局
  window.dbTable = dbTable;
});
