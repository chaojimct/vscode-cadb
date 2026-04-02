/**
 * Grid 页面 - 数据表格视图
 * 使用 AG Grid Community 进行数据渲染
 */

class DatabaseTableData {
  /**
   * 与桌面惯例一致：Windows / Linux 使用 Ctrl；macOS 使用 Command(⌘)。
   */
  static primaryModifierActive(e) {
    if (!e) {
      return false;
    }
    const mac =
      typeof navigator !== "undefined" &&
      (/Mac|iPhone|iPad|iPod/i.test(navigator.platform || "") ||
        /Mac OS X/i.test(navigator.userAgent || ""));
    return mac ? !!e.metaKey : !!e.ctrlKey;
  }

  constructor(options) {
    this.tableSelector = options.tableSelector;
    this.vscode = options.vscode || null;
    /** 为 true 时：Ctrl/Cmd+点击单元格可向扩展请求侧栏预览（由 grid 页启用） */
    this.cellCtrlClickPreview = !!options.cellCtrlClickPreview;
    /**
     * 返回 true 时必须在点击同时按住主修饰键（Ctrl / ⌘）才触发预览；
     * false 时普通单击即可触发（由 grid 页在「侧栏展开且预览 Tab」时设为 false）
     */
    this.cellPreviewRequiresModifier =
      typeof options.cellPreviewRequiresModifier === "function" ? options.cellPreviewRequiresModifier : null;
    /** 发起 cellPreview 消息前回调（用于展开侧栏、切换预览 Tab） */
    this.onCellPreviewRequest =
      typeof options.onCellPreviewRequest === "function" ? options.onCellPreviewRequest : null;

    this.newRow = {};
    this.gridApi = null;
    this.tableData = [];
    this.columns = [];
    this.changedRows = new Map(); // row node id -> { original, current }
    this.originalData = new Map(); // row index -> original row
    this.queryTime = 0;
    this.paginationSize = 2000;
    /** 服务端分页：当前偏移（LIMIT offset, pageSize） */
    this.dataOffset = 0;
    /** 是否使用服务端分页（由 load 传入 pageSize/offset 时启用） */
    this.serverPagination = false;
    this._serverReloadTimer = null;
    this._suppressServerQueryReload = false;
    this._pendingFilterModel = null;
    this._pendingColumnState = null;
    /** 避免首屏/恢复列状态时 onSortChanged、onFilterChanged 触发多余 loadPage */
    this._allowServerQueryReload = false;
    /** 最近一次单击的单元格所在行（用于 Webview 中无选中/无焦点时的 Ctrl+C 回退） */
    this._lastInteractedRowData = null;
  }

  /**
   * 日期/时间列展示：将服务端常见的 ISO 8601 转为本地可读格式（不影响单元格底层值）
   * @param {unknown} value
   * @param {boolean} includeTime 是否含时分秒（datetime / timestamp / time）
   * @param {string} [typeTrim] 列类型小写串，用于区分纯 TIME
   */
  static formatDateForDisplay(value, includeTime, typeTrim) {
    if (value == null || value === "") {
      return "";
    }
    const type = (typeTrim != null ? String(typeTrim) : "").toLowerCase().trim();
    const isTimeOnlyCol = /^time(\s|\(|$)/.test(type);
    let d;
    if (value instanceof Date) {
      d = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      d = new Date(value);
    } else {
      const s = String(value).trim();
      if (isTimeOnlyCol) {
        if (/^\d{1,3}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
          return s;
        }
      }
      d = new Date(s);
    }
    if (Number.isNaN(d.getTime())) {
      return String(value);
    }
    if (includeTime) {
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    }
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }

  /**
   * 初始化表格
   * @param {object} [options] - 可选，{ pageSize, offset } 存在时启用服务端分页
   */
  init(columns, data, queryTime, options) {
    this._lastInteractedRowData = null;
    this.columns = columns;
    this.tableData = data || [];
    this.queryTime = queryTime || 0;
    if (options && options.pageSize != null) {
      this.serverPagination = true;
      this.pageSize = options.pageSize;
      this.paginationSize = options.pageSize;
      this.dataOffset = options.offset ?? 0;
    } else {
      this.serverPagination = false;
      this.dataOffset = 0;
    }
    this.changedRows.clear();
    this.originalData.clear();
    (this.tableData || []).forEach((row, index) => {
      this.originalData.set(index, JSON.parse(JSON.stringify(row)));
    });
    this.columns.forEach((c) => {
      this.newRow[c.field] = c.defaultValue ?? "";
    });
    this._initGrid();
  }

  getDataOffset() {
    return this.dataOffset ?? 0;
  }

  /** 与列 valueFormatter 一致，供 Ctrl+预览将单元格值转为字符串 */
  cellValueToPreviewString(value, colId) {
    if (value == null) {
      return "";
    }
    if (typeof value === "object") {
      if (value.type === "Buffer" && Array.isArray(value.data)) {
        const hex = value.data
          .map((b) => String(Number(b).toString(16).padStart(2, "0")))
          .join("");
        return "0x" + hex.toUpperCase();
      }
      try {
        return JSON.stringify(value);
      } catch (_e) {
        return String(value);
      }
    }
    if (typeof value === "string" && colId) {
      const col = (this.columns || []).find((c) => c.field === colId);
      if (col) {
        const typeTrim = String(col.type != null ? col.type : "").toLowerCase().trim();
        if (/^(date|datetime|timestamp|time)(\s|\(|$)/.test(typeTrim)) {
          const includeTime = /^(datetime|timestamp|time)(\s|\(|$)/.test(typeTrim);
          return DatabaseTableData.formatDateForDisplay(value, includeTime, typeTrim);
        }
      }
    }
    return String(value);
  }

  /** 服务端分页时随请求带给扩展，用于生成 SQL WHERE */
  getFilterModelForServer() {
    if (!this.gridApi) return {};
    try {
      return this.gridApi.getFilterModel() || {};
    } catch (_e) {
      return {};
    }
  }

  getSortModelForServer() {
    if (!this.gridApi) return [];
    try {
      const allowed = new Set((this.columns || []).map((c) => c.field));
      const state = this.gridApi.getColumnState() || [];
      return state
        .filter((s) => s.sort && s.colId && allowed.has(s.colId))
        .map((s) => ({ colId: s.colId, sort: s.sort }));
    } catch (_e2) {
      return [];
    }
  }

  _scheduleServerReload(reason) {
    if (!this.serverPagination) return;
    if (this._suppressServerQueryReload) {
      return;
    }
    if (!this._allowServerQueryReload) {
      return;
    }
    clearTimeout(this._serverReloadTimer);
    const self = this;
    this._serverReloadTimer = setTimeout(() => {
      if (!self.serverPagination || !self.vscode || !self.gridApi) return;
      const fm = self.getFilterModelForServer();
      const sm = self.getSortModelForServer();
      self.vscode.postMessage({ command: "loadPage", offset: 0, filterModel: fm, sortModel: sm });
    }, 400);
  }

  _initGrid() {
    const container = document.querySelector(this.tableSelector);
    if (!container) return;

    let savedFilterModel = null;
    let savedColumnState = null;
    if (this.gridApi) {
      try {
        savedFilterModel = this.gridApi.getFilterModel();
      } catch (_e) {}
      try {
        savedColumnState = this.gridApi.getColumnState();
      } catch (_e2) {}
      this.gridApi.destroy();
      this.gridApi = null;
    }
    this._pendingFilterModel = savedFilterModel;
    this._pendingColumnState = savedColumnState;

    const self = this;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => self._doInitGrid(container));
    });
  }

