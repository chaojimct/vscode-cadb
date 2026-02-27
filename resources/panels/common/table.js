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
    const columnDefs = this._buildColumnDefs();
    const rowData = this.tableData.map((r, i) => ({ ...r, __rowIndex: i }));

    const gridOptions = {
      columnDefs,
      rowData,
      defaultColDef: {
        sortable: true,
        resizable: true,
        filter: true,
        editable: true,
      },
      pagination: true,
      paginationPageSize: this.paginationSize,
      paginationPageSizeSelector: false,
      rowSelection: "multiple",
      suppressRowClickSelection: true,
      stopEditingWhenCellsLoseFocus: true,
      animateRows: false,
      getRowId: (params) => params.data.__rowIndex != null ? String(params.data.__rowIndex) : params.id,
      onCellValueChanged: (e) => self._onCellValueChanged(e),
      onGridReady: (e) => {
        self.gridApi = e.api;
        self.updatePaginationUI();
      },
      onPaginationChanged: () => self.updatePaginationUI?.(),
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
      const colDef = {
        field: c.field,
        headerName: c.field.toUpperCase(),
        width: 120,
        minWidth: 80,
        ...this._getFilterConfig(c, type),
        ...this._getComparatorConfig(c, type),
      };
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
    const newData = { ...this.newRow, __rowIndex: rowIndex };
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
        "确定要删除选中的 " + selected.length + " 行吗？",
        { icon: 3, title: "确认删除" },
        function (idx) {
          self.tableData = self.tableData.filter((row) => !selected.includes(row));
          self.gridApi.applyTransaction({ remove: selected });
          selected.forEach((r) => {
            const i = r.__rowIndex;
            if (i != null) self.originalData.delete(i);
          });
          layer.close(idx);
        }
      );
    });
  }

  getChangedRows() {
    const primaryKeyField = this._getPrimaryKeyField();
    const result = [];
    this.changedRows.forEach(({ original, current }) => {
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
          full: current,
        });
      }
    });
    return result;
  }

  _getPrimaryKeyField() {
    const pk = this.columns.find((c) => c.key === "PRI");
    return pk ? pk.field : "id";
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
