import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, ImageRun, Document } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { AgentToolHandler } from '../agent.js';

// pptxgenjs 的 d.ts（export as namespace + export default）在 NodeNext 下会解析成
// 模块命名空间而非可构造类（TS2351）。用结构性构造器类型规避 import() 类型注解。
type PptxGenJSConstructor = new () => {
  layout: string;
  defineLayout(layout: { name: string; width: number; height: number }): void;
  addSlide(): {
    addText(
      text: string | Array<{ text: string; options: { bullet?: boolean; breakLine?: boolean } }>,
      options: Record<string, unknown>,
    ): void;
  };
  write(opts: { outputType: string; compression?: boolean }): Promise<unknown>;
};
const PptxGenJSClass = PptxGenJS as unknown as PptxGenJSConstructor;

/**
 * Office 产出物生成工具（T6）
 *
 * 生成 docx / xlsx / pptx / pdf 四种新格式文件（全部为宽松许可库）：
 * - docx  → `docx` (MIT)
 * - xlsx  → `exceljs` (MIT)
 * - pptx  → `pptxgenjs` (MIT)
 * - pdf   → `pdf-lib` (MIT) + `@pdf-lib/fontkit` (MIT)，中文嵌入系统 CJK 字体；
 *           可选 `printHtmlToPdf`（Electron printToPDF）回调用于 HTML 渲染。
 *
 * Agent 调用入口：`office_generate(format, output_path, content, ...)`。
 * 成功生成后会自动通过 `deliverableCreate` 登记为 source='agent' 交付物，
 * 从而被现有预览链路（产出物页 / RightPanel）展示。
 */

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf';

export const OFFICE_FORMATS: OfficeFormat[] = ['docx', 'xlsx', 'pptx', 'pdf'];

export interface OfficeTableSpec {
  headers?: string[];
  rows?: Array<Array<string | number>>;
}

export interface OfficeSheetSpec {
  name?: string;
  headers?: string[];
  rows?: Array<Array<string | number>>;
}

export interface OfficeSlideSpec {
  title?: string;
  bullets?: string[];
}

/** 结构化文档内容 —— 各格式按需取用对应字段。 */
export interface OfficeContentSpec {
  /** 文档标题：docx 标题段 / pptx 标题页 / pdf 首页大标题 / xlsx 默认 sheet 名。 */
  title?: string;
  /** 一个或多个正文段落。 */
  paragraph?: string | string[];
  paragraphs?: string | string[];
  /** 项目符号列表。 */
  bullets?: string[];
  /** 表格（docx / xlsx）。 */
  table?: OfficeTableSpec;
  /** 多个工作表（xlsx），每表含 headers + rows。 */
  sheets?: OfficeSheetSpec[];
  /** 多张幻灯片（pptx），每张含 title + bullets。 */
  slides?: OfficeSlideSpec[];
  /** HTML 内容（可选）—— 配合 printHtmlToPdf 回调走 Electron printToPDF。 */
  html?: string;
  /** 显式指定嵌入字体（PDF 中文需要；默认自动探测系统 CJK 字体）。 */
  fontPath?: string;
  /** docx 插图（可选）：图片文件的绝对路径。 */
  imagePath?: string;
}

export interface OfficeGenerateOptions {
  /** 输出文件绝对路径（父目录不存在会自动创建）。 */
  outputPath: string;
  /** 结构化内容。 */
  content: OfficeContentSpec;
  /** 显式 CJK 字体候选列表（覆盖系统默认探测，主要用于测试与特殊环境）。 */
  cjkFontCandidates?: string[];
  /** Electron printToPDF 回调：提供后 content.html 走该路径生成 PDF。 */
  printHtmlToPdf?: (html: string, outputPath: string) => Promise<void>;
}

export interface OfficeGenerateResult {
  outputPath: string;
  format: OfficeFormat;
  size: number;
}

export interface OfficeDeliverableBridge {
  create(opts: {
    type: string;
    title: string;
    summary: string;
    reference?: string;
    format?: string;
    tags?: string;
    projectId?: string;
  }): Promise<{ id: string; type: string; title: string; status: string }>;
}

