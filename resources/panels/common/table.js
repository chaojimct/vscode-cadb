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
  }

  /**
   * 初始化表格
   */
  init(columns, data, queryTime) {
    this.columns = columns;
    this.tableData = data;
    this.queryTime = queryTime || 0;
    this.changedRows.clear();
    this.originalData.clear();
    // 保存原始数据的深拷贝
    data.forEach((row, index) => {
      this.originalData.set(index, JSON.parse(JSON.stringify(row)));
    });
    this._initDataTable();
  }

  /**
   * 初始化 Tabulator
   */
  _initDataTable() {
    const self = this;
    this.table = new Tabulator(this.tableSelector, {
      height: "100%",
      layout: "fitDataStretch",
      pagination: "local",
      paginationSize: 50,
      paginationCounter: function (
        pageSize,
        currentRow,
        currentPage,
        totalRows,
        totalPages
      ) {
        // 自定义显示查询时间
        const timeDisplay =
          self.queryTime < 0.001 ? "<0.001s" : `${self.queryTime.toFixed(3)}s`;
        return `查询时间: ${timeDisplay} | ${totalRows} 行`;
      },
      columns: this._buildColumns(),
      data: [],

      // 启用范围选择
      selectableRange: 1,
      selectableRangeColumns: true,
      selectableRangeRows: true,
      selectableRangeClearCells: true,

      // 双击编辑单元格
      editTriggerEvent: "dblclick",

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

      // 禁用列排序
      headerSort: false,
      // 启用列调整大小
      resizableColumns: true,
      // 占位符文本
      placeholder: "暂无数据",
      // 渲染模式：basic (禁用虚拟 DOM，解决 hidden 容器报错问题)
      renderVertical: "basic",
      // 响应式列
      responsiveLayout: false,
    });

    // 异步加载数据
    requestAnimationFrame(() => {
      this.table.setData(this.tableData);
    });
  }

  /**
   * 构建列定义
   */
  _buildColumns() {
    const cols = [];

    // 添加数据列（使用列默认配置）
    this.columns.forEach((c) => {
      cols.push({
        title: c.field.toUpperCase(),
        field: c.field,
        headerHozAlign: "center",
        editor: "input",
        resizable: true,
        width: 100,
        headerSort: false,
        cellEdited: this._cellEdited.bind(this),
        rawData: c,
      });
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
    console.log("SQL 导出功能开发中...");
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
      console.log("已清除过滤和排序");
    }
  }

  /**
   * 根据 WHERE 子句过滤数据
   * @param {Array} data - 原始数据
   * @param {string} whereClause - WHERE 子句
   * @returns {Array} 过滤后的数据
   */
  filterByWhereClause(data, whereClause) {
    try {
      // 解析 WHERE 条件（不使用 eval 或 new Function）
      const condition = this.parseWhereCondition(whereClause);

      const filteredData = data.filter((row) => {
        try {
          return this.evaluateCondition(condition, row);
        } catch (error) {
          console.error("✗ 评估行时出错:", error.message);
          return false;
        }
      });
      return filteredData;
    } catch (error) {
      console.error("✗ WHERE 解析错误:", error.message);
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
    const orParts = this.splitByOperator(clause, "OR");
    if (orParts.length > 1) {
      return {
        type: "OR",
        conditions: orParts.map((part) => this.parseWhereCondition(part)),
      };
    }

    // 再处理 AND
    const andParts = this.splitByOperator(clause, "AND");
    if (andParts.length > 1) {
      return {
        type: "AND",
        conditions: andParts.map((part) => this.parseWhereCondition(part)),
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
    let current = "";
    let inQuote = false;
    let quoteChar = "";
    let i = 0;

    while (i < str.length) {
      const char = str[i];

      if ((char === '"' || char === "'") && (i === 0 || str[i - 1] !== "\\")) {
        if (!inQuote) {
          inQuote = true;
          quoteChar = char;
        } else if (char === quoteChar) {
          inQuote = false;
        }
        current += char;
        i++;
      } else if (
        !inQuote &&
        str.substr(i, operator.length + 2).toUpperCase() === ` ${operator} `
      ) {
        parts.push(current.trim());
        current = "";
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
      return { type: "IS_NULL", field: isNullMatch[1] };
    }

    const isNotNullMatch = expr.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i);
    if (isNotNullMatch) {
      return { type: "IS_NOT_NULL", field: isNotNullMatch[1] };
    }

    // 处理 LIKE
    const likeMatch = expr.match(/^(\w+)\s+LIKE\s+['"]([^'"]+)['"]$/i);
    if (likeMatch) {
      return { type: "LIKE", field: likeMatch[1], value: likeMatch[2] };
    }

    // 处理比较运算符: =, !=, <>, <, >, <=, >=
    const comparisonMatch = expr.match(/^(\w+)\s*(=|!=|<>|<=|>=|<|>)\s*(.+)$/);
    if (comparisonMatch) {
      let value = comparisonMatch[3].trim();

      // 移除引号
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      return {
        type: "COMPARISON",
        field: comparisonMatch[1],
        operator: comparisonMatch[2] === "<>" ? "!=" : comparisonMatch[2],
        value: value,
      };
    }

    throw new Error(`无法解析条件: ${expr}`);
  }

  /**
   * 评估条件
   */
  evaluateCondition(condition, row) {
    switch (condition.type) {
      case "AND":
        return condition.conditions.every((c) =>
          this.evaluateCondition(c, row)
        );

      case "OR":
        return condition.conditions.some((c) => this.evaluateCondition(c, row));

      case "IS_NULL":
        const nullValue = row[condition.field];
        return (
          nullValue === null || nullValue === undefined || nullValue === ""
        );

      case "IS_NOT_NULL":
        const notNullValue = row[condition.field];
        return (
          notNullValue !== null &&
          notNullValue !== undefined &&
          notNullValue !== ""
        );

      case "LIKE":
        const likeValue = row[condition.field];
        if (likeValue === null || likeValue === undefined) {
          return false;
        }
        return likeValue.toString().includes(condition.value);

      case "COMPARISON":
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
      return operator === "!=" && compareValue !== "";
    }

    // 转换为字符串进行比较
    const fieldStr = fieldValue.toString();
    const compareStr = compareValue.toString();

    // 尝试数值比较
    const fieldNum = parseFloat(fieldStr);
    const compareNum = parseFloat(compareStr);
    const isNumeric = !isNaN(fieldNum) && !isNaN(compareNum);

    switch (operator) {
      case "=":
        return isNumeric ? fieldNum === compareNum : fieldStr === compareStr;
      case "!=":
        return isNumeric ? fieldNum !== compareNum : fieldStr !== compareStr;
      case "<":
        return isNumeric ? fieldNum < compareNum : fieldStr < compareStr;
      case ">":
        return isNumeric ? fieldNum > compareNum : fieldStr > compareStr;
      case "<=":
        return isNumeric ? fieldNum <= compareNum : fieldStr <= compareStr;
      case ">=":
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
    const sortRules = orderByClause.split(",").map((rule) => {
      const parts = rule.trim().split(/\s+/);
      const field = parts[0];
      const direction = (parts[1] || "ASC").toUpperCase();
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
        if (aVal === null && bVal === null) {
          continue;
        }
        if (aVal === null) {
          return rule.direction === "ASC" ? 1 : -1;
        }
        if (bVal === null) {
          return rule.direction === "ASC" ? -1 : 1;
        }

        // 比较值
        let comparison = 0;
        if (typeof aVal === "string" && typeof bVal === "string") {
          comparison = aVal.localeCompare(bVal);
        } else {
          comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        }

        if (comparison !== 0) {
          return rule.direction === "DESC" ? -comparison : comparison;
        }
      }
      return 0;
    });

    return sortedData;
  }
}
