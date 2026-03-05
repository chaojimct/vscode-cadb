/**
 * Grid 页面 - 数据表格视图
 * 使用 AG Grid Community 进行数据渲染
 */

class DatabaseTableData {
  constructor(options) {
    this.tableSelector = options.tableSelector;
    this.vscode = options.vscode || null;

    this.newRow = {};
    this.gridApi = null;
    this.tableData = [];
    this.columns = [];
    this.changedRows = new Map(); // row node id -> { original, current }
    this.originalData = new Map(); // row index -> original row
    this.queryTime = 0;
    this.paginationSize = 2000;
  }

  /**
   * 初始化表格
   */
  init(columns, data, queryTime) {
    this.columns = columns;
    this.tableData = data || [];
    this.queryTime = queryTime || 0;
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

  _initGrid() {
    const container = document.querySelector(this.tableSelector);
    if (!container) return;

    if (this.gridApi) {
      this.gridApi.destroy();
      this.gridApi = null;
    }

    const self = this;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => self._doInitGrid(container));
    });
  }

  _doInitGrid(container) {
    const self = this;
    const columnDefs = this._buildColumnDefs();
    const rowData = this.tableData.map((r, i) => ({ ...r, __rowIndex: i }));

    const boundOnCellValueChanged = this._onCellValueChanged.bind(this);
    const boundUpdatePaginationUI = this.updatePaginationUI.bind(this);

    const gridOptions = {
      columnDefs,
      rowData,
      defaultColDef: {
        sortable: true,
        resizable: true,
        filter: true,
        editable: true,
        valueFormatter: (params) => {
          const v = params.value;
          if (v != null && typeof v === "object") return JSON.stringify(v);
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
      pagination: true,
      paginationPageSize: this.paginationSize,
      paginationPageSizeSelector: false,
      rowSelection: { mode: "multiRow", enableClickSelection: false },
      stopEditingWhenCellsLoseFocus: true,
      animateRows: false,
      getRowId: (params) => params.data.__rowIndex != null ? String(params.data.__rowIndex) : params.id,
      rowClassRules: {
        "grid-row-deleted": (params) => params.data?.__deleted === true,
        "grid-row-edited": (params) => params.data?.__edited === true && params.data?.__deleted !== true,
      },
      onCellValueChanged: boundOnCellValueChanged,
      onGridReady: (e) => {
        self.gridApi = e.api;
        boundUpdatePaginationUI();
      },
      onPaginationChanged: boundUpdatePaginationUI,
    };

    if (typeof agGrid !== "undefined" && agGrid.createGrid) {
      agGrid.createGrid(container, gridOptions);
    }
  }

  _buildColumnDefs() {
    const defs = [
      {
        headerName: "#",
        valueGetter: (params) => {
          const api = params.api;
          const page = (api?.paginationGetCurrentPage?.() ?? 0);
          const pageSize = api?.paginationGetPageSize?.() ?? this.paginationSize;
          return page * pageSize + (params.node?.rowIndex ?? 0) + 1;
        },
        width: 50,
        pinned: "left",
        suppressMovable: true,
        sortable: false,
        filter: false,
        editable: false,
      },
    ];
    this.columns.forEach((c) => {
      const type = (c.type != null ? String(c.type) : "").toLowerCase();
      const typeTrim = type.trim();
      const isBit1 = /^bit\s*\(\s*1\s*\)$/.test(type) || (type.startsWith("bit") && type.includes("1"));
      const isDateType = /^(date|datetime|timestamp|time)(\s|\(|$)/.test(typeTrim);
      const colDef = {
        field: c.field,
        headerName: (c.headerName != null ? c.headerName : c.field.toUpperCase()),
        width: c.width != null ? c.width : 120,
        minWidth: c.minWidth != null ? c.minWidth : 80,
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
      if (isDateType) {
        const includeTime = /^(datetime|timestamp|time)(\s|\(|$)/.test(typeTrim);
        colDef.cellEditor = "agDateStringCellEditor";
        colDef.cellEditorParams = { includeTime: !!includeTime };
        colDef.cellEditorPopup = true;
      }
      defs.push(colDef);
    });
    return defs;
  }

  _getFilterConfig(col, type) {
    const isNumeric = /^(int|bigint|smallint|mediumint|decimal|float|double|numeric)(\s|\(|$)/i.test(type);
    const isDate = /^(date|datetime|timestamp|time)(\s|$)/i.test(type);
    if (isNumeric) return { filter: "agNumberColumnFilter" };
    if (isDate) return { filter: "agDateColumnFilter" };
    return { filter: "agTextColumnFilter" };
  }

  _getComparatorConfig(col, type) {
    const isNumeric = /^(int|bigint|smallint|mediumint|decimal|float|double|numeric)(\s|\(|$)/i.test(type);
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

  _onCellValueChanged(e) {
    if (!e.data) return;
    const rowIndex = e.data.__rowIndex;
    if (rowIndex == null) return;
    const orig = this.originalData.get(rowIndex);
    if (!orig) return;

    const field = e.column?.getColId();
    const newVal = e.data[field] != null ? String(e.data[field]).trim() : "";
    const oldVal = orig[field] != null ? String(orig[field]).trim() : "";
    if (newVal !== oldVal) {
      this.changedRows.set(e.node.id, { original: orig, current: { ...e.data } });
      e.node.setDataValue("__edited", true);
    } else {
      let hasOther = false;
      for (const k of Object.keys(e.data)) {
        if (k.startsWith("__")) continue;
        const cv = e.data[k] != null ? String(e.data[k]).trim() : "";
        const ov = orig[k] != null ? String(orig[k]).trim() : "";
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
    const page = (this.gridApi.paginationGetCurrentPage?.() ?? 0) + 1;
    const total = this.gridApi.getDisplayedRowCount?.() ?? this.tableData.length;
    const size = this.paginationSize;
    const from = total === 0 ? 0 : (page - 1) * size + 1;
    const to = Math.min(page * size, total);
    const text = `${from} - ${to} / ${total}`;

    const rangeEl = document.getElementById("pagination-range");
    const prevBtn = document.getElementById("btn-prev-page");
    const nextBtn = document.getElementById("btn-next-page");
    if (rangeEl) rangeEl.textContent = text;
    const maxPage = Math.max(1, Math.ceil(total / size));
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= maxPage || maxPage <= 0;
  }

  nextPage() {
    if (this.gridApi) this.gridApi.paginationGoToNextPage();
  }

  prevPage() {
    if (this.gridApi) this.gridApi.paginationGoToPreviousPage();
  }

  addRow() {
    if (!this.gridApi) return;
    const rowIndex = this.tableData.length;
    const newData = { ...this.newRow, __rowIndex: rowIndex, __isNew: true };
    this.tableData.push(newData);
    this.gridApi.applyTransaction({ add: [newData] });
    this.originalData.set(rowIndex, JSON.parse(JSON.stringify(newData)));
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
        const cv = current[key] != null ? String(current[key]).trim() : "";
        const ov = original[key] != null ? String(original[key]).trim() : "";
        if (cv !== ov) changes[key] = current[key];
      }
      if (Object.keys(changes).length > 0) {
        result.push({
          id: original[primaryKeyField],
          original,
          updated: changes,
          full: { ...current },
          isNew: !!current.__isNew,
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

  exportJSON() {
    if (!this.gridApi) return;
    const rows = this.gridApi.getModel().rowsToDisplay.map((r) => {
      const d = { ...r.data };
      delete d.__rowIndex;
      delete d.__edited;
      return d;
    });
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "data.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  exportXLSX() {
    // AG Grid Community 不支持 Excel 导出，提示用户
    if (this.vscode) {
      this.vscode.postMessage({ command: "status", success: false, message: "AG Grid Community 暂不支持 XLSX 导出，请使用 CSV 或 JSON" });
    } else {
      alert("AG Grid Community 暂不支持 XLSX 导出，请使用 CSV 或 JSON");
    }
  }
}