export interface OfficeGenerateToolContext {
  agentId: string;
  webUiBaseUrl?: string;
  deliverableCreate?: OfficeDeliverableBridge['create'];
  cjkFontCandidates?: string[];
  printHtmlToPdf?: (html: string, outputPath: string) => Promise<void>;
}

export class OfficeGenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeGenerateError';
  }
}

// ─── 工具函数 ────────────────────────────────────────────────────────────

function normText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function asStringArray(v: unknown): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.map(normText);
  return undefined;
}

function pick(args: Record<string, unknown>, key: string): unknown {
  const content =
    args['content'] && typeof args['content'] === 'object' && !Array.isArray(args['content'])
      ? (args['content'] as Record<string, unknown>)
      : {};
  return args[key] ?? content[key];
}

function cellText(v: string | number): string | number {
  return typeof v === 'number' && Number.isFinite(v) ? v : normText(v);
}

// ─── PDF 中文支持：系统 CJK 字体探测 ──────────────────────────────────────

const DEFAULT_CJK_FONT_CANDIDATES = [
  // macOS
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  // Windows
  'C:/Windows/Fonts/msyh.ttf',
  'C:/Windows/Fonts/simhei.ttf',
  // Linux（常见 Noto CJK 单字面 TTF 路径）
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
];

const CJK_RE = /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/** 探测第一个存在的汉字字体文件（.ttf/.otf 单字面优先；.ttc 需要 postscript 名，默认跳过）。 */
export function findCjkFontPath(candidates: string[] = DEFAULT_CJK_FONT_CANDIDATES): string | undefined {
  const ttfCandidates = candidates.filter((p) => /\.(ttf|otf)$/i.test(p));
  for (const p of ttfCandidates) {
    if (existsSync(p)) return p;
  }
  // 回退：ttc 集合（pdf-lib 无法直接嵌入，故仅在有显式 fontPath 时尝试）
  return undefined;
}

function collectPdfText(content: OfficeContentSpec): string {
  const parts: string[] = [content.title ?? ''];
  for (const p of asStringArray(content.paragraph ?? content.paragraphs) ?? []) parts.push(p);
  for (const b of content.bullets ?? []) parts.push(b);
  return parts.join(' ');
}

function ensureParentDir(outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
}

// ─── docx（docx, MIT） ─────────────────────────────────────────────────

async function generateDocx(outputPath: string, content: OfficeContentSpec): Promise<void> {
  const children: unknown[] = [];

  if (content.title) {
    children.push(new Paragraph({ text: content.title, heading: HeadingLevel.TITLE }));
  }

  const paragraphs = asStringArray(content.paragraph ?? content.paragraphs) ?? [];
  for (const p of paragraphs) {
    children.push(new Paragraph({ children: [new TextRun(p)] }));
  }

  for (const b of content.bullets ?? []) {
    children.push(new Paragraph({ text: b, bullet: { level: 0 } }));
  }

  if (content.table) {
    const { headers = [], rows = [] } = content.table;
    if (headers.length > 0 || rows.length > 0) {
      const rowChildren: TableRow[] = [];
      if (headers.length > 0) {
        rowChildren.push(
          new TableRow({
            tableHeader: true,
            children: headers.map(
              (h) =>
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun({ text: normText(h), bold: true })] })],
                  shading: { fill: 'F2F2F2' },
                }),
            ),
          }),
        );
      }
      for (const r of rows) {
        rowChildren.push(
          new TableRow({
            children: r.map((c) => new TableCell({ children: [new Paragraph({ text: normText(c) })] })),
          }),
        );
      }
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rowChildren,
        }),
      );
    }
  }

  if (content.imagePath) {
    if (!existsSync(content.imagePath)) {
      throw new OfficeGenerateError(`图片不存在：${content.imagePath}`);
    }
    const img = readFileSync(content.imagePath);
    children.push(
      new Paragraph({
        children: [
          new ImageRun({
            type: 'png',
            data: img,
            transformation: { width: 240, height: 180 },
          }),
        ],
      }),
    );
  }

  if (children.length === 0) {
    throw new OfficeGenerateError('内容为空：docx 需要 title/paragraphs/bullets/table/imagePath 至少一项');
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: children as never[],
      },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  ensureParentDir(outputPath);
  writeFileSync(outputPath, buf);
}

