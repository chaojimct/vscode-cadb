/**
 * Grid 页面 - 数据表格视图
 * 使用 Tabulator 进行数据渲染
 */

class DatabaseTableData {
  constructor(options) {
    this.tableSelector = options.tableSelector;
    this.vscode = options.vscode || null;

    this.newRow = {};
    this.table = null;
    this.tableData = [];
    this.columns = [];
    this.changedRows = new Set();
    this.originalData = new Map(); // 保存原始数据，key 为行索引
    this.queryTime = 0; // 查询时间（秒）
    this.totalCount = 0; // 远程分页总行数
    this.pendingPageResolve = null; // 远程分页请求的 resolve
  }

  /**
   * 初始化表格（data 为第一页数据，totalCount 为总行数，用于远程分页）
   */
  init(columns, data, queryTime, totalCount) {
    this.pendingPageResolve = null;
    this.columns = columns;
    this.tableData = data || [];
    this.queryTime = queryTime || 0;
    this.totalCount = totalCount ?? 0;
    this.changedRows.clear();
    this.originalData.clear();
    // 保存第一页原始数据的深拷贝
    (this.tableData || []).forEach((row, index) => {
      this.originalData.set(index, JSON.parse(JSON.stringify(row)));
    });
    this._initDataTable();
  }

  /**
   * 远程分页：扩展返回某一页数据时调用，用于 resolve ajaxRequestFunc 的 Promise
   */
  setPageData(payload) {
    if (typeof this.pendingPageResolve !== "function") return;
    const totalCount = payload.totalCount ?? 0;
    const pageSize = Math.max(1, payload.pageSize || 50);
    const lastPage = Math.max(1, Math.ceil(totalCount / pageSize));
    if (payload.queryTime != null) this.queryTime = payload.queryTime;
    this.pendingPageResolve({
      last_page: lastPage,
      last_row: totalCount,
      data: Array.isArray(payload.rowData) ? payload.rowData : [],
    });
    this.pendingPageResolve = null;
  }

  /**
   * 初始化 Tabulator
   */
  _initDataTable() {
    const self = this;
    const DateTime = typeof window !== "undefined" && (window.luxon?.DateTime || window.DateTime);
    const pageSize = 50;
    this.table = new Tabulator(this.tableSelector, {
      dependencies: DateTime ? { DateTime } : undefined,
      height: "100%",
      layout: "fitDataStretch",
      pagination: true,
      paginationMode: "remote",
      paginationSize: pageSize,
      paginationCounter: function (
        size,
        currentRow,
        currentPage,
        totalRows,
        totalPages
      ) {
        const timeDisplay =
          self.queryTime < 0.001 ? "<0.001s" : `${self.queryTime.toFixed(3)}s`;
        return `查询时间: ${timeDisplay} | ${totalRows} 行`;
      },
      columns: this._buildColumns(),
      data: [],

      // 远程分页：通过 postMessage 向扩展请求当前页数据
      ajaxRequestFunc: function (url, config, params) {
        const page = params.page != null ? params.page : 1;
        const size = params.size != null ? params.size : pageSize;
        if (page === 1 && self.tableData && self.tableData.length >= 0 && typeof self.totalCount === "number" && self.totalCount >= 0) {
          const total = self.totalCount;
          const lastPage = Math.max(1, Math.ceil(total / size));
          return Promise.resolve({
            last_page: lastPage,
            last_row: total,
            data: self.tableData,
          });
        }
        if (self.vscode && self.vscode.postMessage) {
          self.vscode.postMessage({ command: "loadPage", page: page, pageSize: size });
          return new Promise(function (resolve) {
            self.pendingPageResolve = resolve;
          });
        }
        return Promise.resolve({ last_page: 1, last_row: 0, data: [] });
      },

      // 启用范围选择
      selectableRange: 1,
      selectableRangeColumns: true,
      selectableRangeRows: true,
      selectableRangeClearCells: true,

      // 双击编辑单元格
      editTriggerEvent: "dblclick",

      // 启用编辑历史，支持撤销/重做（参考 Tabulator history）
      history: true,

      // 配置剪贴板支持范围格式
      clipboard: true,
      clipboardCopyStyled: false,
      clipboardCopyConfig: {
        rowHeaders: false,
        columnHeaders: false,
      },
      clipboardCopyRowRange: "range",
      clipboardPasteParser: "range",
      clipboardPasteAction: "range",

      // 行头显示行号
      rowHeader: {
        resizable: false,
        frozen: true,
        width: 40,
        hozAlign: "center",
        formatter: "rownum",
        cssClass: "range-header-col",
        headerSort: false,
        editor: false,
      },

      // 启用列头排序（参考 https://tabulator.info/docs/6.3/sort）
      headerSort: true,
      // 启用列调整大小
      resizableColumns: true,
      // 占位符文本
      placeholder: "暂无数据",
      // 使用 Virtual DOM 渲染，仅渲染可见行及上下缓冲，支持大量行数（参考 https://tabulator.info/docs/6.3/virtual-dom）
      renderVertical: "virtual",
      // 增大上下缓冲，减少快速滚动时未渲染区域露出白底
      renderVerticalBuffer: 400,
      // 响应式列
      responsiveLayout: false,

    });
  }

