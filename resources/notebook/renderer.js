(function() {
  const api = acquireNotebookRendererApi('cadb.sql-notebook-renderer');

  api.onDidCreateOutput((event) => {
    const output = event.output;
    const outputItem = output.items.find(item => 
      item.mime === 'application/x.sql-result' || item.mime === 'application/x.sql-error'
    );

    if (!outputItem) {
      return;
    }

    const data = JSON.parse(new TextDecoder().decode(outputItem.data));
    const container = document.createElement('div');
    container.className = 'sql-notebook-output';

    if (data.type === 'query-error') {
      // 渲染错误信息
      const errorDiv = document.createElement('div');
      errorDiv.className = 'sql-error';
      errorDiv.style.color = 'var(--vscode-errorForeground)';
      errorDiv.style.backgroundColor = 'var(--vscode-inputValidation-errorBackground)';
      errorDiv.style.padding = '8px';
      errorDiv.style.borderRadius = '4px';
      errorDiv.style.margin = '8px 0';
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

        // 表头
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.style.backgroundColor = 'var(--vscode-editor-background)';
        headerRow.style.borderBottom = '2px solid var(--vscode-panel-border)';
        
        data.columns.forEach((col: any) => {
          const th = document.createElement('th');
          th.textContent = col.name;
          th.style.padding = '6px 12px';
          th.style.textAlign = 'left';
          th.style.fontWeight = 'bold';
          headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // 表体
        const tbody = document.createElement('tbody');
        data.data.forEach((row: any, index: number) => {
          const tr = document.createElement('tr');
          tr.style.borderBottom = '1px solid var(--vscode-panel-border)';
          if (index % 2 === 0) {
            tr.style.backgroundColor = 'var(--vscode-editor-background)';
          } else {
            tr.style.backgroundColor = 'var(--vscode-list-inactiveSelectionBackground)';
          }

          data.columns.forEach((col: any) => {
            const td = document.createElement('td');
            td.textContent = row[col.name] !== null && row[col.name] !== undefined 
              ? String(row[col.name]) 
              : 'NULL';
            td.style.padding = '6px 12px';
            td.style.fontFamily = 'var(--vscode-editor-font-family)';
            td.style.fontSize = 'var(--vscode-editor-font-size)';
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
        infoDiv.textContent = `共 ${data.rowCount} 行 | 执行时间: ${data.executionTime.toFixed(3)}s`;
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
        const message = data.message || `执行成功，影响 ${data.rowCount} 行`;
        messageDiv.textContent = `✓ ${message}`;
        if (data.executionTime) {
          messageDiv.textContent += ` (${data.executionTime.toFixed(3)}s)`;
        }
        container.appendChild(messageDiv);
      }
    }

    event.element.appendChild(container);
  });
})();