// ─── xlsx（exceljs, MIT） ──────────────────────────────────────────────

async function generateXlsx(outputPath: string, content: OfficeContentSpec): Promise<void> {
  let sheets: OfficeSheetSpec[] = [];
  if (Array.isArray(content.sheets) && content.sheets.length > 0) {
    sheets = content.sheets;
  } else if (content.table && ((content.table.headers?.length ?? 0) > 0 || (content.table.rows?.length ?? 0) > 0)) {
    sheets = [{ name: content.title || 'Sheet1', headers: content.table.headers, rows: content.table.rows }];
  }

  if (sheets.length === 0) {
    throw new OfficeGenerateError('内容为空：xlsx 需要 sheets 或 table 至少一个工作表');
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Markus Agent';
  for (let i = 0; i < sheets.length; i++) {
    const spec = sheets[i];
    const ws = wb.addWorksheet(spec.name || `Sheet${i + 1}`);
    const headers = spec.headers ?? [];
    const rows = spec.rows ?? [];
    if (headers.length > 0) {
      const headerRow = ws.addRow(headers.map((h) => normText(h)));
      headerRow.font = { bold: true };
      headerRow.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      });
    }
    for (const r of rows) {
      ws.addRow(r.map(cellText));
    }
    const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
    for (let c = 1; c <= colCount; c++) {
      ws.getColumn(c).width = 18;
    }
  }
  ensureParentDir(outputPath);
  await wb.xlsx.writeFile(outputPath);
}

// ─── pptx（pptxgenjs, MIT） ────────────────────────────────────────────

