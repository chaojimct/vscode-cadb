// SQL Notebook 渲染器
// VSCode Notebook Renderer API
// 支持历史 Tab 切换、左侧收起/展开

function formatCellValue(value) {
  if (value === null || value === undefined) return { text: 'NULL', italic: true, muted: true };
  if (typeof value === 'object') {
    try {
      const s = JSON.stringify(value);
      return { text: s.length > 200 ? s.slice(0, 200) + '…' : s };
    } catch (e) {
      return { text: String(value) };
    }
  }
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(str) || (str.includes('T') && str.includes('Z'))) {
    const date = new Date(str);
    if (!isNaN(date.getTime())) {
      return { text: date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
    }
  }
  return { text: str };
}

/** 单元格原始值 → 复制用纯文本（与表格展示规则一致：NULL、日期本地化、对象 JSON 全文） */
function valueToCopyString(raw) {
  if (raw === null || raw === undefined) {
    return 'NULL';
  }
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch (_e) {
      return String(raw);
    }
  }
  const str = String(raw);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(str) || (str.includes('T') && str.includes('Z'))) {
    const date = new Date(str);
    if (!isNaN(date.getTime())) {
      return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
  }
  return str;
}

/** 双击将 getText() 写入剪贴板（不阻单次点击选中文本） */
function attachSqlResultCellCopy(el, getText) {
  if (!el || typeof getText !== 'function') {
    return;
  }
  const hint = '双击复制单元格内容';
  el.title = el.title ? `${el.title} · ${hint}` : hint;
  el.addEventListener('dblclick', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    let text;
    try {
      text = getText();
    } catch (_err) {
      text = '';
    }
    if (text === null || text === undefined) {
      text = '';
    } else {
      text = String(text);
    }
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      const prevO = el.style.outline;
      const prevOo = el.style.outlineOffset;
      el.style.outline = '2px solid var(--vscode-focusBorder)';
      el.style.outlineOffset = '1px';
      setTimeout(() => {
        el.style.outline = prevO;
        el.style.outlineOffset = prevOo;
      }, 450);
    } catch (_e2) {
      /* 复制失败时静默 */
    }
  });
}