  _doInitGrid(container) {
    const self = this;
    this._allowServerQueryReload = false;
    const columnDefs = this._buildColumnDefs();
    const rowData = this.tableData.map((r, i) => ({ ...r, __rowIndex: i }));

    const boundOnCellValueChanged = this._onCellValueChanged.bind(this);
    const boundUpdatePaginationUI = this.updatePaginationUI.bind(this);

    const gridOptions = {
      columnDefs,
      rowData,
      /** 表头 headerTooltip（字段备注）使用浏览器原生提示，无需企业版 Tooltip 模块 */
      enableBrowserTooltips: true,
      /** 列宽策略须挂在 gridOptions 根上；放在 defaultColDef 内无效 */
      autoSizeStrategy: {
        type: "fitCellContents",
        defaultMaxWidth: 150,
        defaultMinWidth: 80,
      },
      defaultColDef: {
        minWidth: 80,
        sortable: true,
        resizable: true,
        filter: true,
        filterParams: {
          buttons: ["apply", "clear"]
        },
        editable: true,
        valueFormatter: (params) => {
          const v = params.value;
          if (v == null) return "";
          if (typeof v === "object") {
            if (v.type === "Buffer" && Array.isArray(v.data)) {
              const hex = v.data.map((b) => String(b.toString(16).padStart(2, "0"))).join("");
              return "0x" + hex.toUpperCase();
            }
            return JSON.stringify(v);
          }
          return v;
        },
        valueParser: (params) => {
          const s = params.newValue;
          if (typeof s !== "string") return s;
          try {
            return JSON.parse(s);
          } catch {
            return s;
          }
        },
      },
      pagination: !this.serverPagination,
      paginationPageSize: this.paginationSize,
      paginationPageSizeSelector: false,
      /** 仅通过左侧复选框多选；单击单元格不勾选行（复制仍可用 getSelectedRows / 焦点行 / _lastInteractedRowData） */
      rowSelection: {
        mode: "multiRow",
        checkboxes: true,
        headerCheckbox: true,
        enableClickSelection: false,
      },
      selectionColumnDef: {
        sortable: false,
        resizable: false,
        suppressHeaderMenuButton: true,
        pinned: "left",
        lockPosition: true,
        lockPinned: true,
        width: 48,
        maxWidth: 56,
      },
      stopEditingWhenCellsLoseFocus: true,
      animateRows: false,
      getRowId: (params) => params.data.__rowIndex != null ? String(params.data.__rowIndex) : params.id,
      rowClassRules: {
        "grid-row-deleted": (params) => params.data?.__deleted === true,
        "grid-row-edited": (params) => params.data?.__edited === true && params.data?.__deleted !== true,
      },
      onCellValueChanged: boundOnCellValueChanged,
      onFilterChanged: () => {
        self._scheduleServerReload("filter");
      },
      onSortChanged: () => {
        self._scheduleServerReload("sort");
      },
      onGridReady: (e) => {
        self.gridApi = e.api;
        boundUpdatePaginationUI();
        const colState = self._pendingColumnState;
        const fm = self._pendingFilterModel;
        self._pendingColumnState = null;
        self._pendingFilterModel = null;
        queueMicrotask(() => {
          if (!self.gridApi) return;
          self._suppressServerQueryReload = true;
          try {
            if (colState && colState.length) {
              self.gridApi.applyColumnState({ state: colState, applyOrder: true });
            }
            if (fm && typeof fm === "object" && Object.keys(fm).length > 0) {
              self.gridApi.setFilterModel(fm);
            }
          } catch (_err) {
            /* 恢复列状态/过滤器失败时忽略 */
          }
          setTimeout(() => {
            self._suppressServerQueryReload = false;
            self._allowServerQueryReload = true;
          }, 220);
        });
      },
      onPaginationChanged: boundUpdatePaginationUI,
      onCellClicked: (e) => {
        if (e.data) {
          self._lastInteractedRowData = e.data;
        }
        if (!self.cellCtrlClickPreview || !self.vscode) {
          return;
        }
        const ev = e.event;
        const needsModifier =
          typeof self.cellPreviewRequiresModifier === "function"
            ? self.cellPreviewRequiresModifier()
            : true;
        if (needsModifier && (!ev || !DatabaseTableData.primaryModifierActive(ev))) {
          return;
        }
        if (!needsModifier && ev && ev.button !== 0) {
          return;
        }
        const colId = e.column?.getColId?.();
        if (!colId) {
          return;
        }
        const clickColDef = e.column?.getColDef?.();
        if (clickColDef && clickColDef.checkboxSelection) {
          return;
        }
        const det = typeof window !== "undefined" && window.CadbCellPreviewDetector;
        if (!det || typeof det.detectCellPreviewType !== "function") {
          return;
        }
        const val = e.data != null ? e.data[colId] : e.value;
        const str = self.cellValueToPreviewString(val, colId);
        const { pluginId, raw } = det.detectCellPreviewType(str);
        if (typeof self.onCellPreviewRequest === "function") {
          try {
            self.onCellPreviewRequest({ pluginId, rawValue: raw, columnField: colId });
          } catch (_e) {
            /* 忽略侧栏 UI 回调异常 */
          }
        }
        self.vscode.postMessage({
          command: "cellPreview",
          pluginId,
          rawValue: raw,
          columnField: colId,
        });
      },
    };

    if (typeof agGrid !== "undefined" && agGrid.createGrid) {
      agGrid.createGrid(container, gridOptions);
    }
  }