async function generatePptx(outputPath: string, content: OfficeContentSpec): Promise<void> {
  let slides: OfficeSlideSpec[] = [];
  if (Array.isArray(content.slides) && content.slides.length > 0) {
    slides = content.slides;
  } else if (
    content.title ||
    (content.paragraphs !== undefined && (asStringArray(content.paragraphs)?.length ?? 0) > 0) ||
    (content.bullets?.length ?? 0) > 0
  ) {
    slides = [
      {
        title: content.title,
        bullets: asStringArray(content.paragraphs ?? content.bullets) ?? content.bullets ?? [],
      },
    ];
  }

  if (slides.length === 0) {
    throw new OfficeGenerateError('内容为空：pptx 需要 slides 或 title/paragraphs/bullets 至少一项');
  }

  const pptx = new PptxGenJSClass();
  pptx.defineLayout({ name: 'LAYOUT_WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'LAYOUT_WIDE';

  for (const spec of slides) {
    const slide = pptx.addSlide();
    if (spec.title) {
      slide.addText(spec.title, {
        x: 0.6, y: 0.4, w: 12.1, h: 0.9,
        fontSize: 30, bold: true, color: '1F2937',
      });
      slide.addText('', { x: 0.6, y: 1.3, w: 12.1, h: 0.06, fill: { color: '4F46E5' } });
    }
    const bullets = spec.bullets ?? [];
    if (bullets.length > 0) {
      slide.addText(
        bullets.map((b) => ({ text: normText(b), options: { bullet: true, breakLine: true } })),
        { x: 0.8, y: 1.6, w: 11.7, h: 5.4, fontSize: 20, color: '374151', valign: 'top' },
      );
    }
  }

  const buf = (await pptx.write({ outputType: 'nodebuffer', compression: true })) as unknown as Buffer;
  ensureParentDir(outputPath);
  writeFileSync(outputPath, buf);
}

// ─── pdf（pdf-lib, MIT） ───────────────────────────────────────────────

function wrapText(
  text: string,
  font: { widthOfTextAtSize(s: string, size: number): number },
  size: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let current = '';
  let lastSpace = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ') lastSpace = current.length;
    const test = current + ch;
    if (font.widthOfTextAtSize(test, size) > maxWidth && current.length > 0) {
      if (lastSpace > 0 && ch !== ' ') {
        lines.push(current.slice(0, lastSpace));
        current = current.slice(lastSpace + 1) + ch;
        lastSpace = -1;
      } else {
        lines.push(current);
        current = ch;
      }
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function generatePdf(
  outputPath: string,
  content: OfficeContentSpec,
  options: OfficeGenerateOptions,
): Promise<void> {
  if (content.html) {
    if (!options.printHtmlToPdf) {
      throw new OfficeGenerateError(
        '当前环境不支持 HTML→PDF（需要 Electron printToPDF 回调），请改用 pdf-lib 结构化内容（title/paragraphs/bullets）或直接提供文本',
      );
    }
    ensureParentDir(outputPath);
    await options.printHtmlToPdf(content.html, outputPath);
    return;
  }

  const paragraphs = asStringArray(content.paragraph ?? content.paragraphs) ?? [];
  if (!content.title && paragraphs.length === 0 && (content.bullets?.length ?? 0) === 0) {
    throw new OfficeGenerateError('内容为空：pdf 需要 title/paragraphs/bullets 至少一项');
  }

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const allText = collectPdfText(content);
  let font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  if (hasCjk(allText) || content.fontPath) {
    const explicit = content.fontPath && existsSync(content.fontPath) ? content.fontPath : undefined;
    const fontPath = explicit ?? findCjkFontPath(options.cjkFontCandidates);
    if (!fontPath) {
      throw new OfficeGenerateError(
        'PDF 内容包含中文，但未找到可嵌入的系统中文字体（如 Arial Unicode.ttf / Noto Sans CJK）。' +
          '请安装中文字体，或通过 fontPath 显式指定一个 .ttf/.otf 字体文件；纯 ASCII 内容无需字体。',
      );
    }
    try {
      const fontBytes = readFileSync(fontPath);
      font = await pdfDoc.embedFont(new Uint8Array(fontBytes), { subset: true });
    } catch (err) {
      throw new OfficeGenerateError(`CJK 字体嵌入失败（${fontPath}）：${String(err)}`);
    }
  }

  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const margin = 56;
  const maxWidth = page.getWidth() - margin * 2;
  let y = page.getHeight() - margin;

  if (content.title) {
    if (font.widthOfTextAtSize(content.title, 24) > maxWidth) {
      for (const line of wrapText(content.title, font, 24, maxWidth)) {
        page.drawText(line, { x: margin, y, size: 24, font, color: rgb(0.12, 0.16, 0.24) });
        y -= 32;
      }
    } else {
      page.drawText(content.title, { x: margin, y, size: 24, font, color: rgb(0.12, 0.16, 0.24) });
      y -= 36;
    }
  }

  const bodySize = 12;
  const lineGap = bodySize + 6;
  const flush = () => {
    if (y < margin + 24) {
      const next = pdfDoc.addPage([595.28, 841.89]);
      y = next.getHeight() - margin;
    }
  };

  for (const p of paragraphs) {
    for (const line of wrapText(p, font, bodySize, maxWidth)) {
      flush();
      page.drawText(line, { x: margin, y, size: bodySize, font, color: rgb(0.15, 0.15, 0.15) });
      y -= lineGap;
    }
    if (paragraphs.length > 1) y -= 4;
  }

  for (const b of content.bullets ?? []) {
    for (const line of wrapText(`• ${b}`, font, bodySize, maxWidth)) {
      flush();
      page.drawText(line, { x: margin, y, size: bodySize, font, color: rgb(0.15, 0.15, 0.15) });
      y -= lineGap;
    }
  }

  const bytes = await pdfDoc.save();
  ensureParentDir(outputPath);
  writeFileSync(outputPath, Buffer.from(bytes));
}

// ─── 统一入口 ──────────────────────────────────────────────────────────

/** 生成指定格式 Office 文件（纯函数，供工具与测试复用）。 */
export async function generateOfficeFile(
  format: string,
  outputPath: string,
  content: OfficeContentSpec,
  options: OfficeGenerateOptions = { outputPath, content },
): Promise<OfficeGenerateResult> {
  const fmt = format.trim().toLowerCase().replace(/^\./, '') as OfficeFormat;
  if (!OFFICE_FORMATS.includes(fmt)) {
    throw new OfficeGenerateError(
      `不支持的格式：${format}。支持：${OFFICE_FORMATS.join(', ')}（旧格式 doc/xls/ppt 不支持生成）`,
    );
  }

  const ext = extname(outputPath).toLowerCase().replace('.', '');
  if (ext && ext !== fmt) {
    throw new OfficeGenerateError(`输出文件扩展名与格式不匹配：文件为 .${ext}，格式为 ${fmt}`);
  }

  if (fmt === 'docx') await generateDocx(outputPath, content);
  else if (fmt === 'xlsx') await generateXlsx(outputPath, content);
  else if (fmt === 'pptx') await generatePptx(outputPath, content);
  else if (fmt === 'pdf') await generatePdf(outputPath, content, options);

  let size = 0;
  try {
    size = statSync(outputPath).size;
  } catch {
    size = 0;
  }
  return { outputPath, format: fmt, size };
}

// ─── Agent 工具（office_generate） ────────────────────────────────────

export function createOfficeGenerateTool(ctx: OfficeGenerateToolContext): AgentToolHandler {
  return {
    name: 'office_generate',
    description:
      'Generate Office deliverable files (docx/xlsx/pptx/pdf) as structured documents. Use it to create Word documents, Excel workbooks, PowerPoint decks, or PDF reports from a JSON content spec. Writes the file to disk first, then auto-registers it as a deliverable (source=agent) that the team can preview. Supports Chinese content and Chinese filenames. Supported formats: docx (Word), xlsx (Excel), pptx (PowerPoint), pdf (PDF). Legacy formats (doc/xls/ppt) are NOT supported for generation.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['docx', 'xlsx', 'pptx', 'pdf'],
          description: 'Output format: docx (Word), xlsx (Excel), pptx (PowerPoint), pdf (PDF)',
        },
        output_path: {
          type: 'string',
          description:
            'Absolute path (or workspace-relative path) where the generated file will be written. Extension must match format (e.g. .docx for docx). Parent directories are created automatically. Chinese filenames are supported.',
        },
        content: {
          type: 'object',
          description:
            'Structured document content. Fields are used per format: title/paragraphs/bullets/table (docx, pdf, pptx), sheets (xlsx), slides (pptx), html (PDF via printToPDF when available), fontPath (optional explicit CJK font for PDF), imagePath (optional image for docx).',
          properties: {
            title: { type: 'string' },
            paragraph: { type: 'string' },
            paragraphs: { type: 'array', items: { type: 'string' } },
            bullets: { type: 'array', items: { type: 'string' } },
            table: {
              type: 'object',
              properties: {
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } } },
              },
            },
            sheets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  headers: { type: 'array', items: { type: 'string' } },
                  rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } } },
                },
              },
            },
            slides: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  bullets: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            html: { type: 'string' },
            fontPath: { type: 'string' },
            imagePath: { type: 'string' },
          },
        },
        title: { type: 'string', description: 'Optional title shortcut (same as content.title).' },
        paragraphs: { type: 'array', items: { type: 'string' }, description: 'Optional shortcut for content.paragraphs.' },
        table: {
          type: 'object',
          description: 'Optional shortcut for content.table.',
          properties: {
            headers: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } } },
          },
        },
        sheets: { type: 'array', description: 'Optional shortcut for content.sheets.' },
        slides: { type: 'array', description: 'Optional shortcut for content.slides.' },
        project_id: { type: 'string', description: 'Optional project ID to associate the deliverable with.' },
        tags: {
          type: 'string',
          description: 'Comma-separated tags for the deliverable (default: office,<format>).',
        },
        summary: {
          type: 'string',
          description: 'Optional 1-3 sentence deliverable summary. Defaults to a generated description.',
        },
      },
      required: ['format', 'output_path'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const format = normText(args['format']).toLowerCase();
        const outputPath = normText(args['output_path'] ?? args['outputPath'] ?? args['file'] ?? args['path']).trim();
        if (!format) return JSON.stringify({ status: 'error', error: 'format is required (docx/xlsx/pptx/pdf)' });
        if (!outputPath) {
          return JSON.stringify({ status: 'error', error: 'output_path is required — where should the generated file be written?' });
        }

        const content: OfficeContentSpec = pick(args, 'title') !== undefined
          ? { title: normText(pick(args, 'title')) }
          : {};
        const title = pick(args, 'title');
        if (title !== undefined) content.title = normText(title);
        const paragraphs = asStringArray(pick(args, 'paragraph') ?? pick(args, 'paragraphs'));
        if (paragraphs) content.paragraphs = paragraphs;
        const bullets = asStringArray(pick(args, 'bullets'));
        if (bullets) content.bullets = bullets;
        const table = pick(args, 'table') as OfficeTableSpec | undefined;
        if (table && typeof table === 'object') content.table = table;
        const sheets = pick(args, 'sheets') as OfficeSheetSpec[] | undefined;
        if (Array.isArray(sheets)) content.sheets = sheets;
        const slides = pick(args, 'slides') as OfficeSlideSpec[] | undefined;
        if (Array.isArray(slides)) content.slides = slides;
        const html = pick(args, 'html');
        if (typeof html === 'string') content.html = html;
        const fontPath = pick(args, 'fontPath') ?? pick(args, 'font');
        if (typeof fontPath === 'string') content.fontPath = fontPath;
        const imagePath = pick(args, 'imagePath') ?? pick(args, 'image');
        if (typeof imagePath === 'string') content.imagePath = imagePath;

        const result = await generateOfficeFile(format, outputPath, content, {
          outputPath,
          content,
          cjkFontCandidates: ctx.cjkFontCandidates,
          printHtmlToPdf: ctx.printHtmlToPdf,
        });

        const resp: Record<string, unknown> = {
          status: 'success',
          format: result.format,
          file: result.outputPath,
          size: result.size,
        };

        // 自动登记为 source='agent' 交付物（复用 deliverable_create 同一桥接，
        // T1 迁移后默认 source='agent'），可被产出物页 / RightPanel 预览。
        if (ctx.deliverableCreate) {
          try {
            const projectId = (
              (typeof args['project_id'] === 'string' && args['project_id'])
              || (typeof args['projectId'] === 'string' && args['projectId'])
              || ''
            ).trim() || undefined;
            const tagsRaw = args['tags'];
            const tags = Array.isArray(tagsRaw)
              ? tagsRaw.map(String).map((t) => t.trim()).filter(Boolean).join(', ')
              : typeof tagsRaw === 'string' && tagsRaw.trim()
                ? tagsRaw
                : `office,${result.format}`;
            const fallbackTitle = basename(result.outputPath, extname(result.outputPath)) || `office-${result.format}`;
            const dv = await ctx.deliverableCreate({
              type: 'file',
              title: normText(args['title']).trim() || fallbackTitle,
              summary: normText(args['summary']).trim()
                || `通过 office_generate 生成的 ${result.format.toUpperCase()} 文件（${result.outputPath}）`,
              reference: result.outputPath,
              format: result.format,
              tags,
              projectId,
            });
            resp.deliverableId = dv.id;
            resp.deliverableStatus = dv.status;
            if (ctx.webUiBaseUrl) resp.accessUrl = `${ctx.webUiBaseUrl}/#output/${dv.id}`;
          } catch (registerErr) {
            // 文件已生成成功；登记失败仅告警，不吞异常细节
            resp.deliverableWarning = `交付物登记失败：${String(registerErr)}`;
          }
        } else {
          resp.deliverableWarning = '未配置交付物服务，跳过自动登记（可直接用 deliverable_create 手动登记）';
        }
        return JSON.stringify(resp);
      } catch (error) {
        return JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}