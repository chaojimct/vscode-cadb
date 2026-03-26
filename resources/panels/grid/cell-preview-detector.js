/**
 * 表格单元格内容预览：类型识别（与渲染逻辑分离，便于单独维护规则）
 * 依赖：无；通过 CadbCellPreviewDetector 暴露给 table.js / grid.js
 */
(function (global) {
  /**
   * @param {string} raw
   * @returns {{ pluginId: string, raw: string }}
   */
  function detectCellPreviewType(raw) {
    const s = raw == null ? "" : String(raw);
    const t = s.trim();
    if (t.length === 0) {
      return { pluginId: "preview-text", raw: s };
    }

    if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(t)) {
      return { pluginId: "preview-image", raw: t };
    }

    const oneLine = t.indexOf("\n") === -1 && t.indexOf("\r") === -1;
    if (oneLine && /^https?:\/\/\S+$/i.test(t)) {
      return { pluginId: "preview-url", raw: t };
    }

    const jsonCandidate = t.startsWith("{") || t.startsWith("[");
    if (jsonCandidate) {
      try {
        JSON.parse(t);
        return { pluginId: "preview-json", raw: t };
      } catch (_e) {
        /* 非合法 JSON 则按纯文本 */
      }
    }

    return { pluginId: "preview-text", raw: t };
  }

  global.CadbCellPreviewDetector = {
    detectCellPreviewType,
  };
})(typeof window !== "undefined" ? window : globalThis);
