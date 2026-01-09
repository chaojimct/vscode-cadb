// SQL Notebook 渲染器
// VSCode Notebook Renderer API

export function activate(context) {
  return {
    renderOutputItem(outputItem, element) {
      try {
        // 解析数据
        let data;
        const decoder = new TextDecoder();
        const bytes = outputItem.data();
        const text = decoder.decode(bytes);
        try {
          data = JSON.parse(text);
        } catch (e) {
          console.error('[SQL Notebook Renderer] Failed to parse JSON:', e);
          element.textContent = '无法解析输出数据: ' + e.message;
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
          errorDiv.style.padding = '12px';
          errorDiv.style.borderRadius = '4px';
          errorDiv.style.border = '1px solid var(--vscode-inputValidation-errorBorder)';
          errorDiv.style.marginTop = '8px';
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
            table.style.marginTop = '8px';
            table.style.fontSize = '13px';
            table.style.border = '1px solid var(--vscode-panel-border)';

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
              th.style.borderRight = '1px solid var(--vscode-panel-border)';
              headerRow.appendChild(th);
            });
            thead.appendChild(headerRow);
            table.appendChild(thead);

            // 表体
            const tbody = document.createElement('tbody');
            data.data.forEach((row, rowIndex) => {
              const tr = document.createElement('tr');
              tr.style.borderBottom = '1px solid var(--vscode-panel-border)';
              
              // 鼠标悬停效果
              tr.addEventListener('mouseenter', () => {
                tr.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
              });
              tr.addEventListener('mouseleave', () => {
                tr.style.backgroundColor = '';
              });

              data.columns.forEach((col, colIndex) => {
                const td = document.createElement('td');
                const value = row[col.name];
                
                // 格式化显示值
                if (value === null || value === undefined) {
                  td.textContent = 'NULL';
                  td.style.fontStyle = 'italic';
                  td.style.color = 'var(--vscode-disabledForeground)';
                } else if (typeof value === 'string' && value.includes('T') && value.includes('Z')) {
                  // 可能是日期时间
                  try {
                    const date = new Date(value);
                    td.textContent = date.toLocaleString('zh-CN', { 
                      year: 'numeric', 
                      month: '2-digit', 
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit'
                    });
                  } catch (e) {
                    td.textContent = String(value);
                  }
                } else {
                  td.textContent = String(value);
                }
                
                td.style.padding = '6px 12px';
                td.style.color = 'var(--vscode-foreground)';
                td.style.borderRight = '1px solid var(--vscode-panel-border)';
                tr.appendChild(td);
              });
              tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            container.appendChild(table);

            // 显示行数和执行时间
            const infoDiv = document.createElement('div');
            infoDiv.className = 'sql-result-info';
            infoDiv.style.marginTop = '12px';
            infoDiv.style.padding = '8px';
            infoDiv.style.backgroundColor = 'var(--vscode-textBlockQuote-background)';
            infoDiv.style.borderLeft = '3px solid var(--vscode-textBlockQuote-border)';
            infoDiv.style.borderRadius = '4px';
            infoDiv.style.color = 'var(--vscode-descriptionForeground)';
            infoDiv.style.fontSize = '12px';
            infoDiv.textContent = `✓ 查询成功，共 ${data.rowCount} 行`;
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
            messageDiv.style.marginTop = '8px';
            messageDiv.style.padding = '12px';
            messageDiv.style.color = 'var(--vscode-foreground)';
            messageDiv.style.backgroundColor = 'var(--vscode-textBlockQuote-background)';
            messageDiv.style.borderLeft = '3px solid var(--vscode-charts-green)';
            messageDiv.style.borderRadius = '4px';
            
            const message = data.message || `执行成功，影响 ${data.rowCount || 0} 行`;
            messageDiv.textContent = `✓ ${message}`;
            if (data.executionTime !== undefined) {
              messageDiv.textContent += ` (${data.executionTime.toFixed(3)}s)`;
            }
            container.appendChild(messageDiv);
          }
        }

        // 清空元素并添加新内容
        element.innerHTML = '';
        element.appendChild(container);
      } catch (error) {
        console.error('[SQL Notebook Renderer] Error rendering output:', error);
        element.innerHTML = `<div style="color: var(--vscode-errorForeground); padding: 8px;">渲染错误: ${error.message}</div>`;
      }
    }
  };
}
