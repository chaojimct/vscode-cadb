// 页面初始化
$(function () {
  // 获取 VSCode API
  let vscode = null;
  if (window.vscode) {
    vscode = window.vscode;
  } else {
    vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  }

  // 初始化数据表格（筛选与排序使用 Tabulator 内置 Filtering/Sorting）
  const dbTable = new DatabaseTableData({
    tableSelector: "#grid",
    vscode: vscode,
  });

  // 筛选栏：字段 / 类型 / 值 / 清除（参考 Tabulator setFilter）
  const filterFieldEl = document.getElementById("filter-field");
  const filterTypeEl = document.getElementById("filter-type");
  const filterValueEl = document.getElementById("filter-value");

  function updateFilter() {
    const field = filterFieldEl.value;
    const type = filterTypeEl.value;
    const value = filterValueEl.value.trim();
    if (field) {
      dbTable.setFilter(field, type, value);
    } else {
      dbTable.clearFilter();
    }
  }

  function clearFilterInputs() {
    filterFieldEl.value = "";
    filterTypeEl.value = "=";
    filterValueEl.value = "";
    dbTable.clearFilter();
  }

  if (filterFieldEl) filterFieldEl.addEventListener("change", updateFilter);
  if (filterTypeEl) filterTypeEl.addEventListener("change", updateFilter);
  if (filterValueEl) filterValueEl.addEventListener("keyup", updateFilter);
  document.getElementById("filter-clear").addEventListener("click", clearFilterInputs);

  // 排序栏：字段 / 方向 / 执行排序（参考 Tabulator setSort）
  const sortFieldEl = document.getElementById("sort-field");
  const sortDirEl = document.getElementById("sort-direction");
  document.getElementById("sort-trigger").addEventListener("click", function () {
    const field = sortFieldEl.options[sortFieldEl.selectedIndex].value;
    const dir = sortDirEl.options[sortDirEl.selectedIndex].value;
    if (field) {
      dbTable.setSort(field, dir);
    }
  });

  // 绑定按钮事件
  $("#btn-add").on("click", dbTable.addRow);
  $("#btn-refresh").on("click", () => {
    if (vscode) {
      vscode.postMessage({ command: "refresh" });
    }
  });
  $("#btn-delete").on("click", dbTable.deleteRow);
  $("#history-undo").on("click", function () {
    dbTable.undo();
  });
  $("#history-redo").on("click", function () {
    dbTable.redo();
  });
  $("#btn-upload").on("click", function () {
    // 上传功能暂未实现
  });
  $("#btn-download").on("click", function () {
    // 下载功能暂未实现
  });
  $("#btn-export-csv").on("click", dbTable.exportCSV);
  $("#btn-export-xlsx").on("click", dbTable.exportXLSX);
  $("#btn-export-json").on("click", dbTable.exportJSON);

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
      if (!data || !data.columnDefs) {
        return;
      }
      dbTable.init(data.columnDefs, data.rowData, data.queryTime, data.totalCount);
      // 填充筛选字段下拉
      const fieldSelect = document.getElementById("filter-field");
      if (fieldSelect && data.columnDefs.length) {
        const emptyOpt = fieldSelect.querySelector('option[value=""]');
        fieldSelect.innerHTML = "";
        if (emptyOpt) fieldSelect.appendChild(emptyOpt);
        data.columnDefs.forEach((col) => {
          const opt = document.createElement("option");
          opt.value = col.field;
          opt.textContent = col.field;
          fieldSelect.appendChild(opt);
        });
      }
      // 填充排序字段下拉
      const sortFieldSelect = document.getElementById("sort-field");
      if (sortFieldSelect && data.columnDefs.length) {
        const emptyOpt = sortFieldSelect.querySelector('option[value=""]');
        sortFieldSelect.innerHTML = "";
        if (emptyOpt) sortFieldSelect.appendChild(emptyOpt);
        data.columnDefs.forEach((col, i) => {
          const opt = document.createElement("option");
          opt.value = col.field;
          opt.textContent = col.field;
          sortFieldSelect.appendChild(opt);
          if (i === 0) opt.selected = true;
        });
      }
    } else if (command === "loadPage") {
      if (data) {
        dbTable.setPageData(data);
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

  // 通知扩展：页面已就绪，可发送初始数据（避免 postMessage 早于脚本执行导致第二次打开无数据）
  if (vscode) {
    vscode.postMessage({ command: "ready" });
  }

  // 面板再次被切回可见时也发送 ready，让扩展重新下发数据（解决第二次打开/切回该表时无数据的问题）
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && vscode) {
      vscode.postMessage({ command: "ready" });
    }
  });

  // 暴露到全局
  window.dbTable = dbTable;
});
