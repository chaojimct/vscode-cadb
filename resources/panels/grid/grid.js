/**
 * Grid 页面 - 数据表格视图
 * 负责工具栏、分页与消息通信
 */
(function () {
  const vscode = window.vscode || (typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null);

  const dbTable = new DatabaseTableData({
    tableSelector: "#grid",
    vscode: vscode,
    cellCtrlClickPreview: true,
    onCellPreviewRequest: () => {
      ensureSidePanelOpenForPreview();
      activateGridSideTab("preview");
      const metaEl = document.getElementById("grid-preview-meta");
      const bodyEl = document.getElementById("grid-preview-body");
      if (metaEl) {
        metaEl.textContent = "正在请求预览…";
      }
      if (bodyEl) {
        bodyEl.innerHTML = "";
        const p = document.createElement("p");
        p.className = "grid-preview-panel__loading";
        p.textContent = "已识别内容类型，正在向扩展校验预览插件…";
        bodyEl.appendChild(p);
      }
    },
  });

  const $ = (sel, root = document) => root.querySelector(sel);

  /** 同步 document.title（仅表名）与分页区表名标签（悬停全路径：连接 / 数据库 / 表） */
  function applyGridDocumentTitle(meta) {
    const c = meta && String(meta.connectionName ?? "").trim();
    const d = meta && String(meta.databaseName ?? "").trim();
    const t = meta && String(meta.tableName ?? "").trim();
    const labelEl = document.getElementById("grid-toolbar-table-label");
    const labelTextEl = labelEl?.querySelector?.(".grid-toolbar__table-name-text");
    if (c && d && t) {
      document.title = t;
      if (labelEl) {
        if (labelTextEl) {
          labelTextEl.textContent = t;
        } else {
          labelEl.textContent = t;
        }
        const fullPath = `${c} / ${d} / ${t}`;
        /* 不用原生 title（系统延迟长），全路径由 CSS attr(data-path) 即时提示 */
        labelEl.removeAttribute("title");
        labelEl.setAttribute("data-path", fullPath);
        labelEl.setAttribute("aria-label", `当前表 ${t}，全路径 ${fullPath}`);
      }
    } else {
      document.title = "数据表格";
      if (labelEl) {
        if (labelTextEl) {
          labelTextEl.textContent = "";
        } else {
          labelEl.textContent = "";
        }
        labelEl.removeAttribute("title");
        labelEl.removeAttribute("data-path");
        labelEl.removeAttribute("aria-label");
      }
    }
  }

  let tableMeta = { connectionName: "", databaseName: "", tableName: "" };
  let hideMatchedFields = false;
  let userColumnVisibility = new Map();

  const lastPointer = { x: 120, y: 120 };
  document.addEventListener(
    "pointermove",
    (ev) => {
      lastPointer.x = ev.clientX;
      lastPointer.y = ev.clientY;
    },
    true
  );

  let copyFormatPopupCleanup = null;

  function closeCopyFormatPopup() {
    if (typeof copyFormatPopupCleanup === "function") {
      copyFormatPopupCleanup();
      copyFormatPopupCleanup = null;
    }
  }

  /**
   * 复制快捷键触发的浮动菜单：TSV / JSON / INSERT（贴近指针）
   */
  function showGridCopyFormatPopup(clientX, clientY) {
    closeCopyFormatPopup();
    const x = typeof clientX === "number" && clientX > 0 ? clientX : lastPointer.x;
    const y = typeof clientY === "number" && clientY > 0 ? clientY : lastPointer.y;

    const root = document.createElement("div");
    root.id = "grid-copy-format-popup";
    root.className = "grid-copy-format-popup";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "选择复制格式");
    root.innerHTML =
      '<div class="grid-copy-format-popup__title">复制为</div>' +
      '<div class="grid-copy-format-popup__buttons">' +
      '<button type="button" class="grid-copy-format-popup__btn" data-copy-format="tsv">TSV</button>' +
      '<button type="button" class="grid-copy-format-popup__btn" data-copy-format="json">JSON</button>' +
      '<button type="button" class="grid-copy-format-popup__btn" data-copy-format="insert">Insert</button>' +
      "</div>";
    document.body.appendChild(root);

    const onDocPointerDown = (ev) => {
      if (!root.contains(ev.target)) {
        closeCopyFormatPopup();
      }
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        closeCopyFormatPopup();
      }
    };

    copyFormatPopupCleanup = () => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
      root.remove();
    };

    setTimeout(() => {
      document.addEventListener("pointerdown", onDocPointerDown, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);

    const pad = 10;
    const placePopup = () => {
      const rect = root.getBoundingClientRect();
      let left = x + pad;
      let top = y + pad;
      if (left + rect.width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - rect.width - 8);
      }
      if (top + rect.height > window.innerHeight - 8) {
        top = Math.max(8, y - rect.height - pad);
      }
      root.style.left = left + "px";
      root.style.top = top + "px";
    };
    placePopup();
    requestAnimationFrame(placePopup);

    root.querySelectorAll("[data-copy-format]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const fmt = btn.getAttribute("data-copy-format");
        const sqlCtx = {
          tableName: tableMeta.tableName,
          databaseName: tableMeta.databaseName,
        };
        dbTable.copyRowsToClipboard(fmt, sqlCtx).then((res) => {
          closeCopyFormatPopup();
          if (res.ok || !vscode) {
            return;
          }
          const msg =
            res.reason === "no-selection"
              ? "请先选中行，或单击某个单元格后再复制"
              : res.reason === "no-columns"
                ? "当前没有可复制的数据列"
                : "复制到剪贴板失败";
          vscode.postMessage({ command: "showMessage", type: "warning", message: msg });
        });
      });
    });

    const firstBtn = root.querySelector("[data-copy-format]");
    if (firstBtn instanceof HTMLElement) {
      firstBtn.focus();
    }
  }

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
        filterModel: dbTable.getFilterModelForServer?.() ?? {},
        sortModel: dbTable.getSortModelForServer?.() ?? [],
      }),
    add: () => dbTable.addRow(),
    delete: () => dbTable.deleteRow(),
    undo: () => dbTable.undo(),
    redo: () => dbTable.redo(),
    "first-page": () => !$("#btn-first-page")?.disabled && dbTable.firstPage(),
    "prev-page": () => !$("#btn-prev-page")?.disabled && dbTable.prevPage(),
    "next-page": () => !$("#btn-next-page")?.disabled && dbTable.nextPage(),
    upload: () => {},
    download: () => {},
    "export-csv": () => dbTable.exportCSV(),
    "copy-table-ddl": () => {
      if (tableMeta.connectionName && tableMeta.databaseName && tableMeta.tableName) {
        vscode?.postMessage({
          command: "copyTableDdl",
          connectionName: tableMeta.connectionName,
          databaseName: tableMeta.databaseName,
          tableName: tableMeta.tableName,
        });
      } else {
        vscode?.postMessage({
          command: "showMessage",
          type: "warning",
          message: "未加载表信息，无法获取 DDL",
        });
      }
    },
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
      const q = getSearchQuery();
      if (!q) {
        const columns = dbTable.columns || [];
        const visibleAll = !hideMatchedFields;
        columns.forEach((col) => {
          const field = col.field;
          if (field == null || String(field).trim() === "") return;
          userColumnVisibility.set(field, visibleAll);
        });
      }
      applyFieldSearch();
    },
    toggleSidePanel: () => {
      const body = document.body;
      const panel = document.getElementById("grid-side-panel");
      const tab = document.querySelector(".grid-side-panel__tab");
      const toggleBtn = document.querySelector(".grid-side-panel__toggle");
      const wasCollapsed = body.classList.contains("grid-side-panel-collapsed");
      const collapsed = body.classList.toggle("grid-side-panel-collapsed");
      if (tab) {
        tab.setAttribute("aria-expanded", String(!collapsed));
        tab.title = collapsed ? "展开侧边面板" : "收起侧边面板";
      }
      if (toggleBtn) toggleBtn.title = collapsed ? "展开面板" : "收起面板";
      try {
        localStorage.setItem("cadb.grid.sidePanelCollapsed", collapsed ? "1" : "0");
      } catch (_) {}
      // 从收起变为展开：聚焦「搜索字段」输入框（快捷键/点击标签打开侧栏后可直接输入）
      if (wasCollapsed && !collapsed) {
        focusFieldSearchInputDeferred();
      }
      // 从展开变为收起：焦点回到表格，避免 Webview 焦点落到工作台导致 Ctrl+F 无效
      if (!wasCollapsed && collapsed) {
        focusGridAreaDeferred();
      }
    },
  };

  // 侧边面板：恢复展开/收起与宽度（宽度由 style.width 控制，CSS 使用 flex:0 0 auto）
  (function initSidePanel() {
    const body = document.body;
    const panel = document.getElementById("grid-side-panel");
    const resizer = document.querySelector("[data-resizer]");
    const STORAGE_KEY_COLLAPSED = "cadb.grid.sidePanelCollapsed";
    const STORAGE_KEY_WIDTH = "cadb.grid.sidePanelWidth";

    function sidePanelWidthBounds() {
      const minW = 180;
      const maxW = Math.max(minW, Math.floor(window.innerWidth * 0.5));
      return { minW, maxW };
    }

    function applySidePanelWidthPx(px) {
      if (!panel) return;
      const { minW, maxW } = sidePanelWidthBounds();
      const w = Math.max(minW, Math.min(maxW, Math.round(px)));
      panel.style.width = w + "px";
    }

    try {
      const collapsed = localStorage.getItem(STORAGE_KEY_COLLAPSED);
      // 默认收起；仅当用户曾明确选择展开（存为 "0"）时才展开
      const showPanel = collapsed === "0";
      const tab = document.querySelector(".grid-side-panel__tab");
      const toggleBtn = document.querySelector(".grid-side-panel__toggle");
      if (showPanel) {
        body.classList.remove("grid-side-panel-collapsed");
        if (tab) {
          tab.setAttribute("aria-expanded", "true");
          tab.title = "收起侧边面板";
        }
        if (toggleBtn) toggleBtn.title = "收起面板";
      } else {
        body.classList.add("grid-side-panel-collapsed");
        if (tab) {
          tab.setAttribute("aria-expanded", "false");
          tab.title = "展开侧边面板";
        }
        if (toggleBtn) toggleBtn.title = "展开面板";
      }
      const w = localStorage.getItem(STORAGE_KEY_WIDTH);
      if (panel && w) {
        const num = parseInt(w, 10);
        if (!Number.isNaN(num)) applySidePanelWidthPx(num);
      }
    } catch (_) {}

    if (resizer && panel) {
      let startX = 0;
      let startWidth = 0;

      function endResize() {
        body.classList.remove("is-resizing-side-panel");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        try {
          localStorage.setItem(STORAGE_KEY_WIDTH, String(panel.offsetWidth));
        } catch (_) {}
      }

      resizer.addEventListener("mousedown", function (e) {
        if (body.classList.contains("grid-side-panel-collapsed")) return;
        if (e.button !== 0) return;
        e.preventDefault();
        startX = e.clientX;
        startWidth = panel.offsetWidth;
        body.classList.add("is-resizing-side-panel");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";

        function move(ev) {
          const dx = startX - ev.clientX;
          let w = startWidth + dx;
          const { minW, maxW } = sidePanelWidthBounds();
          w = Math.max(minW, Math.min(maxW, w));
          panel.style.width = w + "px";
        }
        function up() {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          endResize();
        }
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });
    }

    window.addEventListener(
      "resize",
      function () {
        if (!panel || body.classList.contains("grid-side-panel-collapsed")) return;
        applySidePanelWidthPx(panel.offsetWidth);
      },
      { passive: true }
    );
  })();

  /** 侧栏展开后聚焦搜索框（等布局稳定再 focus，避免被 transition 抢焦点） */
  function focusFieldSearchInputDeferred() {
    const run = () => {
      const input = document.getElementById("grid-field-search");
      if (!input || document.body.classList.contains("grid-side-panel-collapsed")) return;
      try {
        input.focus({ preventScroll: true });
      } catch (_) {
        input.focus();
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  }

  /** 侧栏收起后将焦点移回表格（优先 AG Grid 单元格，否则 #grid），保持 Webview 可接收键盘快捷键 */
  function focusGridAreaDeferred() {
    const run = () => {
      const api = dbTable && dbTable.gridApi;
      let focused = false;
      if (api && typeof api.setFocusedCell === "function") {
        try {
          const cols = dbTable.columns || [];
          const first = cols.find((c) => {
            const f = c.field;
            return f != null && String(f).trim() !== "" && f !== "__cadb_rownum__";
          });
          const rowCount =
            typeof api.getDisplayedRowCount === "function" ? api.getDisplayedRowCount() : 0;
          if (first && rowCount > 0) {
            api.setFocusedCell(0, first.field);
            focused = true;
          }
        } catch (_) {
          /* 忽略 */
        }
      }
      if (!focused) {
        const gridEl = document.getElementById("grid");
        if (gridEl) {
          try {
            gridEl.focus({ preventScroll: true });
          } catch (_) {
            gridEl.focus();
          }
        }
      }
      if (vscode) {
        vscode.postMessage({ command: "gridPanelDomFocus" });
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  }

  /** 当前选中的侧栏 Tab：fields | preview */
  function getActiveGridSideTab() {
    const btn = document.querySelector(".grid-side-panel__tab-btn.is-active");
    const t = btn && btn.getAttribute("data-tab");
    return t === "preview" ? "preview" : "fields";
  }

  /** 侧栏 Tab：字段 / 预览 */
  function activateGridSideTab(tabName) {
    document.querySelectorAll(".grid-side-panel__tab-btn").forEach((btn) => {
      const t = btn.getAttribute("data-tab");
      const active = t === tabName;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("[data-tab-content]").forEach((panel) => {
      const t = panel.getAttribute("data-tab-content");
      const on = t === tabName;
      panel.classList.toggle("is-hidden", !on);
      if (on) {
        panel.removeAttribute("hidden");
      } else {
        panel.setAttribute("hidden", "");
      }
    });
  }

  function ensureSidePanelOpenForPreview() {
    if (document.body.classList.contains("grid-side-panel-collapsed")) {
      actions.toggleSidePanel();
    }
  }

  document.querySelector(".grid-side-panel__tabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".grid-side-panel__tab-btn[data-tab]");
    if (!btn) {
      return;
    }
    e.preventDefault();
    const tab = btn.getAttribute("data-tab");
    if (tab) {
      activateGridSideTab(tab);
    }
  });

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
      return;
    }
    // Escape：由 document 捕获阶段统一处理（字段 Tab 清空过滤或收起侧栏；预览 Tab 直接收起）
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
    columns.forEach((col) => {
      const field = col.field;
      if (field == null || String(field).trim() === "") return;
      const manualVisible = userColumnVisibility.has(field) ? !!userColumnVisibility.get(field) : true;
      const matchVisible = q ? shouldIncludeField(field, col) : true;
      const visible = manualVisible && matchVisible;
      state.push({ colId: field, hide: !visible });
    });

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

  /**
   * 右侧工具栏：Windows/Linux 为 Ctrl+F，macOS 为 ⌘F 切换显示；Escape 在侧栏展开时收起或清空字段过滤（预览 Tab 不判断过滤框）。
   * 捕获阶段优先于 AG Grid；单元格编辑（contenteditable）内不抢 Escape，以便先结束编辑。
   */
  document.addEventListener(
    "keydown",
    function (e) {
      if (e.key === "Escape") {
        if (document.body.classList.contains("grid-side-panel-collapsed")) {
          return;
        }
        const el = e.target;
        if (el instanceof HTMLElement) {
          if (el.isContentEditable) {
            return;
          }
          const tag = el.tagName;
          if (
            (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") &&
            el.id !== "grid-field-search"
          ) {
            return;
          }
        }
        if (getActiveGridSideTab() === "preview") {
          e.preventDefault();
          e.stopPropagation();
          actions.toggleSidePanel();
          return;
        }
        const q = getSearchQuery();
        if (q) {
          e.preventDefault();
          e.stopPropagation();
          const input = document.getElementById("grid-field-search");
          if (input) input.value = "";
          applyFieldSearch();
          updateClearButtonUI();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        actions.toggleSidePanel();
        return;
      }

      /** Windows/Linux：Ctrl+C / Ctrl+V；macOS：Cmd+C / Cmd+V；复制时弹出格式菜单 */
      const keyLower = e.key;
      const isCopyKey = keyLower === "c" || keyLower === "C";
      const isPasteKey = keyLower === "v" || keyLower === "V";
      if (
        (isCopyKey || isPasteKey) &&
        typeof DatabaseTableData !== "undefined" &&
        DatabaseTableData.primaryModifierActive(e)
      ) {
        const el = e.target;
        if (el instanceof HTMLElement) {
          if (el.isContentEditable) {
            return;
          }
          const tag = el.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
            // 行选择列为原生 checkbox，焦点在其上时仍需响应复制（不要求先点数据单元格）
            const isRowSelectionCheckbox =
              isCopyKey &&
              tag === "INPUT" &&
              String(el.getAttribute("type") || "").toLowerCase() === "checkbox" &&
              !!(el.closest &&
                (el.closest("#grid") || el.closest(".ag-root-wrapper") || el.closest(".ag-root")));
            if (!isRowSelectionCheckbox) {
              return;
            }
          }
        }
        if (isCopyKey) {
          e.preventDefault();
          e.stopPropagation();
          showGridCopyFormatPopup(e.clientX, e.clientY);
          return;
        }
        if (isPasteKey) {
          e.preventDefault();
          e.stopPropagation();
          dbTable.pasteClipboardTsvAtFocusedCell().then((res) => {
            if (res.ok || !vscode) {
              return;
            }
            if (res.reason === "empty-clipboard") {
              return;
            }
            const msg =
              res.reason === "clipboard-read-failed"
                ? "无法读取剪贴板，请检查权限"
                : res.reason === "no-columns"
                  ? "当前没有可粘贴的数据列"
                  : "粘贴失败";
            vscode.postMessage({ command: "showMessage", type: "warning", message: msg });
          });
          return;
        }
      }

      if (e.key !== "f" && e.key !== "F") {
        return;
      }
      if (typeof DatabaseTableData === "undefined" || !DatabaseTableData.primaryModifierActive(e)) {
        return;
      }
      const el = e.target;
      if (el instanceof HTMLElement) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) {
          return;
        }
      }
      e.preventDefault();
      e.stopPropagation();
      actions.toggleSidePanel();
    },
    true
  );

  // VSCode 消息
  window.addEventListener("message", (event) => {
    const { command } = event.data || {};
    const payload = event.data?.data != null ? event.data.data : event.data;

    if (command === "toggleSidePanel") {
      actions.toggleSidePanel();
      return;
    }

    if (command === "load") {
      tableMeta = {
        connectionName: payload?.connectionName ?? "",
        databaseName: payload?.databaseName ?? "",
        tableName: payload?.tableName ?? "",
      };
      applyGridDocumentTitle(tableMeta);
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
      activateGridSideTab("fields");
      setTimeout(() => {
        applyFieldSearch();
      }, 0);
      return;
    }

    if (command === "showCellPreview") {
      const data = event.data || {};
      ensureSidePanelOpenForPreview();
      activateGridSideTab("preview");
      const render = typeof window !== "undefined" && window.CadbGridPreviewRender;
      if (render && typeof render.applyPreviewMessage === "function") {
        render.applyPreviewMessage({
          metaEl: document.getElementById("grid-preview-meta"),
          bodyEl: document.getElementById("grid-preview-body"),
          success: !!data.success,
          message: data.message,
          pluginId: data.pluginId,
          dataFormatLabel: data.dataFormatLabel,
          columnField: data.columnField,
          rawValue: data.rawValue,
        });
      }
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
      vscode.postMessage({ command: "gridPanelDomFocus" });
    }
  });

  // 同步扩展侧上下文 cadb.datasourceTableGridFocused（兼容）；侧栏切换由本页 keydown ⌘F/Ctrl+F 处理
  window.addEventListener(
    "focus",
    () => {
      if (vscode) vscode.postMessage({ command: "gridPanelDomFocus" });
    },
    true
  );

  window.dbTable = dbTable;
})();