  /**
   * 根据表字段类型返回 Tabulator 列配置（formatter / editor）
   * 仅使用 Tabulator 内置：plaintext、datetime(luxon)、link、adaptable
   * @param {Object} col - 列定义，含 field、type（MySQL Type）
   */
  _getFormatterConfig(col) {
    const type = (col.type != null ? String(col.type) : "").toLowerCase();

    if (/json/i.test(type)) {
      return {
        formatter: "plaintext",
        variableHeight: false,
        editor: "input",
      };
    }
    if (/tinyint\s*\(\s*1\s*\)|bit\s*\(\s*1\s*\)/.test(type)) {
      return {
        formatter: "tickCross",
        formatterParams: { allowEmpty: true },
        variableHeight: false,
        editor: "input",
      };
    }
    if (/^(longtext|mediumtext|text)(\s|$)/i.test(type) || type === "text") {
      return {
        formatter: "plaintext",
        variableHeight: false,
        editor: "input",
      };
    }
    if (/^(int|bigint|smallint|mediumint|decimal|float|double|numeric)(\s|\(|$)/i.test(type)) {
      return {
        formatter: "plaintext",
        variableHeight: false,
        editor: "input",
      };
    }
    if (/^(date|datetime|timestamp|time)(\s|$)/i.test(type)) {
      const isTime = /^time(\s|$)/i.test(type);
      const isDateOnly = /^date(\s|$)/i.test(type) && !/datetime|timestamp/i.test(type);
      const inputFormat = isTime ? "HH:mm:ss" : isDateOnly ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm:ss";
      const outputFormat = isTime ? "HH:mm:ss" : isDateOnly ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm:ss";
      return {
        formatter: "datetime",
        formatterParams: {
          inputFormat: inputFormat,
          outputFormat: outputFormat,
          invalidPlaceholder: "",
        },
        variableHeight: false,
        editor: "input",
      };
    }
    if (/^(varchar|char)(\s|\(|$)/i.test(type)) {
      return {
        formatter: "adaptable",
        formatterParams: {
          formatterLookup: function (cell) {
            const v = cell.getValue();
            if (typeof v === "string" && (v.startsWith("http://") || v.startsWith("https://"))) {
              return "link";
            }
            return "plaintext";
          },
        },
        variableHeight: false,
        editor: "input",
      };
    }
    // 其他未识别类型使用 adaptable
    return {
      formatter: "adaptable",
      variableHeight: false,
      editor: "input",
    };
  }

  /**
   * 根据列类型返回 Tabulator 排序配置（sorter / sorterParams）
   * 参考 https://tabulator.info/docs/6.3/sort
   */
  _getSorterConfig(col) {
    const type = (col.type != null ? String(col.type) : "").toLowerCase();
    if (/^(int|bigint|smallint|mediumint|decimal|float|double|numeric)(\s|\(|$)/i.test(type)) {
      return { sorter: "number" };
    }
    if (/^(date|datetime|timestamp|time)(\s|$)/i.test(type)) {
      const isTime = /^time(\s|$)/i.test(type);
      const isDateOnly = /^date(\s|$)/i.test(type) && !/datetime|timestamp/i.test(type);
      const format = isTime ? "HH:mm:ss" : isDateOnly ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm:ss";
      const sorter = isTime ? "time" : isDateOnly ? "date" : "datetime";
      return { sorter, sorterParams: { format } };
    }
    if (/tinyint\s*\(\s*1\s*\)|bit\s*\(\s*1\s*\)/.test(type)) {
      return { sorter: "boolean" };
    }
    return { sorter: "string" };
  }

  /**
   * 列头筛选弹出框内容：输入框绑定 getHeaderFilterValue / setHeaderFilterValue
   */
  _headerFilterPopupFormatter(e, column, onRendered) {
    const container = document.createElement("div");
    container.className = "tabulator-header-filter-popup";
    container.style.background = "var(--vscode-editorWidget-background, var(--vscode-input-bg))";
    container.style.color = "var(--vscode-editorWidget-foreground, var(--vscode-fg))";
    container.style.padding = "8px 10px";
    container.style.borderRadius = "4px";

    const label = document.createElement("label");
    label.textContent = "筛选该列:";
    label.style.display = "block";
    label.style.fontSize = "0.85em";
    label.style.marginBottom = "6px";
    label.style.color = "var(--vscode-descriptionForeground, var(--vscode-fg))";

    const input = document.createElement("input");
    input.placeholder = "输入筛选值...";
    input.value = column.getHeaderFilterValue() || "";
    input.style.cssText =
      "width:100%;padding:6px 8px;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border, var(--vscode-border));border-radius:2px;";

    input.addEventListener("keyup", () => {
      column.setHeaderFilterValue(input.value);
    });

    container.appendChild(label);
    container.appendChild(input);
    return container;
  }

  /**
   * 空 headerFilter，仅作占位以支持弹出框内 setHeaderFilterValue
   */
  _emptyHeaderFilter() {
    return document.createElement("div");
  }

  /**
   * 构建列定义（formatter / editor / sorter / headerPopup 字段过滤）
   */
  _buildColumns() {
    const cols = [];
    const self = this;

    this.columns.forEach((c) => {
      const config = this._getFormatterConfig(c);
      const sorterConfig = this._getSorterConfig(c);
      const colDef = {
        title: c.field.toUpperCase(),
        field: c.field,
        headerHozAlign: "center",
        resizable: true,
        width: 100,
        formatter: config.formatter,
        formatterParams: config.formatterParams,
        variableHeight: config.variableHeight !== false,
        editor: config.editor,
        sorter: sorterConfig.sorter,
        sorterParams: sorterConfig.sorterParams,
        cellEdited: this._cellEdited.bind(this),
        rawData: c,
        headerPopup: (e, column, onRendered) =>
          self._headerFilterPopupFormatter(e, column, onRendered),
        headerPopupIcon:
          "<i class=\"codicon codicon-filter\" title=\"筛选列\"></i>",
        headerFilter: () => self._emptyHeaderFilter(),
        headerFilterFunc: "like",
      };
      if (config.contextMenu) colDef.contextMenu = config.contextMenu;
      cols.push(colDef);
      this.newRow[c.field] = c.defaultValue || "";
    });
    return cols;
  }

  /**
   * 单元格编辑回调
   */
  _cellEdited(cell) {
    const item = cell._cell;
    const row = item.row;
    const rowData = row.getData();
    const rowIndex = row.getPosition();
    
    // 检查值是否改变（比较当前值和初始值）
    const currentValue = item.value !== null && item.value !== undefined ? String(item.value).trim() : '';
    const initialValue = item.initialValue !== null && item.initialValue !== undefined ? String(item.initialValue).trim() : '';
    
    if (currentValue !== initialValue) {
      $(cell._cell.element).addClass("tabulator-cell-edited");
      this.changedRows.add(row);
    } else {
      // 检查整行是否还有其他修改
      const originalRow = this.originalData.get(rowIndex);
      if (originalRow) {
        let hasChanges = false;
        for (const key in rowData) {
          const currentVal = rowData[key] !== null && rowData[key] !== undefined ? String(rowData[key]).trim() : '';
          const originalVal = originalRow[key] !== null && originalRow[key] !== undefined ? String(originalRow[key]).trim() : '';
          if (currentVal !== originalVal) {
            hasChanges = true;
            break;
          }
        }
        if (!hasChanges) {
          $(cell._cell.element).removeClass("tabulator-cell-edited");
          this.changedRows.delete(row);
        }
      }
    }
  }

  /**
   * 添加新行
   */
  addRow = () => {
    if (!this.table) {
      return;
    }

    this.table.addData([this.newRow], false).then((rows) => {
      if (rows && rows.length > 0) {
        layui.use("layer", function () {
          const layer = layui.layer;
        });
      }
    });
  };

  /**
   * 刷新表格
   */
  refreshTable = () => {
		console.log(this.tableData);
    if (!this.table) {
      return;
    }

    this.table.replaceData(this.tableData);
    this.changedRows.clear();
    this.originalData.clear();
    // 重新保存原始数据
    this.tableData.forEach((row, index) => {
      this.originalData.set(index, JSON.parse(JSON.stringify(row)));
    });
  };

  /**
   * 删除选中行
   */
  deleteRow = () => {
    if (!this.table) {
      return;
    }

    // 使用 Tabulator 的范围选择 API 获取选中的行
    const ranges = this.table.getRanges();
    if (!ranges || ranges.length === 0) {
      console.warn("请先选择要删除的行");
      return;
    }

    // 获取选中的行（去重）
    const selectedRowsSet = new Set();
    ranges.forEach((range) => {
      const rows = range.getRows();
      rows.forEach((row) => selectedRowsSet.add(row));
    });

    const selectedRowsArray = Array.from(selectedRowsSet);

    const self = this;
    layui.use("layer", function () {
      const layer = layui.layer;
      layer.confirm(
        "确定要删除选中的 " + selectedRowsArray.length + " 行吗？",
        {
          icon: 3,
          title: "确认删除",
        },
        function (index) {
          // 用户确认删除
          selectedRowsArray.forEach((row) => row.delete());
          layer.close(index);
        }
      );
    });
  };

  /**
   * 导出为 CSV（参考 https://tabulator.info/docs/6.3/download）
   */
  exportCSV = () => {
    if (!this.table) {
      return;
    }
    this.table.download("csv", "data.csv", { bom: true });
  };

  /**
   * 导出为 JSON（参考 https://tabulator.info/docs/6.3/download）
   */
  exportJSON = () => {
    if (!this.table) {
      return;
    }
    this.table.download("json", "data.json");
  };

  /**
   * 导出为 XLSX（参考 https://tabulator.info/docs/6.3/download，需 SheetJS 库）
   */
  exportXLSX = () => {
    if (!this.table) {
      return;
    }
    this.table.download("xlsx", "data.xlsx", { sheetName: "Data" });
  };

  /**
   * 获取修改的行数据
   * 返回包含原始数据和修改后数据的对象数组
   */
  getChangedRows() {
    const changedRows = [];
    const primaryKeyField = this._getPrimaryKeyField();
    
    this.changedRows.forEach((row) => {
      const currentData = row.getData();
      const rowIndex = row.getPosition();
      const originalData = this.originalData.get(rowIndex);
      
      if (originalData) {
        // 只收集实际改变的字段
        const changes = {};
        for (const key in currentData) {
          const currentVal = currentData[key] !== null && currentData[key] !== undefined ? String(currentData[key]).trim() : '';
          const originalVal = originalData[key] !== null && originalData[key] !== undefined ? String(originalData[key]).trim() : '';
          if (currentVal !== originalVal) {
            changes[key] = currentData[key];
          }
        }
        
        // 如果有改变，添加到结果中
        if (Object.keys(changes).length > 0) {
          changedRows.push({
            id: originalData[primaryKeyField], // 使用主键作为 ID
            original: originalData,
            updated: changes, // 只包含改变的字段
            full: currentData // 完整的新数据
          });
        }
      }
    });
    
    return changedRows;
  }
  
  /**
   * 获取主键字段名
   */
  _getPrimaryKeyField() {
    const pkColumn = this.columns.find(col => col.key === 'PRI');
    return pkColumn ? pkColumn.field : 'id'; // 默认使用 'id'
  }

  /**
   * 设置筛选（委托给 Tabulator setFilter，参考 https://tabulator.info/docs/6.3/filter）
   * @param {string} field - 字段名
   * @param {string} type - 比较类型：=, <, <=, >, >=, !=, like
   * @param {string} value - 筛选值
   */
  setFilter(field, type, value) {
    if (!this.table) return;
    this.table.setFilter(field, type, value);
  }

  /**
   * 清除所有筛选
   */
  clearFilter() {
    if (!this.table) return;
    this.table.clearFilter();
  }

  /**
   * 设置排序（委托给 Tabulator setSort，参考 https://tabulator.info/docs/6.3/sort）
   * @param {string} field - 字段名
   * @param {string} dir - 方向 "asc" | "desc"
   */
  setSort(field, dir) {
    if (!this.table) return;
    this.table.setSort(field, dir);
  }

  /**
   * 撤销上一次编辑（需启用 history: true）
   */
  undo() {
    if (!this.table) return;
    this.table.undo();
  }

  /**
   * 重做上一次撤销的编辑（需启用 history: true）
   */
  redo() {
    if (!this.table) return;
    this.table.redo();
  }

}
