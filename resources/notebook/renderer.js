// Notebook 渲染器脚本
// 用于渲染 SQL 查询结果和错误信息

(function () {
  const notebookApi = acquireNotebookRendererApi('cadb.sql-notebook-renderer');

  notebookApi.onDidCreateOutputItem(({ item, element }) => {
    try {
      // 解析数据
      let data;
      const decoder = new TextDecoder();
      const text = decoder.decode(item.data());
      
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error('Failed to parse output data:', e);
        element.textContent = '无法解析输出数据';
        return;
      }

      // 创建容器
      const container = document.createElement('div');
      container.className = 'sql-notebook-output';
      container.style.padding = '8px';
      container.style.fontFamily = 'var(--vscode-editor-font-family)';

      if (data.type === 'query-error') {
        // 渲染错误信息
        const errorDiv = document.createElement('div');
        errorDiv.className = 'sql-error';
        errorDiv.style.color = 'var(--vscode-errorForeground)';
        errorDiv.style.backgroundColor = 'var(--vscode-inputValidation-errorBackground)';
        errorDiv.style.padding = '8px';
        errorDiv.style.borderRadius = '4px';
        errorDiv.style.border = '1px solid var(--vscode-inputValidation-errorBorder)';
        errorDiv.textContent = `❌ 错误: ${data.error}`;
        container.appendChild(errorDiv);
      } else if (data.type === 'query-result') {
        // 渲染查询结果
        if (data.columns && data.columns.length > 0 && data.data && data.data.length > 0) {
          // 创建表格
          const table = document.createElement('table');
          table.className = 'sql-result-table';
          table.style.width = '100%';
          table.style.borderCollapse = 'collapse';
          table.style.margin = '8px 0';
          table.style.fontSize = '13px';

          // 表头
          const thead = document.createElement('thead');
          const headerRow = document.createElement('tr');
          headerRow.style.backgroundColor = 'var(--vscode-editor-background)';
          headerRow.style.borderBottom = '2px solid var(--vscode-panel-border)';

          data.columns.forEach((col) => {
            const th = document.createElement('th');
            th.textContent = col.name;
            th.style.padding = '8px 12px';
            th.style.textAlign = 'left';
            th.style.fontWeight = 'bold';
            th.style.color = 'var(--vscode-foreground)';
            headerRow.appendChild(th);
          });
          thead.appendChild(headerRow);
          table.appendChild(thead);

          // 表体
          const tbody = document.createElement('tbody');
          data.data.forEach((row) => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid var(--vscode-panel-border)';

            data.columns.forEach((col) => {
              const td = document.createElement('td');
              const value = row[col.name];
              td.textContent = value !== null && value !== undefined ? String(value) : 'NULL';
              td.style.padding = '6px 12px';
              td.style.color = 'var(--vscode-foreground)';
              if (value === null || value === undefined) {
                td.style.fontStyle = 'italic';
                td.style.color = 'var(--vscode-disabledForeground)';
              }
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);
          container.appendChild(table);

          // 显示行数和执行时间
          const infoDiv = document.createElement('div');
          infoDiv.className = 'sql-result-info';
          infoDiv.style.marginTop = '8px';
          infoDiv.style.color = 'var(--vscode-descriptionForeground)';
          infoDiv.style.fontSize = '12px';
          infoDiv.textContent = `共 ${data.rowCount} 行`;
          if (data.executionTime !== undefined) {
            infoDiv.textContent += ` | 执行时间: ${data.executionTime.toFixed(3)}s`;
          }
          if (data.message) {
            infoDiv.textContent += ` | ${data.message}`;
          }
          container.appendChild(infoDiv);
        } else {
          // 非查询语句的结果
          const messageDiv = document.createElement('div');
          messageDiv.className = 'sql-result-message';
          messageDiv.style.padding = '8px';
          messageDiv.style.color = 'var(--vscode-foreground)';
          messageDiv.style.backgroundColor = 'var(--vscode-textBlockQuote-background)';
          messageDiv.style.borderLeft = '3px solid var(--vscode-textBlockQuote-border)';
          messageDiv.style.borderRadius = '4px';
          
          const message = data.message || `执行成功，影响 ${data.rowCount || 0} 行`;
          messageDiv.textContent = `✓ ${message}`;
          if (data.executionTime !== undefined) {
            messageDiv.textContent += ` (${data.executionTime.toFixed(3)}s)`;
          }
          container.appendChild(messageDiv);
        }
      }

      element.appendChild(container);
    } catch (error) {
      console.error('Error rendering notebook output:', error);
      element.textContent = `渲染错误: ${error.message}`;
    }
  });
})();
