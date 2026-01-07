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
    this.queryTime = 0; // 查询时间（秒）
    
    // 选择状态管理
    this.selectedRows = new Set(); // 选中的行索引
    this.selectedColumns = new Set(); // 选中的列字段名
    this.lastSelectedRowIndex = null; // 最后选中的行索引（用于 Shift 选择）
    this.lastSelectedColumn = null; // 最后选中的列（用于 Shift 选择）
  }

  /**
   * 初始化表格
   */
  init(columns, data, queryTime) {
    this.columns = columns;
    this.tableData = data;
    this.queryTime = queryTime || 0;
    this.changedRows.clear();
    this._initDataTable();
  }

  /**
   * 初始化 Tabulator
   */
  _initDataTable() {
    const self = this;
    this.table = new Tabulator(this.tableSelector, {
      height: "100%",
      layout: "fitColumns",
      pagination: "local",
      paginationSize: 50,
      paginationCounter: function(pageSize, currentRow, currentPage, totalRows, totalPages) {
        // 自定义显示查询时间
        const timeDisplay = self.queryTime < 0.001 
          ? '<0.001s' 
          : `${self.queryTime.toFixed(3)}s`;
        return `查询时间: ${timeDisplay} | ${totalRows} 行`;
      },
      columns: this._buildColumns(),
      data: [],
      // 启用行选择
      selectable: true,
      selectableRangeMode: "click",
      // 启用列排序
      headerSort: true,
      // 启用列调整大小
      resizableColumns: true,
      // 占位符文本
      placeholder: "暂无数据",
      // 启用虚拟 DOM（提升大数据性能）
      virtualDom: true,
      // 响应式列
      responsiveLayout: false,
    });

    // 异步加载数据
    requestAnimationFrame(() => {
      this.table.setData(this.tableData);
      // 数据加载后更新选择状态
      setTimeout(() => {
        this._updateRowSelection();
        this._updateColumnSelection();
      }, 100);
    });
    
    // 监听数据更新事件
    this.table.on("dataLoaded", () => {
      this._updateRowSelection();
      this._updateColumnSelection();
    });
  }

  /**
   * 构建列定义
   */
  _buildColumns() {
    const self = this;
    const cols = [];
    
    // 添加选择列作为第一列
    cols.push({
      title: "",
      field: "_select",
      width: 40,
      resizable: false,
      headerSort: false,
      frozen: true,
      formatter: function(cell, formatterParams) {
        const rowIndex = cell.getRow().getPosition();
        const isSelected = self.selectedRows.has(rowIndex);
        return `<button class="row-select-btn ${isSelected ? 'selected' : ''}" 
                        data-row-index="${rowIndex}"
                        title="选择行"></button>`;
      },
      cellClick: function(e, cell) {
        self._handleRowSelectClick(e, cell);
      },
      headerClick: function(e, column) {
        self._handleColumnSelectClick(e, column);
      },
      cssClass: "select-column"
    });
    
    // 添加数据列
    this.columns.forEach((c) => {
      cols.push({
        title: c.field.toUpperCase(),
        field: c.field,
        editor: "input",
        resizable: true,
        cellEdited: this._cellEdited.bind(this),
        rawData: c,
        headerClick: function(e, column) {
          self._handleColumnSelectClick(e, column);
        },
      });
      this.newRow[c.field] = c.defaultValue || "";
    });
    return cols;
  }
  
  /**
   * 处理行选择点击
   */
  _handleRowSelectClick(e, cell) {
    e.stopPropagation();
    const row = cell.getRow();
    const rowIndex = row.getPosition();
    const button = e.target.closest('.row-select-btn');
    
    if (!button) return;
    
    // 获取修饰键状态
    const ctrlKey = e.ctrlKey || e.metaKey;
    const shiftKey = e.shiftKey;
    
    if (shiftKey && this.lastSelectedRowIndex !== null) {
      // Shift 点击：选择范围
      const start = Math.min(this.lastSelectedRowIndex, rowIndex);
      const end = Math.max(this.lastSelectedRowIndex, rowIndex);
      
      for (let i = start; i <= end; i++) {
        this.selectedRows.add(i);
      }
    } else if (ctrlKey) {
      // Ctrl 点击：切换选择
      if (this.selectedRows.has(rowIndex)) {
        this.selectedRows.delete(rowIndex);
      } else {
        this.selectedRows.add(rowIndex);
      }
    } else {
      // 普通点击：单选
      this.selectedRows.clear();
      this.selectedRows.add(rowIndex);
    }
    
    this.lastSelectedRowIndex = rowIndex;
    this._updateRowSelection();
    this._updateTableSelection();
  }
  
  /**
   * 处理列选择点击
   */
  _handleColumnSelectClick(e, column) {
    // 如果是选择列本身，不处理列选择
    if (column.getField() === '_select') {
      return;
    }
    
    e.stopPropagation();
    const columnField = column.getField();
    const ctrlKey = e.ctrlKey || e.metaKey;
    const shiftKey = e.shiftKey;
    
    if (shiftKey && this.lastSelectedColumn !== null) {
      // Shift 点击：选择列范围
      const allColumns = this.columns.map(c => c.field);
      const startIndex = allColumns.indexOf(this.lastSelectedColumn);
      const endIndex = allColumns.indexOf(columnField);
      
      if (startIndex !== -1 && endIndex !== -1) {
        const start = Math.min(startIndex, endIndex);
        const end = Math.max(startIndex, endIndex);
        
        for (let i = start; i <= end; i++) {
          this.selectedColumns.add(allColumns[i]);
        }
      }
    } else if (ctrlKey) {
      // Ctrl 点击：切换选择
      if (this.selectedColumns.has(columnField)) {
        this.selectedColumns.delete(columnField);
      } else {
        this.selectedColumns.add(columnField);
      }
    } else {
      // 普通点击：单选
      this.selectedColumns.clear();
      this.selectedColumns.add(columnField);
    }
    
    this.lastSelectedColumn = columnField;
    this._updateColumnSelection();
  }
  
  /**
   * 更新行选择状态
   */
  _updateRowSelection() {
    if (!this.table) return;
    
    // 更新按钮状态
    const rows = this.table.getRows();
    rows.forEach((row, index) => {
      const rowIndex = row.getPosition();
      const button = row.getElement().querySelector('.row-select-btn');
      if (button) {
        if (this.selectedRows.has(rowIndex)) {
          button.classList.add('selected');
        } else {
          button.classList.remove('selected');
        }
      }
    });
    
    // 更新 Tabulator 的行选择状态
    const selectedRows = [];
    rows.forEach((row) => {
      const rowIndex = row.getPosition();
      if (this.selectedRows.has(rowIndex)) {
        selectedRows.push(row);
      }
    });
    this.table.deselectRow();
    if (selectedRows.length > 0) {
      this.table.selectRow(selectedRows);
    }
  }
  
  /**
   * 更新列选择状态
   */
  _updateColumnSelection() {
    if (!this.table) return;
    
    // 更新列头样式
    const columns = this.table.getColumns();
    columns.forEach((column) => {
      const field = column.getField();
      if (field === '_select') return;
      
      const headerElement = column.getElement();
      if (this.selectedColumns.has(field)) {
        headerElement.classList.add('column-selected');
      } else {
        headerElement.classList.remove('column-selected');
      }
    });
    
    // 更新该列的所有单元格样式
    const rows = this.table.getRows();
    rows.forEach((row) => {
      const cells = row.getCells();
      cells.forEach((cell) => {
        const field = cell.getField();
        if (field === '_select') return;
        
        const cellElement = cell.getElement();
        if (this.selectedColumns.has(field)) {
          cellElement.classList.add('column-selected');
        } else {
          cellElement.classList.remove('column-selected');
        }
      });
    });
  }
  
  /**
   * 更新表格选择状态（同步 Tabulator 的选择）
   */
  _updateTableSelection() {
    if (!this.table) return;
    
    // 这个方法会在 _updateRowSelection 中调用
    // 这里可以添加额外的同步逻辑
  }

  /**
   * 单元格编辑回调
   */
  _cellEdited(cell) {
    const item = cell._cell;
    // 检查值是否改变
    if (item.value.trim() !== item.initialValue) {
      $(cell._cell.element).addClass("tabulator-cell-edited");
      this.changedRows.add(item.row);
    } else {
      $(cell._cell.element).removeClass("tabulator-cell-edited");
      this.changedRows.delete(item.row);
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
    if (!this.table) {
      return;
    }

    // 清除选择状态
    this.selectedRows.clear();
    this.selectedColumns.clear();
    this.lastSelectedRowIndex = null;
    this.lastSelectedColumn = null;

    this.table.replaceData(this.tableData);
    this.changedRows.clear();
    
    // 更新选择状态
    setTimeout(() => {
      this._updateRowSelection();
      this._updateColumnSelection();
    }, 100);
    
    console.log('表格已刷新');
  };

  /**
   * 删除选中行
   */
  deleteRow = () => {
    if (!this.table) {
      return;
    }

    const selectedRows = this.table.getSelectedData();
    if (selectedRows.length === 0) {
      console.warn('请先选择要删除的行');
      return;
    }

    const self = this;
    layui.use("layer", function () {
      const layer = layui.layer;
      layer.confirm(
        "确定要删除选中的 " + selectedRows.length + " 行吗？",
        {
          icon: 3,
          title: "确认删除",
        },
        function (index) {
          // 用户确认删除
          self.table.getSelectedRows().forEach((row) => row.delete());
          layer.close(index);
          console.log('删除成功');
        }
      );
    });
  };

  /**
   * 导出为 CSV
   */
  exportCSV = () => {
    if (!this.table) {
      return;
    }
    this.table.download("csv", "data.csv");
  };

  /**
   * 导出为 JSON
   */
  exportJSON = () => {
    if (!this.table) {
      return;
    }
    this.table.download("json", "data.json");
  };

  /**
   * 导出为 SQL
   */
  exportSQL = () => {
    console.log('SQL 导出功能开发中...');
  };

  /**
   * 获取修改的行数据
   */
  getChangedRows() {
    const rows = [];
    this.changedRows.forEach((row) => {
      rows.push(row.getData());
    });
    return rows;
  }

  /**
   * 应用过滤和排序
   * @param {string} whereClause - WHERE 子句
   * @param {string} orderByClause - ORDER BY 子句
   */
  applyFilter(whereClause, orderByClause) {
    if (!this.table) {
      return;
    }

    // 清除现有的过滤和排序
    this.table.clearFilter();
    this.table.clearSort();

    let filteredData = [...this.tableData];

    // 应用 WHERE 过滤
    if (whereClause && whereClause.trim()) {
      try {
        filteredData = this.filterByWhereClause(filteredData, whereClause);
        console.log(`✓ 已应用 WHERE 过滤，找到 ${filteredData.length} 条记录`);
      } catch (error) {
        console.error(`✗ WHERE 子句错误: ${error.message}`);
        return;
      }
    }

    // 应用 ORDER BY 排序
    if (orderByClause && orderByClause.trim()) {
      try {
        filteredData = this.sortByOrderByClause(filteredData, orderByClause);
        
        if (!whereClause) {
          console.log('✓ 已应用 ORDER BY 排序');
        }
      } catch (error) {
        console.error(`✗ ORDER BY 子句错误: ${error.message}`);
        return;
      }
    }

    // 更新表格数据
    this.table.setData(filteredData);

    // 如果没有过滤和排序，显示提示
    if (!whereClause && !orderByClause) {
      console.log('已清除过滤和排序');
    }
  }

  /**
   * 根据 WHERE 子句过滤数据
   * @param {Array} data - 原始数据
   * @param {string} whereClause - WHERE 子句
   * @returns {Array} 过滤后的数据
   */
  filterByWhereClause(data, whereClause) {
    console.log('=== WHERE 过滤开始 ===');
    console.log('原始 WHERE 子句:', whereClause);
    console.log('数据行数:', data.length);
    console.log('可用字段:', this.columns.map(c => c.field));
    
    try {
      // 解析 WHERE 条件（不使用 eval 或 new Function）
      const condition = this.parseWhereCondition(whereClause);
      
      const filteredData = data.filter(row => {
        try {
          const result = this.evaluateCondition(condition, row);
          if (result) {
            console.log('✓ 匹配的行:', row);
          }
          return result;
        } catch (error) {
          console.error('✗ 评估行时出错:', error.message);
          return false;
        }
      });
      
      console.log('过滤后行数:', filteredData.length);
      console.log('=== WHERE 过滤结束 ===');
      
      return filteredData;
    } catch (error) {
      console.error('✗ WHERE 解析错误:', error.message);
      console.log('=== WHERE 过滤结束 ===');
      throw error;
    }
  }

  /**
   * 解析 WHERE 条件为抽象语法树
   * @param {string} whereClause - WHERE 子句
   * @returns {Object} 条件对象
   */
  parseWhereCondition(whereClause) {
    const clause = whereClause.trim();
    
    // 处理 AND/OR 逻辑运算符（优先级：OR < AND）
    // 先处理 OR
    const orParts = this.splitByOperator(clause, 'OR');
    if (orParts.length > 1) {
      return {
        type: 'OR',
        conditions: orParts.map(part => this.parseWhereCondition(part))
      };
    }
    
    // 再处理 AND
    const andParts = this.splitByOperator(clause, 'AND');
    if (andParts.length > 1) {
      return {
        type: 'AND',
        conditions: andParts.map(part => this.parseWhereCondition(part))
      };
    }
    
    // 处理单个比较条件
    return this.parseComparison(clause);
  }

  /**
   * 按运算符分割字符串（忽略引号内的内容）
   */
  splitByOperator(str, operator) {
    const parts = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    let i = 0;
    
    while (i < str.length) {
      const char = str[i];
      
      if ((char === '"' || char === "'") && (i === 0 || str[i-1] !== '\\')) {
        if (!inQuote) {
          inQuote = true;
          quoteChar = char;
        } else if (char === quoteChar) {
          inQuote = false;
        }
        current += char;
        i++;
      } else if (!inQuote && str.substr(i, operator.length + 2).toUpperCase() === ` ${operator} `) {
        parts.push(current.trim());
        current = '';
        i += operator.length + 2;
      } else {
        current += char;
        i++;
      }
    }
    
    if (current.trim()) {
      parts.push(current.trim());
    }
    
    return parts.length > 1 ? parts : [str];
  }

  /**
   * 解析比较表达式
   */
  parseComparison(expr) {
    expr = expr.trim();
    
    // 处理 IS NULL / IS NOT NULL
    const isNullMatch = expr.match(/^(\w+)\s+IS\s+NULL$/i);
    if (isNullMatch) {
      return { type: 'IS_NULL', field: isNullMatch[1] };
    }
    
    const isNotNullMatch = expr.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i);
    if (isNotNullMatch) {
      return { type: 'IS_NOT_NULL', field: isNotNullMatch[1] };
    }
    
    // 处理 LIKE
    const likeMatch = expr.match(/^(\w+)\s+LIKE\s+['"]([^'"]+)['"]$/i);
    if (likeMatch) {
      return { type: 'LIKE', field: likeMatch[1], value: likeMatch[2] };
    }
    
    // 处理比较运算符: =, !=, <>, <, >, <=, >=
    const comparisonMatch = expr.match(/^(\w+)\s*(=|!=|<>|<=|>=|<|>)\s*(.+)$/);
    if (comparisonMatch) {
      let value = comparisonMatch[3].trim();
      
      // 移除引号
      if ((value.startsWith('"') && value.endsWith('"')) || 
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      return {
        type: 'COMPARISON',
        field: comparisonMatch[1],
        operator: comparisonMatch[2] === '<>' ? '!=' : comparisonMatch[2],
        value: value
      };
    }
    
    throw new Error(`无法解析条件: ${expr}`);
  }

  /**
   * 评估条件
   */
  evaluateCondition(condition, row) {
    switch (condition.type) {
      case 'AND':
        return condition.conditions.every(c => this.evaluateCondition(c, row));
        
      case 'OR':
        return condition.conditions.some(c => this.evaluateCondition(c, row));
        
      case 'IS_NULL':
        const nullValue = row[condition.field];
        return nullValue === null || nullValue === undefined || nullValue === '';
        
      case 'IS_NOT_NULL':
        const notNullValue = row[condition.field];
        return notNullValue !== null && notNullValue !== undefined && notNullValue !== '';
        
      case 'LIKE':
        const likeValue = row[condition.field];
        if (likeValue === null || likeValue === undefined) return false;
        return likeValue.toString().includes(condition.value);
        
      case 'COMPARISON':
        return this.compareValues(
          row[condition.field],
          condition.operator,
          condition.value
        );
        
      default:
        throw new Error(`未知的条件类型: ${condition.type}`);
    }
  }

  /**
   * 比较两个值
   */
  compareValues(fieldValue, operator, compareValue) {
    // 处理 null/undefined
    if (fieldValue === null || fieldValue === undefined) {
      return operator === '!=' && compareValue !== '';
    }
    
    // 转换为字符串进行比较
    const fieldStr = fieldValue.toString();
    const compareStr = compareValue.toString();
    
    // 尝试数值比较
    const fieldNum = parseFloat(fieldStr);
    const compareNum = parseFloat(compareStr);
    const isNumeric = !isNaN(fieldNum) && !isNaN(compareNum);
    
    switch (operator) {
      case '=':
        return isNumeric ? fieldNum === compareNum : fieldStr === compareStr;
      case '!=':
        return isNumeric ? fieldNum !== compareNum : fieldStr !== compareStr;
      case '<':
        return isNumeric ? fieldNum < compareNum : fieldStr < compareStr;
      case '>':
        return isNumeric ? fieldNum > compareNum : fieldStr > compareStr;
      case '<=':
        return isNumeric ? fieldNum <= compareNum : fieldStr <= compareStr;
      case '>=':
        return isNumeric ? fieldNum >= compareNum : fieldStr >= compareStr;
      default:
        throw new Error(`未知的运算符: ${operator}`);
    }
  }

  /**
   * 根据 ORDER BY 子句排序数据
   * @param {Array} data - 原始数据
   * @param {string} orderByClause - ORDER BY 子句
   * @returns {Array} 排序后的数据
   */
  sortByOrderByClause(data, orderByClause) {
    // 解析 ORDER BY 子句：field1 ASC, field2 DESC
    const sortRules = orderByClause.split(',').map(rule => {
      const parts = rule.trim().split(/\s+/);
      const field = parts[0];
      const direction = (parts[1] || 'ASC').toUpperCase();
      return { field, direction };
    });

    // 复制数据以避免修改原数组
    const sortedData = [...data];

    // 多字段排序
    sortedData.sort((a, b) => {
      for (const rule of sortRules) {
        const aVal = a[rule.field];
        const bVal = b[rule.field];

        // 处理 null 和 undefined
        if (aVal == null && bVal == null) continue;
        if (aVal == null) return rule.direction === 'ASC' ? 1 : -1;
        if (bVal == null) return rule.direction === 'ASC' ? -1 : 1;

        // 比较值
        let comparison = 0;
        if (typeof aVal === 'string' && typeof bVal === 'string') {
          comparison = aVal.localeCompare(bVal);
        } else {
          comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        }

        if (comparison !== 0) {
          return rule.direction === 'DESC' ? -comparison : comparison;
        }
      }
      return 0;
    });

    return sortedData;
  }
}
