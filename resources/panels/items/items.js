(function () {
  let vscode = null;
  if (window.vscode) {
    vscode = window.vscode;
  } else {
    vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  }

  const dbTable = new DatabaseTableData({
    tableSelector: "#grid",
    vscode: vscode,
  });

  window.addEventListener("message", (event) => {
    const { command, data } = event.data || {};
    if (command === "load") {
      dbTable.init(
        data.columnDefs || [],
        data.rowData || [],
        data.queryTime || 0
      );
    } else if (command === "status") {
      if (data && data.success) {
        dbTable.refreshTable();
      }
    }
  });

  window.dbTable = dbTable;
})(); 