function renderSingleResult(data, container) {
  container.style.padding = '8px';
  container.style.fontFamily = 'var(--vscode-editor-font-family)';
  if (data.type === 'query-error') {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'sql-error';
    errorDiv.style.cssText = 'color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); padding: 12px; border-radius: 4px; border: 1px solid var(--vscode-inputValidation-errorBorder); margin-top: 8px;';
    errorDiv.textContent = `❌ 错误: ${data.error}`;
    container.appendChild(errorDiv);
    return;
  }
  if (data.columns && data.columns.length > 0 && data.data && data.data.length > 0) {
    const table = document.createElement('table');
    table.className = 'sql-result-table sql-result-table-resizable';
    table.style.cssText = 'width: 100%; table-layout: fixed; border-collapse: collapse; margin-top: 8px; font-size: 13px; border: 1px solid var(--vscode-panel-border);';
    const colgroup = document.createElement('colgroup');
    const cols = [];
    data.columns.forEach(() => {
      const col = document.createElement('col');
      col.style.minWidth = '60px';
      col.style.width = '120px';
      col.style.maxWidth = '400px';
      colgroup.appendChild(col);
      cols.push(col);
    });
    table.appendChild(colgroup);
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.style.cssText = 'background: var(--vscode-editor-background); border-bottom: 2px solid var(--vscode-panel-border);';
    data.columns.forEach((col, i) => {
      const th = document.createElement('th');
      th.style.position = 'relative';
      th.style.padding = '8px 12px';
      th.style.textAlign = 'left';
      th.style.fontWeight = 'bold';
      th.style.color = 'var(--vscode-foreground)';
      th.style.borderRight = '1px solid var(--vscode-panel-border)';
      th.style.overflow = 'hidden';
      th.style.textOverflow = 'ellipsis';
      const label = document.createElement('span');
      label.textContent = col.name;
      th.appendChild(label);
      if (i < data.columns.length - 1) {
        const handle = document.createElement('div');
        handle.className = 'sql-result-col-resize-handle';
        handle.title = '拖拽调节列宽';
        handle.style.cssText = 'position:absolute; right:0; top:0; bottom:0; width:6px; cursor:col-resize; z-index:1;';
        handle.addEventListener('mouseenter', () => { handle.style.background = 'var(--vscode-focusBorder)'; });
        handle.addEventListener('mouseleave', () => { handle.style.background = ''; });
        const colEl = cols[i];
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = parseInt(colEl.style.width) || 120;
          const onMove = (ev) => {
            const newW = Math.min(400, Math.max(60, startW + (ev.clientX - startX)));
            colEl.style.width = newW + 'px';
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
          };
          document.body.style.cursor = 'col-resize';
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
        th.appendChild(handle);
      }
      attachSqlResultCellCopy(th, () => col.name);
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    data.data.forEach((row) => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--vscode-panel-border)';
      tr.addEventListener('mouseenter', () => { tr.style.backgroundColor = 'var(--vscode-list-hoverBackground)'; });
      tr.addEventListener('mouseleave', () => { tr.style.backgroundColor = ''; });
      data.columns.forEach((col) => {
        const td = document.createElement('td');
        const v = formatCellValue(row[col.name]);
        td.textContent = v.text;
        td.style.cssText = 'padding: 6px 12px; color: ' + (v.muted ? 'var(--vscode-disabledForeground)' : 'var(--vscode-foreground)') + '; font-style: ' + (v.italic ? 'italic' : '') + '; border-right: 1px solid var(--vscode-panel-border); max-width: 220px; overflow: hidden; text-overflow: ellipsis; user-select: text;';
        const rawVal = row[col.name];
        attachSqlResultCellCopy(td, () => valueToCopyString(rawVal));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'margin-top: 12px; padding: 8px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); border-radius: 4px; color: var(--vscode-descriptionForeground); font-size: 12px;';
    infoDiv.textContent = `✓ 查询成功，共 ${data.rowCount} 行`;
    if (data.executionTime !== undefined) infoDiv.textContent += ` | 执行时间: ${data.executionTime.toFixed(3)}s`;
    if (data.message) infoDiv.textContent += ` | ${data.message}`;
    container.appendChild(infoDiv);
  } else {
    const messageDiv = document.createElement('div');
    messageDiv.style.cssText = 'margin-top: 8px; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-charts-green); border-radius: 4px;';
    const msg = data.message || `执行成功，影响 ${data.rowCount || 0} 行`;
    messageDiv.textContent = `✓ ${msg}`;
    if (data.executionTime !== undefined) messageDiv.textContent += ` (${data.executionTime.toFixed(3)}s)`;
    container.appendChild(messageDiv);
  }
}

function setAllOutputsExpanded(expanded) {
  document.querySelectorAll('.sql-notebook-output-wrapper').forEach((w) => {
    const tw = w.querySelector('.sql-notebook-output-toggle');
    const cw = w.querySelector('.sql-notebook-output-content');
    if (tw && cw) {
      cw.style.display = expanded ? '' : 'none';
      tw.textContent = expanded ? '▼' : '▶';
      tw.dataset.expanded = expanded ? '1' : '0';
    }
  });
}

function createCollapsibleWrapper(contentEl) {
  const wrapper = document.createElement('div');
  wrapper.className = 'sql-notebook-output-wrapper';
  wrapper.style.cssText = 'display: flex; width: 100%; min-height: 24px; align-items: flex-start;';

  const toolbar = document.createElement('div');
  toolbar.className = 'sql-notebook-output-toolbar';
  toolbar.style.cssText = 'display: flex; align-items: flex-start; gap: 2px; padding: 2px 4px; flex-shrink: 0; border-right: 1px solid var(--vscode-panel-border, transparent);';

  const toggle = document.createElement('div');
  toggle.className = 'sql-notebook-output-toggle';
  toggle.title = '点击收起/展开';
  toggle.style.cssText = 'width: 20px; min-width: 20px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--vscode-foreground); opacity: 0.7; user-select: none; font-size: 10px; transition: background-color 0.15s;';
  toggle.textContent = '▼';

  const contentWrap = document.createElement('div');
  contentWrap.className = 'sql-notebook-output-content';
  contentWrap.style.flex = '1';
  contentWrap.style.overflow = 'auto';
  contentWrap.style.minWidth = '0';
  contentWrap.appendChild(contentEl);

  toolbar.appendChild(toggle);

  toggle.addEventListener('mouseenter', () => { toggle.style.backgroundColor = 'var(--vscode-list-hoverBackground)'; });
  toggle.addEventListener('mouseleave', () => { toggle.style.backgroundColor = ''; });

  let expanded = true;
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    contentWrap.style.display = expanded ? '' : 'none';
    toggle.textContent = expanded ? '▼' : '▶';
  });

  wrapper.appendChild(toolbar);
  wrapper.appendChild(contentWrap);
  return wrapper;
}

/** 渲染器向扩展发消息（删除历史结果等），由 requiresMessaging: always 提供 */
let postMessageToExtension = null;

export function activate(context) {
  if (typeof context?.postMessage === 'function') {
    postMessageToExtension = context.postMessage.bind(context);
  }
  if (context.onDidReceiveMessage) {
    context.onDidReceiveMessage((e) => {
      const msg = (e && typeof e === 'object' && 'message' in e) ? e.message : e;
      if (msg && msg.type === 'collapseAll') setAllOutputsExpanded(false);
      else if (msg && msg.type === 'expandAll') setAllOutputsExpanded(true);
    });
  }
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

        const hasExecErr =
          data.type === 'query-results' &&
          typeof data.executionError === 'string' &&
          data.executionError.length > 0;
        if (
          data.type === 'query-results' &&
          Array.isArray(data.results) &&
          (data.results.length > 0 || hasExecErr)
        ) {
          // 多结果：可选「本次执行错误」横幅 + Tab 栏（最新在左）+ 内容区 + 调节手柄
          const DEFAULT_HEIGHT = 280;
          const MIN_HEIGHT = 120;
          const MAX_HEIGHT = 800;

          const wrapper = document.createElement('div');
          wrapper.className = 'sql-notebook-results-wrapper';
          wrapper.style.cssText = 'display: flex; flex-direction: column; width: 100%;';

          if (hasExecErr) {
            const errBanner = document.createElement('div');
            errBanner.className = 'sql-notebook-exec-error-banner';
            errBanner.style.cssText =
              'color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); padding: 8px 12px; border-radius: 4px; border: 1px solid var(--vscode-inputValidation-errorBorder); margin-bottom: 8px; font-size: 12px; flex-shrink: 0;';
            errBanner.textContent = `❌ 本次执行失败（未记入历史）：${data.executionError}`;
            wrapper.appendChild(errBanner);
          }

          const tabBar = document.createElement('div');
          tabBar.className = 'sql-result-tabs';
          tabBar.style.cssText = `
            display: flex;
            gap: 4px;
            padding: 4px 0 8px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 8px;
            flex-shrink: 0;
            overflow-x: auto;
            overflow-y: hidden;
            white-space: nowrap;
            scrollbar-width: none;
            -ms-overflow-style: none;
            align-items: stretch;
          `;
          tabBar.addEventListener('wheel', (e) => {
            const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            tabBar.scrollLeft += delta;
            e.preventDefault();
          }, { passive: false });

          const contentArea = document.createElement('div');
          contentArea.className = 'sql-result-tab-content';
          contentArea.style.cssText = `
            height: ${DEFAULT_HEIGHT}px;
            min-height: ${MIN_HEIGHT}px;
            overflow: auto;
            flex-shrink: 0;
          `;

          const resizeHandle = document.createElement('div');
          resizeHandle.className = 'sql-result-resize-handle';
          resizeHandle.title = '拖拽调节高度';
          resizeHandle.style.cssText = `
            height: 6px;
            cursor: ns-resize;
            background: var(--vscode-panel-border);
            flex-shrink: 0;
            margin: 2px 0;
            border-radius: 2px;
            transition: background 0.15s;
          `;
          resizeHandle.addEventListener('mouseenter', () => { resizeHandle.style.background = 'var(--vscode-focusBorder)'; });
          resizeHandle.addEventListener('mouseleave', () => { resizeHandle.style.background = ''; });

          let startY = 0, startH = 0;
          resizeHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startY = e.clientY;
            startH = contentArea.offsetHeight;
            const onMove = (ev) => {
              const dy = ev.clientY - startY;
              const newH = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH + dy));
              contentArea.style.height = newH + 'px';
            };
            const onUp = () => {
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
            };
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          });

          const results = data.results;
          let selectedIndex = results.length > 0 ? results.length - 1 : 0;
          const ensureTabVisible = (tabRowEl) => {
            if (!tabRowEl) return;
            const left = tabRowEl.offsetLeft;
            const right = left + tabRowEl.offsetWidth;
            const viewLeft = tabBar.scrollLeft;
            const viewRight = viewLeft + tabBar.clientWidth;
            if (left < viewLeft) tabBar.scrollLeft = left;
            else if (right > viewRight) tabBar.scrollLeft = right - tabBar.clientWidth;
          };

          const applyTabStyles = () => {
            tabBar.querySelectorAll('.sql-result-tab-label').forEach((t) => {
              const i = parseInt(t.dataset.idx, 10);
              const on = i === selectedIndex;
              t.style.backgroundColor = on ? 'var(--vscode-list-activeSelectionBackground)' : '';
              t.style.color = on ? 'var(--vscode-list-activeSelectionForeground)' : '';
            });
          };

          const canDelete =
            postMessageToExtension &&
            data.cadbRef &&
            typeof data.cadbRef.notebookUri === 'string' &&
            typeof data.cadbRef.cellIndex === 'number';

          // 最新结果在最左边：按索引从大到小追加 tab + 删除按钮
          for (let idx = results.length - 1; idx >= 0; idx--) {
            const r = results[idx];
            const row = document.createElement('div');
            row.className = 'sql-result-tab-row';
            row.style.cssText =
              'display: inline-flex; align-items: stretch; flex: 0 0 auto; border-radius: 4px; overflow: hidden; border: 1px solid var(--vscode-panel-border);';

            const tab = document.createElement('div');
            const isError = r.type === 'query-error';
            const label = isError ? `结果 #${idx + 1} (错误)` : `结果 #${idx + 1} (${(r.executionTime ?? 0).toFixed(2)}s)`;
            tab.className = 'sql-result-tab-label';
            tab.textContent = label;
            tab.dataset.idx = String(idx);
            tab.style.cssText = `
              padding: 4px 10px;
              font-size: 12px;
              cursor: pointer;
              transition: background 0.15s;
              flex: 0 0 auto;
              display: flex;
              align-items: center;
            `;
            if (idx === selectedIndex) {
              tab.style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
              tab.style.color = 'var(--vscode-list-activeSelectionForeground)';
            }

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'sql-result-tab-delete';
            delBtn.title = '删除此条结果';
            delBtn.setAttribute('aria-label', '删除此条结果');
            delBtn.textContent = '×';
            delBtn.style.cssText =
              'width: 22px; min-width: 22px; padding: 0; margin: 0; border: none; border-left: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); color: var(--vscode-foreground); cursor: pointer; font-size: 16px; line-height: 1; display: flex; align-items: center; justify-content: center;';
            delBtn.addEventListener('mouseenter', () => {
              delBtn.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
            });
            delBtn.addEventListener('mouseleave', () => {
              delBtn.style.backgroundColor = 'var(--vscode-editor-background)';
            });
            if (canDelete) {
              delBtn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                postMessageToExtension({
                  type: 'deleteSqlResult',
                  notebookUri: data.cadbRef.notebookUri,
                  cellIndex: data.cadbRef.cellIndex,
                  resultIndex: idx,
                });
              });
            } else {
              delBtn.style.display = 'none';
            }

            tab.addEventListener('click', () => {
              selectedIndex = parseInt(tab.dataset.idx, 10);
              applyTabStyles();
              contentArea.innerHTML = '';
              const inner = document.createElement('div');
              renderSingleResult(results[selectedIndex], inner);
              contentArea.appendChild(inner);
              ensureTabVisible(row);
            });
            tab.addEventListener('mouseenter', () => {
              if (idx !== selectedIndex) tab.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
            });
            tab.addEventListener('mouseleave', () => {
              if (idx !== selectedIndex) tab.style.backgroundColor = '';
            });

            row.appendChild(tab);
            row.appendChild(delBtn);
            tabBar.appendChild(row);
          }

          if (tabBar.firstElementChild) {
            ensureTabVisible(tabBar.firstElementChild);
          }

          if (results.length > 0) {
            const innerContent = document.createElement('div');
            renderSingleResult(results[selectedIndex], innerContent);
            contentArea.appendChild(innerContent);
          }

          wrapper.appendChild(tabBar);
          wrapper.appendChild(contentArea);
          wrapper.appendChild(resizeHandle);
          container.appendChild(wrapper);

          const collapsible = createCollapsibleWrapper(container);
          element.innerHTML = '';
          element.appendChild(collapsible);
          return;
        }

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
            const table = document.createElement('table');
            table.className = 'sql-result-table sql-result-table-resizable';
            table.style.cssText = 'width: 100%; table-layout: fixed; border-collapse: collapse; margin-top: 8px; font-size: 13px; border: 1px solid var(--vscode-panel-border);';
            const colgroup = document.createElement('colgroup');
            const cols = [];
            data.columns.forEach(() => {
              const col = document.createElement('col');
              col.style.minWidth = '60px';
              col.style.width = '120px';
              col.style.maxWidth = '400px';
              colgroup.appendChild(col);
              cols.push(col);
            });
            table.appendChild(colgroup);
            const thead = document.createElement('thead');
            const headerRow = document.createElement('tr');
            headerRow.style.cssText = 'background: var(--vscode-editor-background); border-bottom: 2px solid var(--vscode-panel-border);';
            data.columns.forEach((col, i) => {
              const th = document.createElement('th');
              th.style.position = 'relative';
              th.style.cssText = 'padding: 8px 12px; text-align: left; font-weight: bold; color: var(--vscode-foreground); border-right: 1px solid var(--vscode-panel-border); overflow: hidden; text-overflow: ellipsis;';
              th.appendChild(document.createTextNode(col.name));
              if (i < data.columns.length - 1) {
                const handle = document.createElement('div');
                handle.title = '拖拽调节列宽';
                handle.style.cssText = 'position:absolute; right:0; top:0; bottom:0; width:6px; cursor:col-resize; z-index:1;';
                handle.addEventListener('mousedown', (e) => {
                  e.preventDefault();
                  const startX = e.clientX;
                  const startW = parseInt(cols[i].style.width) || 120;
                  const onMove = (ev) => {
                    const newW = Math.min(400, Math.max(60, startW + (ev.clientX - startX)));
                    cols[i].style.width = newW + 'px';
                  };
                  const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    document.body.style.cursor = '';
                  };
                  document.body.style.cursor = 'col-resize';
                  document.addEventListener('mousemove', onMove);
                  document.addEventListener('mouseup', onUp);
                });
                th.appendChild(handle);
              }
              attachSqlResultCellCopy(th, () => col.name);
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
                const fmt = formatCellValue(value);
                td.textContent = fmt.text;
                td.style.cssText = 'padding: 6px 12px; color: ' + (fmt.muted ? 'var(--vscode-disabledForeground)' : 'var(--vscode-foreground)') + '; font-style: ' + (fmt.italic ? 'italic' : '') + '; border-right: 1px solid var(--vscode-panel-border); max-width: 220px; overflow: hidden; text-overflow: ellipsis; user-select: text;';
                attachSqlResultCellCopy(td, () => valueToCopyString(value));
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

        // 用可收起/展开的包装器包裹，左侧可点击切换
        const wrapper = createCollapsibleWrapper(container);
        element.innerHTML = '';
        element.appendChild(wrapper);
      } catch (error) {
        console.error('[SQL Notebook Renderer] Error rendering output:', error);
        element.innerHTML = `<div style="color: var(--vscode-errorForeground); padding: 8px;">渲染错误: ${error.message}</div>`;
      }
    }
  };
}
