/**
 * Grid 页面 - 数据表格视图
 * 负责工具栏、分页与消息通信
 */
(function () {
  const vscode = window.vscode || (typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null);

  const dbTable = new DatabaseTableData({
    tableSelector: "#grid",
    vscode: vscode,
  });

  const $ = (sel, root = document) => root.querySelector(sel);

  const actions = {
    save: () => {
      const changed = dbTable.getChangedRows();
      const deleted = dbTable.getDeletedRows?.() ?? [];
      if (changed.length === 0 && deleted.length === 0) {
        vscode?.postMessage({ command: "status", success: false, message: "没有需要保存的修改" });
        return;
      }
      const primaryKeyField = dbTable.getPrimaryKeyField?.() ?? undefined;
      vscode?.postMessage({ command: "save", data: changed, deleted, primaryKeyField });
    },
    refresh: () =>
      vscode?.postMessage({
        command: "refresh",
        offset: dbTable.getDataOffset?.() ?? 0,
      }),
    add: () => dbTable.addRow(),
    delete: () => dbTable.deleteRow(),
    undo: () => dbTable.undo(),
    redo: () => dbTable.redo(),
    "prev-page": () => !$("#btn-prev-page")?.disabled && dbTable.prevPage(),
    "next-page": () => !$("#btn-next-page")?.disabled && dbTable.nextPage(),
    upload: () => {},
    download: () => {},
    "export-csv": () => dbTable.exportCSV(),
    "export-xlsx": () => dbTable.exportXLSX(),
    "export-json": () => dbTable.exportJSON(),
  };

  // 工具栏事件委托
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = actions[btn.dataset.action];
    if (action) action();
  });

  // VSCode 消息
  window.addEventListener("message", (event) => {
    const { command } = event.data || {};
    const payload = event.data?.data != null ? event.data.data : event.data;

    if (command === "load") {
      const columnDefs = payload?.columnDefs;
      const rowData = Array.isArray(payload?.rowData) ? payload.rowData : [];
      if (!columnDefs?.length) return;
      const options =
        payload?.pageSize != null
          ? { pageSize: payload.pageSize, offset: payload.offset ?? 0 }
          : undefined;
      dbTable.init(columnDefs, rowData, payload?.queryTime ?? 0, options);
      dbTable.updatePaginationUI?.();
      return;
    }

    if (command === "status") {
      const { message, success } = payload ?? event.data ?? {};
      const msg = message ?? (success ? "操作完成" : "操作失败");
      if (success) {
        window.showSuccessMessage?.(msg);
        dbTable.refreshTable();
      } else {
        if (typeof window.showErrorMessage === "function") {
          window.showErrorMessage(msg);
        } else {
          vscode?.postMessage({ command: "showMessage", type: "error", message: msg });
        }
      }
    }
  });

  if (vscode) vscode.postMessage({ command: "ready" });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && vscode) {
      vscode.postMessage({ command: "ready" });
    }
  });

  window.dbTable = dbTable;
})();
