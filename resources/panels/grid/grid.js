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

  let tableMeta = { connectionName: "", databaseName: "", tableName: "" };
  let hideMatchedFields = false;
  let userColumnVisibility = new Map();

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
    switchToTableEdit: () => {
      if (tableMeta.connectionName && tableMeta.databaseName && tableMeta.tableName) {
        vscode?.postMessage({
          command: "switchToTableEdit",
          connectionName: tableMeta.connectionName,
          databaseName: tableMeta.databaseName,
          tableName: tableMeta.tableName,
        });
      }
    },
    quickQuery: () => {
      if (tableMeta.connectionName && tableMeta.databaseName && tableMeta.tableName) {
        vscode?.postMessage({
          command: "quickQuery",
          connectionName: tableMeta.connectionName,
          databaseName: tableMeta.databaseName,
          tableName: tableMeta.tableName,
        });
      }
    },
    clearFieldSearch: () => {
      const input = document.getElementById("grid-field-search");
      if (input) {
        input.value = "";
        input.focus();
      }
      applyFieldSearch();
    },
    toggleFieldSearch: () => {
      hideMatchedFields = !hideMatchedFields;
      updateFieldSearchToggleUI();
      applyFieldSearch();
    },
    toggleSidePanel: () => {
      const body = document.body;
      const panel = document.getElementById("grid-side-panel");
      const tab = document.querySelector(".grid-side-panel__tab");
      const toggleBtn = document.querySelector(".grid-side-panel__toggle");
      const collapsed = body.classList.toggle("grid-side-panel-collapsed");
      if (tab) {
        tab.setAttribute("aria-expanded", String(!collapsed));
        tab.title = collapsed ? "展开侧边面板" : "收起侧边面板";
      }
      if (toggleBtn) toggleBtn.title = collapsed ? "展开面板" : "收起面板";
      try {
        localStorage.setItem("cadb.grid.sidePanelCollapsed", collapsed ? "1" : "0");
      } catch (_) {}
    },
  };

  // 侧边面板：恢复展开/收起与宽度
  (function initSidePanel() {
    const body = document.body;
    const panel = document.getElementById("grid-side-panel");
    const resizer = document.querySelector("[data-resizer]");
    const STORAGE_KEY_COLLAPSED = "cadb.grid.sidePanelCollapsed";
    const STORAGE_KEY_WIDTH = "cadb.grid.sidePanelWidth";

    try {
      const collapsed = localStorage.getItem(STORAGE_KEY_COLLAPSED);
      if (collapsed === "1") {
        body.classList.add("grid-side-panel-collapsed");
        const tab = document.querySelector(".grid-side-panel__tab");
        const toggleBtn = document.querySelector(".grid-side-panel__toggle");
        if (tab) {
          tab.setAttribute("aria-expanded", "false");
          tab.title = "展开侧边面板";
        }
        if (toggleBtn) toggleBtn.title = "展开面板";
      } else {
        const tab = document.querySelector(".grid-side-panel__tab");
        const toggleBtn = document.querySelector(".grid-side-panel__toggle");
        if (tab) {
          tab.setAttribute("aria-expanded", "true");
          tab.title = "收起侧边面板";
        }
        if (toggleBtn) toggleBtn.title = "收起面板";
      }
      const w = localStorage.getItem(STORAGE_KEY_WIDTH);
      if (panel && w) {
        const num = parseInt(w, 10);
        if (num >= 180 && num <= 2000) panel.style.width = num + "px";
      }
    } catch (_) {}

    if (resizer && panel) {
      let startX = 0;
      let startWidth = 0;
      resizer.addEventListener("mousedown", function (e) {
        e.preventDefault();
        startX = e.clientX;
        startWidth = panel.offsetWidth;
        const minW = 180;
        const maxW = Math.max(minW, Math.floor(window.innerWidth * 0.5));

        function move(ev) {
          const dx = startX - ev.clientX;
          let w = startWidth + dx;
          w = Math.max(minW, Math.min(maxW, w));
          panel.style.width = w + "px";
        }
        function up() {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          try {
            localStorage.setItem(STORAGE_KEY_WIDTH, String(panel.offsetWidth));
          } catch (_) {}
        }
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });
    }
  })();

  /** 根据当前表格列刷新侧边栏「字段」列表 */
  function refreshColumnList() {
    const listEl = document.getElementById("grid-column-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    const emptyEl = document.getElementById("grid-column-list-empty");
    const columns = dbTable.columns || [];
    columns.forEach((col) => {
      const field = col.field;
      if (field == null || String(field).trim() === "") return;
      if (!shouldIncludeField(field, col)) return;
      const headerName = col.headerName != null ? col.headerName : String(field);
      const visible = userColumnVisibility.has(field)
        ? !!userColumnVisibility.get(field)
        : (typeof dbTable.getColumnVisible === "function" ? dbTable.getColumnVisible(field) : true);
      const li = document.createElement("li");
      li.innerHTML = `
        <label>
          <input type="checkbox" data-field="${escapeHtml(field)}" ${visible ? "checked" : ""}>
          <span class="grid-side-panel__column-name" title="${escapeHtml(headerName)}">${escapeHtml(headerName)}</span>
        </label>`;
      listEl.appendChild(li);
    });
    if (emptyEl) {
      if (listEl.childElementCount === 0) {
        emptyEl.textContent = "暂无可显示字段";
      } else {
        emptyEl.textContent = "暂无列数据，请先加载表格。";
      }
    }
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  // 侧边栏字段列表：点击复选框时同步表格列显隐
  document.getElementById("grid-column-list")?.addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-field]');
    if (!cb) return;
    const field = cb.getAttribute("data-field");
    if (!field) return;
    userColumnVisibility.set(field, cb.checked);
    applyFieldSearch();
  });

  document.getElementById("grid-field-search")?.addEventListener("input", () => {
    applyFieldSearch();
  });
  document.getElementById("grid-field-search")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      actions.toggleFieldSearch();
    }
  });

  function updateFieldSearchToggleUI() {
    const btn = document.querySelector('[data-action="toggleFieldSearch"]');
    const icon = btn?.querySelector(".codicon");
    if (icon) {
      icon.classList.toggle("codicon-eye", !hideMatchedFields);
      icon.classList.toggle("codicon-eye-closed", hideMatchedFields);
    }
    if (btn) {
      const q = getSearchQuery();
      if (!q) {
        btn.title = hideMatchedFields ? "隐藏所有字段" : "显示所有字段";
        btn.setAttribute("aria-label", hideMatchedFields ? "隐藏所有字段" : "显示所有字段");
      } else {
        btn.title = hideMatchedFields ? "隐藏匹配字段" : "显示匹配字段";
        btn.setAttribute("aria-label", hideMatchedFields ? "隐藏匹配字段" : "显示匹配字段");
      }
    }
  }

  function normalizeText(v) {
    return String(v ?? "").toLowerCase();
  }

  function updateClearButtonUI() {
    const input = document.getElementById("grid-field-search");
    const btn = document.querySelector('[data-action="clearFieldSearch"]');
    if (!btn) return;
    const hasValue = !!(input && String(input.value ?? "").trim());
    btn.classList.toggle("is-hidden", !hasValue);
  }

  function getSearchQuery() {
    const input = document.getElementById("grid-field-search");
    return input ? String(input.value ?? "").trim() : "";
  }

  function shouldIncludeField(field, col) {
    const q = getSearchQuery();
    if (!q) return true;
    const needle = normalizeText(q);
    const fieldName = normalizeText(field);
    const headerName = normalizeText(col?.headerName ?? "");
    const matched = fieldName.includes(needle) || headerName.includes(needle);
    return hideMatchedFields ? !matched : matched;
  }

  function applyFieldSearch() {
    const columns = dbTable.columns || [];
    if (!Array.isArray(columns) || columns.length === 0) {
      refreshColumnList();
      updateClearButtonUI();
      return;
    }

    if (userColumnVisibility.size === 0) {
      columns.forEach((col) => {
        const field = col.field;
        if (field == null || String(field).trim() === "") return;
        userColumnVisibility.set(field, true);
      });
    }

    const state = [];
    const q = getSearchQuery();
    if (!q) {
      const visibleAll = !hideMatchedFields;
      columns.forEach((col) => {
        const field = col.field;
        if (field == null || String(field).trim() === "") return;
        userColumnVisibility.set(field, visibleAll);
        state.push({ colId: field, hide: !visibleAll });
      });
    } else {
    columns.forEach((col) => {
      const field = col.field;
      if (field == null || String(field).trim() === "") return;
      const manualVisible = userColumnVisibility.has(field) ? !!userColumnVisibility.get(field) : true;
      const matchVisible = shouldIncludeField(field, col);
      const visible = manualVisible && matchVisible;
      state.push({ colId: field, hide: !visible });
    });
    }

    try {
      if (dbTable.gridApi && typeof dbTable.gridApi.applyColumnState === "function") {
        dbTable.gridApi.applyColumnState({ state, applyOrder: false });
      } else {
        state.forEach((s) => dbTable.setColumnVisible(s.colId, !s.hide));
      }
    } catch (_) {}

    refreshColumnList();
    updateClearButtonUI();
  }

  // 工具栏事件委托
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    e.preventDefault();
    const action = actions[btn.dataset.action];
    if (action) action();
  });

  // VSCode 消息
  window.addEventListener("message", (event) => {
    const { command } = event.data || {};
    const payload = event.data?.data != null ? event.data.data : event.data;

    if (command === "load") {
      tableMeta = {
        connectionName: payload?.connectionName ?? "",
        databaseName: payload?.databaseName ?? "",
        tableName: payload?.tableName ?? "",
      };
      const hasMeta = tableMeta.connectionName && tableMeta.databaseName && tableMeta.tableName;
      document.querySelectorAll("[data-action=switchToTableEdit], [data-action=quickQuery]").forEach((el) => {
        el.style.display = hasMeta ? "" : "none";
      });
      const columnDefs = payload?.columnDefs;
      const rowData = Array.isArray(payload?.rowData) ? payload.rowData : [];
      if (!columnDefs?.length) return;
      const options =
        payload?.pageSize != null
          ? { pageSize: payload.pageSize, offset: payload.offset ?? 0 }
          : undefined;
      dbTable.init(columnDefs, rowData, payload?.queryTime ?? 0, options);
      dbTable.updatePaginationUI?.();
      userColumnVisibility = new Map();
      updateFieldSearchToggleUI();
      setTimeout(() => {
        applyFieldSearch();
      }, 0);
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
