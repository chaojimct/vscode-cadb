import type { PreviewPluginRegistration } from "./types";

const PREVIEW_PLUGINS: PreviewPluginRegistration[] = [
  {
    id: "preview-json",
    dataFormatLabel: "JSON",
    description: "识别以 { 或 [ 开头的 JSON 文本；侧栏预览使用 npm 包 jsoneditor（只读 view 模式）",
    npmDependencyNames: ["jsoneditor"],
  },
  {
    id: "preview-image",
    dataFormatLabel: "图片（Data URL）",
    description: "识别 data:image/* 的 Data URL",
  },
  {
    id: "preview-url",
    dataFormatLabel: "网页链接",
    description: "识别 http(s):// 单行 URL",
  },
  {
    id: "preview-text",
    dataFormatLabel: "纯文本",
    description: "其它内容按纯文本展示",
  },
];

export function listRegisteredPreviewPlugins(): PreviewPluginRegistration[] {
  return [...PREVIEW_PLUGINS];
}

export function getRegisteredPreviewPlugin(
  id: string
): PreviewPluginRegistration | undefined {
  return PREVIEW_PLUGINS.find((p) => p.id === id);
}