  _buildColumnDefs() {
    const defs = [];
    this.columns.forEach((c) => {
      const type = (c.type != null ? String(c.type) : "").toLowerCase();
      const typeTrim = type.trim();
      const isBit1 = /^bit\s*\(\s*1\s*\)$/.test(type) || (type.startsWith("bit") && type.includes("1"));
      const isBitN = /^bit\s*\(\s*\d+\s*\)$/.test(type) || (type.startsWith("bit") && !type.includes("1"));
      const isJsonType = /^json(\s|\(|$)/i.test(typeTrim);
      const isDateType = /^(date|datetime|timestamp|time)(\s|\(|$)/.test(typeTrim);
      const commentStr =
        c.comment != null && String(c.comment).trim() !== ""
          ? String(c.comment).trim()
          : "";
      const colDef = {
        field: c.field,
        headerName: (c.headerName != null ? c.headerName : c.field.toUpperCase()),
        ...(c.width != null ? { width: c.width } : {}),
        minWidth: c.minWidth != null ? c.minWidth : 80,
        ...(c.maxWidth != null ? { maxWidth: c.maxWidth } : {}),
        ...(commentStr ? { headerTooltip: commentStr } : {}),
        ...this._getFilterConfig(c, type),
        ...this._getComparatorConfig(c, type),
        // 透传 AG Grid 列扩展配置（如 cellEditor、cellEditorPopup 等）
        ...(c.cellEditor != null && {
          cellEditor: c.cellEditor,
          cellEditorPopup: c.cellEditorPopup != null ? c.cellEditorPopup : true,
        }),
      };
      if (isBit1) {
        colDef.cellRenderer = "agCheckboxCellRenderer";
        colDef.cellEditor = "agCheckboxCellEditor";
        colDef.valueGetter = (params) => {
          const v = params.data?.[c.field];
          if (v === true || v === 1) return true;
          if (v === false || v === 0) return false;
          if (v && typeof v === "object" && v[0] !== undefined) return !!v[0];
          return !!Number(v);
        };
        colDef.valueSetter = (params) => {
          if (params.data == null) return false;
          params.data[c.field] = params.newValue ? 1 : 0;
          return true;
        };
      }
      if (isBitN && !isBit1) {
        colDef.valueFormatter = (params) => {
          const v = params.value;
          if (v == null) return "";
          if (typeof v === "number") return String(v);
          if (Buffer.isBuffer && Buffer.isBuffer(v)) return "0x" + v.toString("hex").toUpperCase();
          return String(v);
        };
      }
      if (isJsonType) {
        colDef.cellEditor = "agLargeTextCellEditor";
        colDef.cellEditorPopup = true;
        colDef.valueGetter = (params) => {
          const v = params.data?.[c.field];
          if (v == null || v === "") {
            return "";
          }
          if (typeof v === "object") {
            if (v.type === "Buffer" && Array.isArray(v.data)) {
              const hex = v.data
                .map((b) => String(Number(b).toString(16).padStart(2, "0")))
                .join("");
              return "0x" + hex.toUpperCase();
            }
            try {
              return JSON.stringify(v, null, 2);
            } catch (_e) {
              return String(v);
            }
          }
          return String(v);
        };
        colDef.valueSetter = (params) => {
          if (params.data == null) {
            return false;
          }
          const nv = params.newValue;
          if (nv == null || (typeof nv === "string" && nv.trim() === "")) {
            params.data[c.field] = null;
            return true;
          }
          if (typeof nv === "object") {
            params.data[c.field] = nv;
            return true;
          }
          const s = String(nv).trim();
          try {
            params.data[c.field] = JSON.parse(s);
          } catch (_e2) {
            params.data[c.field] = s;
          }
          return true;
        };
      }
      if (isDateType) {
        const includeTime = /^(datetime|timestamp|time)(\s|\(|$)/.test(typeTrim);
        colDef.cellEditor = "agDateStringCellEditor";
        colDef.cellEditorParams = { includeTime: !!includeTime };
        colDef.cellEditorPopup = true;
        colDef.valueFormatter = (params) =>
          DatabaseTableData.formatDateForDisplay(params.value, includeTime, typeTrim);
      }
      if (this.serverPagination) {
        colDef.comparator = () => 0;
      }
      defs.push(colDef);
    });
    return defs;
  }

  _getFilterConfig(col, type) {
    const isNumeric = /^(tinyint|smallint|mediumint|int|bigint|decimal|float|double|numeric|bit)(\s|\(|$)/i.test(type);
    const isDate = /^(date|datetime|timestamp|time)(\s|$)/i.test(type);
    if (isNumeric) return { filter: "agNumberColumnFilter" };
    if (isDate) return { filter: "agDateColumnFilter" };
    return { filter: "agTextColumnFilter" };
  }

  _getComparatorConfig(col, type) {
    const isNumeric = /^(tinyint|smallint|mediumint|int|bigint|decimal|float|double|numeric|bit)(\s|\(|$)/i.test(type);
    const isDate = /^(date|datetime|timestamp|time)(\s|$)/i.test(type);
    if (isNumeric) {
      return {
        comparator: (a, b) => {
          const na = a == null || a === "" ? null : Number(a);
          const nb = b == null || b === "" ? null : Number(b);
          if (na == null && nb == null) return 0;
          if (na == null) return 1;
          if (nb == null) return -1;
          return na - nb;
        },
      };
    }
    if (isDate) {
      return {
        comparator: (a, b) => {
          const da = a ? new Date(a) : null;
          const db = b ? new Date(b) : null;
          if (!da && !db) return 0;
          if (!da) return 1;
          if (!db) return -1;
          return da - db;
        },
      };
    }
    return {};
  }

  /**
   * 与原始值对比用字符串（对象/数组用 JSON.stringify，避免 [object Object]）
   */
  _normalizeCellValueForDiff(field, value) {
    if (value == null || value === "") {
      return "";
    }
    if (typeof value === "object") {
      if (value.type === "Buffer" && Array.isArray(value.data)) {
        const hex = value.data
          .map((b) => String(Number(b).toString(16).padStart(2, "0")))
          .join("");
        return "0x" + hex.toUpperCase();
      }
      try {
        return JSON.stringify(value);
      } catch (_e) {
        return String(value);
      }
    }
    return String(value).trim();
  }

  _onCellValueChanged(e) {
    if (!e.data) return;
    const rowIndex = e.data.__rowIndex;
    if (rowIndex == null) return;
    const orig = this.originalData.get(rowIndex);
    if (!orig) return;

    const field = e.column?.getColId();
    const newVal = this._normalizeCellValueForDiff(field, e.data[field]);
    const oldVal = this._normalizeCellValueForDiff(field, orig[field]);
    if (newVal !== oldVal) {
      this.changedRows.set(e.node.id, { original: orig, current: { ...e.data } });
      e.node.setDataValue("__edited", true);
    } else {
      let hasOther = false;
      for (const k of Object.keys(e.data)) {
        if (k.startsWith("__")) continue;
        const cv = this._normalizeCellValueForDiff(k, e.data[k]);
        const ov = this._normalizeCellValueForDiff(k, orig[k]);
        if (cv !== ov) {
          hasOther = true;
          break;
        }
      }
      if (!hasOther) {
        this.changedRows.delete(e.node.id);
        e.node.setDataValue("__edited", false);
      }
    }
  }

  updatePaginationUI() {
    if (!this.gridApi) return;
    const rangeEl = document.getElementById("pagination-range");
    const firstBtn = document.getElementById("btn-first-page");
    const prevBtn = document.getElementById("btn-prev-page");
    const nextBtn = document.getElementById("btn-next-page");

    if (this.serverPagination) {
      const from = this.tableData.length === 0 ? 0 : this.dataOffset + 1;
      const to = this.dataOffset + this.tableData.length;
      if (rangeEl) rangeEl.textContent = `${from} - ${to}`;
      const atFirst = this.dataOffset === 0;
      if (firstBtn) firstBtn.disabled = atFirst;
      if (prevBtn) prevBtn.disabled = atFirst;
      if (nextBtn) nextBtn.disabled = this.tableData.length < this.pageSize;
      return;
    }

    const page = (this.gridApi.paginationGetCurrentPage?.() ?? 0) + 1;
    const total = this.gridApi.getDisplayedRowCount?.() ?? this.tableData.length;
    const size = this.paginationSize;
    const from = total === 0 ? 0 : (page - 1) * size + 1;
    const to = Math.min(page * size, total);
    const text = `${from} - ${to} / ${total}`;
    if (rangeEl) rangeEl.textContent = text;
    const maxPage = Math.max(1, Math.ceil(total / size));
    const atFirst = page <= 1;
    if (firstBtn) firstBtn.disabled = atFirst;
    if (prevBtn) prevBtn.disabled = atFirst;
    if (nextBtn) nextBtn.disabled = page >= maxPage || maxPage <= 0;
  }

  nextPage() {
    if (this.serverPagination && this.vscode) {
      this.vscode.postMessage({
        command: "loadPage",
        offset: this.dataOffset + this.pageSize,
        filterModel: this.getFilterModelForServer(),
        sortModel: this.getSortModelForServer(),
      });
      return;
    }
    if (this.gridApi) this.gridApi.paginationGoToNextPage();
  }

  prevPage() {
    if (this.serverPagination && this.vscode) {
      this.vscode.postMessage({
        command: "loadPage",
        offset: Math.max(0, this.dataOffset - this.pageSize),
        filterModel: this.getFilterModelForServer(),
        sortModel: this.getSortModelForServer(),
      });
      return;
    }
    if (this.gridApi) this.gridApi.paginationGoToPreviousPage();
  }

  /** 回到第一页（客户端分页走 AG Grid；服务端分页请求 offset=0） */
  firstPage() {
    if (this.serverPagination && this.vscode) {
      if (this.dataOffset === 0) {
        return;
      }
      this.vscode.postMessage({
        command: "loadPage",
        offset: 0,
        filterModel: this.getFilterModelForServer(),
        sortModel: this.getSortModelForServer(),
      });
      return;
    }
    if (this.gridApi && typeof this.gridApi.paginationGoToFirstPage === "function") {
      this.gridApi.paginationGoToFirstPage();
    }
  }

  /**
   * 根据列默认值解析出用于新行表单的初始值（如 CURRENT_TIMESTAMP -> 当前时间）
   */
  getNewRowFormDefaults() {
    const now = new Date();
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const datetimeStr = `${dateStr}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const defaults = {};
    (this.columns || []).forEach((c) => {
      const def = c.defaultValue;
      if (def == null || String(def).trim() === "") {
        const type = (c.type != null ? String(c.type) : "").toLowerCase();
        const isBit1 = /^bit\s*\(\s*1\s*\)$/.test(type) || (type.startsWith("bit") && type.includes("1"));
        defaults[c.field] = isBit1 ? 0 : "";
        return;
      }
      const v = String(def).trim().toUpperCase();
      if (v === "CURRENT_TIMESTAMP") {
        defaults[c.field] = datetimeStr;
        return;
      }
      if (v === "CURRENT_DATE") {
        defaults[c.field] = dateStr;
        return;
      }
      defaults[c.field] = def;
    });
    return defaults;
  }

  /**
   * 打开「新增行」表单弹窗（原生 HTML），填写后插入一行
   */
  openAddRowForm() {
    if (!this.gridApi || !this.columns?.length) return;
    var self = this;
    var modal = document.getElementById("grid-add-row-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "grid-add-row-modal";
      modal.className = "native-modal-overlay";
      modal.setAttribute("aria-hidden", "true");
      modal.innerHTML =
        "<div class=\"native-modal-dialog\" role=\"dialog\" aria-labelledby=\"grid-add-row-modal-title\">" +
          "<div class=\"native-modal-title\" id=\"grid-add-row-modal-title\">新增数据行</div>" +
          "<div class=\"native-modal-body\"></div>" +
          "<div class=\"native-modal-error\" id=\"grid-add-row-modal-error\" style=\"display:none;\"></div>" +
          "<div class=\"native-modal-footer\">" +
            "<button type=\"button\" class=\"native-modal-btn native-modal-btn-primary\" data-action=\"submit-add-row\">提交</button>" +
            "<button type=\"button\" class=\"native-modal-btn\" data-action=\"cancel-add-row\">取消</button>" +
          "</div>" +
        "</div>";
      document.body.appendChild(modal);
      modal.addEventListener("click", function (e) {
        if (e.target === modal) self._closeAddRowModal();
      });
      var cancelBtn = modal.querySelector("[data-action=cancel-add-row]");
      if (cancelBtn) cancelBtn.addEventListener("click", function () { self._closeAddRowModal(); });
      var submitBtn = modal.querySelector("[data-action=submit-add-row]");
      if (submitBtn) submitBtn.addEventListener("click", function () {
        var formEl = modal.querySelector("#grid-add-row-form");
        if (formEl) formEl.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      });
    }
    var formDefaults = self.getNewRowFormDefaults();
    var primaryKeyField = self._getPrimaryKeyField();
    var formHtml = self._buildAddRowFormHtml(formDefaults, primaryKeyField);
    var body = modal.querySelector(".native-modal-body");
    if (body) {
      body.innerHTML = formHtml;
      var formEl = body.querySelector("#grid-add-row-form");
      if (formEl) {
        formEl.addEventListener("submit", function (e) {
          e.preventDefault();
          var errEl = modal.querySelector("#grid-add-row-modal-error");
          var data = self._collectAddRowFormData(formEl);
          var err = self._validateAddRowForm(data);
          if (err) {
            if (errEl) {
              errEl.textContent = err;
              errEl.style.display = "block";
            }
            return;
          }
          if (errEl) errEl.style.display = "none";
          self.addRowWithData(data);
          self._closeAddRowModal();
        });
      }
    }
    var errEl = modal.querySelector("#grid-add-row-modal-error");
    if (errEl) { errEl.textContent = ""; errEl.style.display = "none"; }
    modal.classList.add("native-modal-open");
    modal.setAttribute("aria-hidden", "false");
  }

  _closeAddRowModal() {
    var modal = document.getElementById("grid-add-row-modal");
    if (modal) {
      modal.classList.remove("native-modal-open");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  _buildAddRowFormHtml(formDefaults, primaryKeyField) {
    const rows = [];
    (this.columns || []).forEach((c) => {
      const required = c.canNull !== "YES" && !c.autoIncrement;
      const comment = c.comment ? String(c.comment).trim() : "";
      const label = (c.headerName != null ? c.headerName : c.field) + (required ? " <span class=\"form-required\">*</span>" : "");
      const type = (c.type != null ? String(c.type) : "").toLowerCase();
      const isBit1 = /^bit\s*\(\s*1\s*\)$/.test(type) || (type.startsWith("bit") && type.includes("1"));
      const isDate = /^date(\s|\(|$)/.test(type);
      const isDateTime = /^(datetime|timestamp|time)(\s|\(|$)/.test(type);
      let inputType = "text";
      if (isBit1) inputType = "radio";
      else if (isDate) inputType = "date";
      else if (isDateTime) inputType = "datetime-local";
      else if (/^(tinyint|smallint|mediumint|int|bigint|decimal|float|double|numeric|bit)(\s|\(|$)/i.test(type)) inputType = "number";
      const val = formDefaults[c.field] ?? "";
      const escapedVal = String(val).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      let inputHtml;
      if (inputType === "radio") {
        const isYes = val === true || val === 1 || val === "1" || String(val).toLowerCase() === "true";
        inputHtml =
          "<label class=\"form-radio-option\"><input type=\"radio\" name=\"" + c.field + "\" value=\"1\" " + (isYes ? "checked" : "") + " /> 是</label>" +
          "<label class=\"form-radio-option\"><input type=\"radio\" name=\"" + c.field + "\" value=\"0\" " + (!isYes ? "checked" : "") + " /> 否</label>";
      } else {
        var placeholder = c.autoIncrement ? "<auto_increment>" : (comment ? comment.replace(/"/g, "&quot;") : "");
        var displayVal = c.autoIncrement ? "" : escapedVal;
        inputHtml = "<input type=\"" + inputType + "\" name=\"" + c.field + "\" value=\"" + displayVal + "\" placeholder=\"" + placeholder + "\" class=\"native-form-input\" />";
      }
      rows.push(
        "<div class=\"native-form-row\">" +
          "<label class=\"native-form-label\">" + label + "</label>" +
          "<div class=\"native-form-field\">" +
            inputHtml +
            (comment ? "<div class=\"form-field-comment\">" + comment.replace(/</g, "&lt;") + "</div>" : "") +
          "</div>" +
        "</div>"
      );
    });
    return "<form id=\"grid-add-row-form\" class=\"native-add-row-form\">" + rows.join("") + "</form>";
  }

  _collectAddRowFormData(formEl) {
    const data = {};
    (this.columns || []).forEach((c) => {
      const type = (c.type != null ? String(c.type) : "").toLowerCase();
      const isBit1 = /^bit\s*\(\s*1\s*\)$/.test(type) || (type.startsWith("bit") && type.includes("1"));
      if (isBit1) {
        const radio = formEl.querySelector("[name=\"" + c.field + "\"]:checked");
        data[c.field] = radio && radio.value === "1" ? 1 : 0;
      } else {
        const input = formEl.querySelector("[name=\"" + c.field + "\"]");
        if (input) {
          const v = input.value != null ? String(input.value).trim() : "";
          data[c.field] = v;
        }
      }
    });
    return data;
  }

  _validateAddRowForm(data) {
    for (const c of this.columns || []) {
      if (c.autoIncrement) continue;
      if (c.canNull !== "YES") {
        const v = data[c.field];
        if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
          return "请填写必填字段：" + (c.headerName != null ? c.headerName : c.field);
        }
      }
    }
    return null;
  }

  addRowWithData(data) {
    if (!this.gridApi) return;
    const rowIndex = this.tableData.length;
    const newData = { ...data, __rowIndex: rowIndex, __isNew: true };
    this.tableData.push(newData);
    this.gridApi.applyTransaction({ add: [newData] });
    this.originalData.set(rowIndex, JSON.parse(JSON.stringify(newData)));
  }

  addRow() {
    if (!this.gridApi) return;
    this.openAddRowForm();
  }

  refreshTable() {
    if (!this.gridApi) return;
    this.changedRows.clear();
    this.originalData.clear();
    this.tableData.forEach((row, i) => {
      row.__rowIndex = i;
      this.originalData.set(i, JSON.parse(JSON.stringify(row)));
    });
    this.gridApi.setGridOption("rowData", this.tableData);
    this.updatePaginationUI?.();
  }

  deleteRow() {
    if (!this.gridApi) return;
    const selected = this.gridApi.getSelectedRows();
    if (!selected || selected.length === 0) {
      console.warn("请先选择要删除的行");
      return;
    }
    const self = this;
    layui.use("layer", function () {
      const layer = layui.layer;
      layer.confirm(
        "确定将选中的 " + selected.length + " 行标记为删除？（保存时从数据库删除）",
        { icon: 3, title: "标记删除" },
        function (idx) {
          const nodesToRedraw = [];
          selected.forEach((row) => {
            row.__deleted = true;
            const node = self.gridApi.getRowNode(String(row.__rowIndex));
            if (node) {
              node.setDataValue("__deleted", true);
              nodesToRedraw.push(node);
            }
          });
          if (nodesToRedraw.length) {
            self.gridApi.redrawRows({ rowNodes: nodesToRedraw });
          }
          layer.close(idx);
        }
      );
    });
  }

  /**
   * 从网格当前数据与原始数据对比得到变更（不依赖 onCellValueChanged）
   */
  getChangedRows() {
    const primaryKeyField = this._getPrimaryKeyField();
    const result = [];
    if (!this.gridApi) return result;
    this.gridApi.forEachNode((node) => {
      const current = node.data;
      if (!current) return;
      if (current.__deleted) return;
      const rowIndex = current.__rowIndex;
      if (rowIndex == null) return;
      const original = this.originalData.get(rowIndex);
      if (!original) return;
      const changes = {};
      for (const key of Object.keys(current)) {
        if (key.startsWith("__")) continue;
        const cv = this._normalizeCellValueForDiff(key, current[key]);
        const ov = this._normalizeCellValueForDiff(key, original[key]);
        if (cv !== ov) changes[key] = current[key];
      }
      const hasChanges = Object.keys(changes).length > 0;
      const isNewRow = !!current.__isNew;
      if (hasChanges || isNewRow) {
        result.push({
          id: original[primaryKeyField],
          original,
          updated: changes,
          full: { ...current },
          isNew: isNewRow,
        });
      }
    });
    return result;
  }

  /** 获取标记为删除的行（主键 id，供保存时执行 DELETE） */
  getDeletedRows() {
    const primaryKeyField = this._getPrimaryKeyField();
    const result = [];
    if (!this.gridApi) return result;
    this.gridApi.forEachNode((node) => {
      const current = node.data;
      if (!current?.__deleted) return;
      const original = this.originalData.get(current.__rowIndex);
      const id = original?.[primaryKeyField] ?? current[primaryKeyField];
      if (id !== undefined && id !== null && id !== "") {
        result.push({ id, original: original || current });
      }
    });
    return result;
  }

  _getPrimaryKeyField() {
    const pk = this.columns.find((c) => c.key === "PRI");
    return pk ? pk.field : "id";
  }

  /** 供 grid 保存时上报主键字段名（MySQL 等） */
  getPrimaryKeyField() {
    return this._getPrimaryKeyField();
  }

  setFilter(field, type, value) {
    if (!this.gridApi) return;
    if (!field || value === "") {
      this.gridApi.setFilterModel(null);
      return;
    }
    const col = this.gridApi.getColumn(field);
    if (!col) return;
    const filterType = col.getColDef().filter;
    const filterModel = {};
    if (filterType === "agNumberColumnFilter") {
      const num = parseFloat(value);
      const op = type === "=" ? "equals" : type === "!=" ? "notEqual" : type === "<" ? "lessThan" : type === "<=" ? "lessThanOrEqual" : type === ">" ? "greaterThan" : type === ">=" ? "greaterThanOrEqual" : "equals";
      filterModel[field] = { filterType: "number", type: op, filter: isNaN(num) ? value : num };
    } else if (filterType === "agTextColumnFilter") {
      const op = type === "like" ? "contains" : type === "!=" ? "notEqual" : "equals";
      filterModel[field] = { filterType: "text", type: op, filter: value };
    } else {
      filterModel[field] = { filterType: "text", type: "contains", filter: value };
    }
    this.gridApi.setFilterModel(filterModel);
  }

  clearFilter() {
    if (this.gridApi) this.gridApi.setFilterModel(null);
  }

  setSort(field, dir) {
    if (!this.gridApi) return;
    this.gridApi.applyColumnState({
      state: [{ colId: field, sort: dir === "desc" ? "desc" : "asc" }],
      defaultState: { sort: null },
    });
  }

  undo() {
    // AG Grid Community 无内置撤销，可后续扩展
  }

  redo() {
    // AG Grid Community 无内置重做，可后续扩展
  }

  exportCSV() {
    if (!this.gridApi) return;
    this.gridApi.exportDataAsCsv({ bom: true, fileName: "data.csv" });
  }

  /**
   * 当前网格中、按显示顺序排列的数据列 field（排除内部 __ 字段）
   */
  getDisplayedDataColumnFieldsOrdered() {
    if (!this.gridApi) return [];
    const cols = this.gridApi.getAllDisplayedColumns();
    if (!cols || !cols.length) return [];
    const out = [];
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const id = col.getColId();
      const def = col.getColDef();
      if (def.checkboxSelection) {
        continue;
      }
      const field = def.field != null ? def.field : id;
      if (typeof field !== "string" || field.startsWith("__")) {
        continue;
      }
      out.push(field);
    }
    return out;
  }

  /**
   * TSV 单元格转义（制表符/换行替换为空格，避免列错乱）
   */
  _escapeTsvCell(s) {
    if (s == null) {
      return "";
    }
    return String(s).replace(/\r\n|\r|\n/g, " ").replace(/\t/g, " ");
  }

  /**
   * 将剪贴板文本解析为二维字符串数组（按行、制表符分列；忽略末尾空行）
   */
  _parseClipboardTsvMatrix(text) {
    if (text == null || String(text).trim() === "") {
      return [];
    }
    const lines = String(text).split(/\r\n|\r|\n/);
    while (lines.length && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines.map((line) => line.split("\t"));
  }

  /**
   * 将粘贴字符串按列类型粗解析为单元格值（与编辑/保存语义尽量一致）
   */
  _coercePastedValueForField(field, rawString) {
    if (rawString === "") {
      return null;
    }
    const col = (this.columns || []).find((c) => c.field === field);
    if (!col) {
      return rawString;
    }
    const type = (col.type != null ? String(col.type) : "").toLowerCase().trim();
    const typeTrim = type.trim();
    const isBit1 = /^bit\s*\(\s*1\s*\)$/.test(type) || (type.startsWith("bit") && type.includes("1"));
    const isJsonType = /^json(\s|\(|$)/i.test(typeTrim);
    const isNumeric = /^(tinyint|smallint|mediumint|int|bigint|decimal|float|double|numeric|bit)(\s|\(|$)/i.test(
      type
    );

    if (isBit1) {
      const t = String(rawString).trim().toLowerCase();
      if (t === "1" || t === "true" || t === "yes") {
        return 1;
      }
      if (t === "0" || t === "false" || t === "no" || t === "") {
        return 0;
      }
      const n = Number(rawString);
      return n ? 1 : 0;
    }
    if (isJsonType) {
      try {
        return JSON.parse(rawString);
      } catch (_e) {
        return rawString;
      }
    }
    if (isNumeric) {
      const n = Number(rawString);
      if (!Number.isNaN(n) && String(rawString).trim() !== "") {
        return n;
      }
      return rawString;
    }
    return rawString;
  }

  _appendEmptyDataRowForPaste() {
    if (!this.gridApi) return null;
    const defaults = this.getNewRowFormDefaults();
    const rowIndex = this.tableData.length;
    const newData = { ...defaults, __rowIndex: rowIndex, __isNew: true };
    this.tableData.push(newData);
    this.originalData.set(rowIndex, JSON.parse(JSON.stringify(newData)));
    this.gridApi.applyTransaction({ add: [newData] });
    return this.gridApi.getRowNode(String(rowIndex));
  }

  /**
   * 仅 AG Grid 行选中（复选框/表头全选），不含焦点单元格与最近点击行回退
   */
  _getSelectedRowsDataOnly() {
    const api = this.gridApi;
    if (!api) {
      return [];
    }
    let rows = api.getSelectedRows() || [];
    if (!rows.length && typeof api.getSelectedNodes === "function") {
      try {
        const nodes = api.getSelectedNodes();
        if (nodes && nodes.length) {
          rows = nodes.map((n) => n.data).filter(Boolean);
        }
      } catch (_e) {
        /* 忽略 */
      }
    }
    if (!rows.length && typeof api.forEachNode === "function") {
      const acc = [];
      try {
        api.forEachNode((node) => {
          if (node && typeof node.isSelected === "function" && node.isSelected() && node.data) {
            acc.push(node.data);
          }
        });
      } catch (_e2) {
        /* 忽略 */
      }
      if (acc.length) {
        rows = acc;
      }
    }
    return rows;
  }

  /**
   * 是否存在至少一行被用户勾选（用于 Grid 页是否拦截 Ctrl/Cmd+C 弹出复制格式菜单）
   */
  hasGridRowSelectionForCopy() {
    return this._getSelectedRowsDataOnly().length > 0;
  }

  /**
   * 解析当前要复制的行与列（选中行 → 焦点行 → 最近点击行）
   * @returns {{ ok: true, fields: string[], rows: object[] } | { ok: false, reason: string }}
   */
  getRowsForCopyPayload() {
    const api = this.gridApi;
    if (!api) {
      return { ok: false, reason: "no-grid" };
    }
    const fields = this.getDisplayedDataColumnFieldsOrdered();
    if (!fields.length) {
      return { ok: false, reason: "no-columns" };
    }
    let rows = this._getSelectedRowsDataOnly();
    if (!rows.length) {
      const focused = typeof api.getFocusedCell === "function" ? api.getFocusedCell() : null;
      if (focused && focused.rowIndex != null && typeof api.getDisplayedRowAtIndex === "function") {
        const node = api.getDisplayedRowAtIndex(focused.rowIndex);
        if (node && node.data) {
          rows = [node.data];
        }
      }
    }
    if (!rows.length && this._lastInteractedRowData) {
      rows = [this._lastInteractedRowData];
    }
    if (!rows.length) {
      return { ok: false, reason: "no-selection" };
    }
    return { ok: true, fields, rows };
  }

  _buildTsvFromRows(fields, rows) {
    const lines = rows.map((row) =>
      fields.map((f) => this._escapeTsvCell(this.cellValueToPreviewString(row[f], f))).join("\t")
    );
    return lines.join("\n");
  }

  _cellValueForJsonExport(value, field) {
    if (value == null) {
      return null;
    }
    if (typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) {
      const hex = value.data
        .map((b) => String(Number(b).toString(16).padStart(2, "0")))
        .join("");
      return "0x" + hex.toUpperCase();
    }
    if (typeof value === "object") {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_e) {
        return this.cellValueToPreviewString(value, field);
      }
    }
    return value;
  }

  _buildJsonFromRows(fields, rows) {
    const arr = rows.map((row) => {
      const o = {};
      for (const f of fields) {
        o[f] = this._cellValueForJsonExport(row[f], f);
      }
      return o;
    });
    return JSON.stringify(arr, null, 2);
  }

  _sqlEscapeIdent(id) {
    return "`" + String(id).replace(/`/g, "``") + "`";
  }

  _sqlStringLiteral(s) {
    return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
  }

  _sqlValueForInsert(field, value) {
    if (value == null || value === "") {
      return "NULL";
    }
    if (typeof value === "boolean") {
      return value ? "1" : "0";
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) {
      const hex = value.data
        .map((b) => String(Number(b).toString(16).padStart(2, "0")))
        .join("");
      return "X'" + hex.toUpperCase() + "'";
    }
    if (typeof value === "object") {
      try {
        return this._sqlStringLiteral(JSON.stringify(value));
      } catch (_e2) {
        return this._sqlStringLiteral(String(value));
      }
    }
    return this._sqlStringLiteral(String(value));
  }

  /**
   * @param {{ tableName?: string, databaseName?: string }} [sqlContext]
   */
  _buildInsertSql(fields, rows, sqlContext) {
    const db = sqlContext && String(sqlContext.databaseName || "").trim();
    const tbl = (sqlContext && String(sqlContext.tableName || "").trim()) || "unknown_table";
    const tableSql = db
      ? `${this._sqlEscapeIdent(db)}.${this._sqlEscapeIdent(tbl)}`
      : this._sqlEscapeIdent(tbl);
    const cols = fields.map((f) => this._sqlEscapeIdent(f)).join(", ");
    const tuples = rows
      .map((row) => {
        const vals = fields.map((f) => this._sqlValueForInsert(f, row[f]));
        return "(" + vals.join(", ") + ")";
      })
      .join(",\n");
    return `INSERT INTO ${tableSql} (${cols}) VALUES\n${tuples};`;
  }

  /**
   * @param {"tsv"|"json"|"insert"} format
   * @param {{ tableName?: string, databaseName?: string }} [sqlContext] insert 时使用
   */
  async copyRowsToClipboard(format, sqlContext) {
    const payload = this.getRowsForCopyPayload();
    if (!payload.ok) {
      return payload;
    }
    const { fields, rows } = payload;
    let text = "";
    if (format === "tsv") {
      text = this._buildTsvFromRows(fields, rows);
    } else if (format === "json") {
      text = this._buildJsonFromRows(fields, rows);
    } else if (format === "insert") {
      text = this._buildInsertSql(fields, rows, sqlContext);
    } else {
      return { ok: false, reason: "unknown-format" };
    }
    const written = await this._writeClipboardText(text);
    if (!written.ok) {
      return { ok: false, reason: written.reason || "clipboard-write-failed" };
    }
    return { ok: true };
  }

  /**
   * 复制选中行为 TSV（仅数据行，不含表头；无选中时复制当前焦点所在行）
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  async copySelectedRowsAsTsv() {
    return this.copyRowsToClipboard("tsv");
  }

  /**
   * Webview 中 navigator.clipboard 常被策略拦截，失败时由扩展 host 写入（与 copyTableDdl 一致）
   */
  async _writeClipboardText(text) {
    const t = text != null ? String(text) : "";
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(t);
        return { ok: true };
      }
    } catch (_e) {
      /* 再走 host */
    }
    if (this.vscode) {
      try {
        this.vscode.postMessage({ command: "writeClipboard", text: t });
        return { ok: true };
      } catch (_e2) {
        return { ok: false, reason: "clipboard-write-failed" };
      }
    }
    return { ok: false, reason: "no-clipboard" };
  }

  /**
   * 从剪贴板读取 TSV，从当前焦点单元格起向右向下写入；行不足时在表尾追加新行。
   * @returns {Promise<{ ok: boolean, reason?: string, rowsPasted?: number }>}
   */
  async pasteClipboardTsvAtFocusedCell() {
    const api = this.gridApi;
    if (!api) {
      return { ok: false, reason: "no-grid" };
    }
    const fields = this.getDisplayedDataColumnFieldsOrdered();
    if (!fields.length) {
      return { ok: false, reason: "no-columns" };
    }
    let text;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
        return { ok: false, reason: "no-clipboard" };
      }
      text = await navigator.clipboard.readText();
    } catch (_e) {
      return { ok: false, reason: "clipboard-read-failed" };
    }
    const matrix = this._parseClipboardTsvMatrix(text);
    if (!matrix.length) {
      return { ok: false, reason: "empty-clipboard" };
    }

    let focused = typeof api.getFocusedCell === "function" ? api.getFocusedCell() : null;
    let startRowIdx = focused && focused.rowIndex != null ? focused.rowIndex : 0;
    let startColIdx = 0;
    if (focused && focused.column) {
      const colId = focused.column.getColId();
      const idx = fields.indexOf(colId);
      if (idx >= 0) {
        startColIdx = idx;
      }
    } else if (typeof api.getDisplayedRowAtIndex === "function") {
      const node0 = api.getDisplayedRowAtIndex(0);
      if (node0 && node0.data) {
        startRowIdx = 0;
      }
    }

    let pasted = 0;
    for (let r = 0; r < matrix.length; r++) {
      const displayIdx = startRowIdx + r;
      while (
        typeof api.getDisplayedRowCount === "function" &&
        displayIdx >= api.getDisplayedRowCount()
      ) {
        const appended = this._appendEmptyDataRowForPaste();
        if (!appended) {
          break;
        }
      }
      if (typeof api.getDisplayedRowAtIndex !== "function") {
        return { ok: false, reason: "no-api" };
      }
      const rowNode = api.getDisplayedRowAtIndex(displayIdx);
      if (!rowNode || !rowNode.data) {
        break;
      }
      const rowCells = matrix[r];
      for (let c = 0; c < rowCells.length; c++) {
        const fi = startColIdx + c;
        if (fi >= fields.length) {
          break;
        }
        const field = fields[fi];
        const rawCell = rowCells[c] != null ? String(rowCells[c]) : "";
        const value = this._coercePastedValueForField(field, rawCell);
        rowNode.setDataValue(field, value);
        pasted++;
      }
    }

    this.updatePaginationUI?.();
    return { ok: true, rowsPasted: matrix.length };
  }
}
