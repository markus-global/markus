import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import {
  createOfficeGenerateTool,
  findCjkFontPath,
  generateOfficeFile,
  OfficeGenerateError,
  OFFICE_FORMATS,
  type OfficeContentSpec,
  type OfficeGenerateToolContext,
} from '../src/tools/office-generate.js';

let tmpBase: string;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'office-gen-'));
});

afterEach(() => {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function out(name: string): string {
  return join(tmpBase, name);
}

const KNOWN_CJK_FONT = '/Library/Fonts/Arial Unicode.ttf';

describe('OFFICE_FORMATS / 格式白名单', () => {
  it('仅包含四种新格式，无旧格式', () => {
    expect(OFFICE_FORMATS).toEqual(['docx', 'xlsx', 'pptx', 'pdf']);
  });
});

describe('docx 生成（docx, MIT）', () => {
  it('正常路径：标题+段落+表格可生成、为合法 zip、包含中文内容', async () => {
    const path = out('中文报告.docx');
    const result = await generateOfficeFile('docx', path, {
      title: '季度总结报告',
      paragraphs: ['第一季度业绩良好', '第二季度持续增长'],
      table: { headers: ['指标', '数值'], rows: [['营收', 100], ['利润', 20]] },
    });
    expect(result.format).toBe('docx');
    expect(result.size).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(true);

    const zip = await JSZip.loadAsync(readFileSync(path));
    const xml = (await zip.file('word/document.xml')!.async('string')) as string;
    expect(xml).toContain('季度总结报告');
    expect(xml).toContain('业绩良好');
    expect(xml).toContain('营收');
  });

  it('错误路径：空内容抛出 OfficeGenerateError', async () => {
    await expect(generateOfficeFile('docx', out('empty.docx'), {})).rejects.toBeInstanceOf(OfficeGenerateError);
  });

  it('错误路径：扩展名与格式不匹配', async () => {
    await expect(
      generateOfficeFile('docx', out('报告.pdf'), { title: 'x' }),
    ).rejects.toThrow(/扩展名与格式不匹配/);
  });
});

describe('xlsx 生成（exceljs, MIT）', () => {
  it('正常路径：多 sheet 可生成、可读回单元格（含中文与数字）', async () => {
    const path = out('销售数据.xlsx');
    const result = await generateOfficeFile('xlsx', path, {
      sheets: [
        { name: '一季度', headers: ['产品', '销量'], rows: [['苹果', 12], ['香蕉', 8]] },
        { name: '二季度', headers: ['产品', '销量'], rows: [['橙子', 15]] },
      ],
    });
    expect(result.format).toBe('xlsx');
    expect(result.size).toBeGreaterThan(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const ws1 = wb.getWorksheet('一季度')!;
    expect(ws1.getCell('A1').value).toBe('产品');
    expect(ws1.getCell('B2').value).toBe(12);
    expect(wb.worksheets.length).toBe(2);
  });

  it('正常路径：table 简写自动转 sheet', async () => {
    const path = out('table.xlsx');
    await generateOfficeFile('xlsx', path, {
      title: 'TableSheet',
      table: { headers: ['列1'], rows: [['值1']] },
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    expect(wb.worksheets[0].name).toBe('TableSheet');
  });

  it('错误路径：无工作表内容抛出 OfficeGenerateError', async () => {
    await expect(generateOfficeFile('xlsx', out('empty.xlsx'), { title: '标题' })).rejects.toBeInstanceOf(
      OfficeGenerateError,
    );
  });
});

describe('pptx 生成（pptxgenjs, MIT）', () => {
  it('正常路径：多幻灯片可生成、为合法 zip、包含中文', async () => {
    const path = out('产品发布.pptx');
    const result = await generateOfficeFile('pptx', path, {
      slides: [
        { title: '产品发布计划', bullets: ['市场分析', '目标用户'] },
        { title: '路线图', bullets: ['Q3 发布', 'Q4 增长'] },
      ],
    });
    expect(result.format).toBe('pptx');
    expect(result.size).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(readFileSync(path));
    const slideXml = (await zip.file('ppt/slides/slide1.xml')!.async('string')) as string;
    expect(slideXml).toContain('产品发布计划');
  });

  it('正常路径：title/paragraphs 简写自动生成单页', async () => {
    const path = out('single.pptx');
    await generateOfficeFile('pptx', path, { title: '单页', paragraphs: ['内容一', '内容二'] });
    const zip = await JSZip.loadAsync(readFileSync(path));
    expect(zip.file('ppt/slides/slide1.xml')).toBeTruthy();
  });

  it('错误路径：无幻灯片内容抛出 OfficeGenerateError', async () => {
    await expect(generateOfficeFile('pptx', out('empty.pptx'), {})).rejects.toBeInstanceOf(OfficeGenerateError);
  });
});

describe('pdf 生成（pdf-lib, MIT）', () => {
  it('正常路径：纯 ASCII 内容无需字体，可生成合法 PDF', async () => {
    const path = out('report.pdf');
    const result = await generateOfficeFile('pdf', path, {
      title: 'Quarterly Report',
      paragraphs: ['Revenue grew by 20%.', 'Profit margin stable.'],
    });
    expect(result.size).toBeGreaterThan(0);
    expect(readFileSync(path).subarray(0, 4).toString()).toBe('%PDF');

    const doc = await PDFDocument.load(readFileSync(path));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('正常路径：中文内容自动嵌入系统 CJK 字体', async () => {
    if (!findCjkFontPath()) return; // 系统无 CJK 字体（如 CI Linux runner）则跳过
    const path = out('中文报告.pdf');
    const { generateOfficeFile: gen } = await import('../src/tools/office-generate.js');
    const result = await gen('pdf', path, {
      title: '中文季度报告',
      paragraphs: ['营收增长百分之二十', '成本控制在预算内'],
    });
    expect(result.size).toBeGreaterThan(0);
    expect(readFileSync(path).subarray(0, 4).toString()).toBe('%PDF');
    // pdf-lib 使用 FlateDecode + ObjStm 压缩对象；解压后应能发现嵌入的字体描述
    //（TrueType 字体的 FontDescriptor 含 /FontFile2）。
    const inflated = inflateAllStreams(readFileSync(path));
    expect(inflated).toContain('FontFile2');
    expect(rawBytesOf(path).length).toBeGreaterThan(8_000); // 嵌入子集字体后体积明显大于纯 ASCII
  });

  it('正常路径：显式 fontPath 可嵌入指定字体', async () => {
    if (!existsSync(KNOWN_CJK_FONT)) return; // 环境无该字体则跳过
    const path = out('explicit-font.pdf');
    await generateOfficeFile('pdf', path, {
      title: '显式字体',
      fontPath: KNOWN_CJK_FONT,
    });
    expect(readFileSync(path).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('错误路径：中文内容但无可用字体抛出 OfficeGenerateError', async () => {
    await expect(
      generateOfficeFile('pdf', out('nofont.pdf'), { title: '中文标题' }, {
        outputPath: out('nofont.pdf'),
        content: { title: '中文标题' },
        cjkFontCandidates: ['/nonexistent/font.ttf'],
      } as never),
    ).rejects.toThrow(/未找到可嵌入的系统中文字体/);
  });

  it('错误路径：HTML 但未配置 printToPDF 回调', async () => {
    await expect(
      generateOfficeFile('pdf', out('html.pdf'), { html: '<h1>Hi</h1>' }, {
        outputPath: out('html.pdf'),
        content: { html: '<h1>Hi</h1>' },
      } as never),
    ).rejects.toThrow(/不支持 HTML→PDF/);
  });

  it('正常路径：配置 printHtmlToPdf 回调时 HTML 走 Electron printToPDF', async () => {
    const html = '<h1>HTML 报告</h1><p>内容</p>';
    const printHtmlToPdf = vi.fn(async (_html: string, outPath: string) => {
      // 模拟 Electron printToPDF 写入一个最小 PDF
      writeMiniPdf(outPath);
    });
    const { generateOfficeFile: gen } = await import('../src/tools/office-generate.js');
    const result = await gen('pdf', out('html-out.pdf'), { html }, {
      outputPath: out('html-out.pdf'),
      content: { html },
      printHtmlToPdf,
    } as never);
    expect(printHtmlToPdf).toHaveBeenCalledWith(html, out('html-out.pdf'));
    expect(result.size).toBeGreaterThan(0);
  });

  it('错误路径：空内容抛出 OfficeGenerateError', async () => {
    await expect(generateOfficeFile('pdf', out('empty.pdf'), {})).rejects.toBeInstanceOf(OfficeGenerateError);
  });

  it('多页长文：每一页都实际绘制了文本，不出现空白页（回归：page 变量未切换）', async () => {
    const paragraphs: string[] = [];
    for (let i = 0; i < 40; i++) {
      paragraphs.push(`Paragraph ${i}: the quick brown fox jumps over the lazy dog, lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore. `.repeat(4));
    }
    const path = out('long-multipage.pdf');
    await generateOfficeFile('pdf', path, { title: 'Long Document', paragraphs });
    const doc = await PDFDocument.load(readFileSync(path));
    expect(doc.getPageCount()).toBeGreaterThan(1);

    for (let i = 0; i < doc.getPageCount(); i++) {
      const page = doc.getPage(i);
      const contentsNode = page.node.Contents() as { asArray?: () => unknown[] } | undefined;
      const refs = Array.isArray(contentsNode) ? contentsNode : contentsNode?.asArray?.() ?? [];
      let textOps = 0;
      for (const ref of refs) {
        const stream = doc.context.lookup(ref as never) as { getContents?: () => Uint8Array; getContentsString?: () => string } | undefined;
        if (!stream) continue;
        let str = '';
        // pdf-lib 页面内容流是 FlateDecode 压缩字节（getContentsString 返回乱码），
        // 先尝试解压 getContents()，失败再退回字符串。
        if (stream.getContents) {
          const raw = stream.getContents();
          try {
            str = inflateSync(new Uint8Array(raw)).toString('latin1');
          } catch {
            str = String.fromCharCode(...Array.from(raw));
          }
        } else if (stream.getContentsString) {
          str = stream.getContentsString();
        }
        const m = str.match(/(Tj|TJ|')/g);
        textOps += m ? m.length : 0;
      }
      // 修复前 bug：第 2+ 页全部空白（内容绘到页 1 负坐标被裁剪）
      expect(textOps).toBeGreaterThan(0);
    }
  });
});

describe('非法格式与统一入口', () => {
  it('错误路径：非法格式（旧格式 doc/xls/ppt 与未知格式）全部拒绝', async () => {
    for (const bad of ['doc', 'xls', 'ppt', 'exe', 'txtx', '']) {
      await expect(
        generateOfficeFile(bad, out('bad.bin'), { title: 'x' }),
      ).rejects.toThrow(/不支持的格式/);
    }
  });

  it('错误路径：大小写与点前缀归一化', async () => {
    const path = out('upper.DOCX');
    await generateOfficeFile('DOCX', path, { title: 'T' });
    expect(existsSync(path)).toBe(true);
  });
});

describe('findCjkFontPath 系统字体探测', () => {
  it('默认候选在本机命中（macOS Arial Unicode.ttf）', () => {
    const found = findCjkFontPath();
    // 只要返回了任一存在的字体路径即视为命中（CI 环境可能无字体，则允许 undefined）
    if (found) {
      expect(existsSync(found)).toBe(true);
    }
  });

  it('显式候选找不到时返回 undefined', () => {
    expect(findCjkFontPath(['/nonexistent/a.ttf', '/nonexistent/b.otf'])).toBeUndefined();
  });
});

describe('office_generate 工具层（createOfficeGenerateTool）', () => {
  function makeCtx(overrides?: Partial<OfficeGenerateToolContext>): OfficeGenerateToolContext {
    return {
      agentId: 'agt_test',
      webUiBaseUrl: 'http://localhost:3000',
      deliverableCreate: vi.fn(async (opts) => ({
        id: 'dlv_office_1',
        type: opts.type,
        title: opts.title,
        status: 'active',
      })),
      ...overrides,
    };
  }

  function runTool(ctx: OfficeGenerateToolContext, args: Record<string, unknown>) {
    return createOfficeGenerateTool(ctx).execute(args);
  }

  it('正常路径：生成 docx 并自动登记交付物', async () => {
    const createMock = vi.fn(async (opts: { type: string; title: string; summary: string; reference?: string; format?: string; tags?: string; projectId?: string }) => ({
      id: 'dlv_doc_1',
      type: opts.type,
      title: opts.title,
      status: 'active',
    }));
    const ctx = makeCtx({ deliverableCreate: createMock });
    const path = out('工作总结.docx');
    const res = JSON.parse(await runTool(ctx, {
      format: 'docx',
      output_path: path,
      title: '工作总结',
      paragraphs: ['本月完成三项任务'],
      project_id: 'proj_x',
    }));
    expect(res.status).toBe('success');
    expect(res.format).toBe('docx');
    expect(res.file).toBe(path);
    expect(res.deliverableId).toBe('dlv_doc_1');
    expect(existsSync(path)).toBe(true);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'file',
        format: 'docx',
        reference: path,
        projectId: 'proj_x',
      }),
    );
  });

  it('正常路径：tags 默认 office,<format>，中文文件名可用', async () => {
    const ctx = makeCtx();
    const path = out('中文统计表.xlsx');
    const res = JSON.parse(await runTool(ctx, {
      format: 'xlsx',
      output_path: path,
      content: { sheets: [{ name: 'S', headers: ['a'], rows: [[1]] }] },
    }));
    expect(res.status).toBe('success');
    expect(ctx.deliverableCreate).toHaveBeenCalledWith(expect.objectContaining({ tags: 'office,xlsx' }));
  });

  it('错误路径：缺 format / 缺 output_path', async () => {
    const ctx = makeCtx();
    const r1 = JSON.parse(await runTool(ctx, { output_path: out('x.docx'), content: { title: 'x' } }));
    expect(r1.status).toBe('error');
    expect(r1.error).toContain('format');
    const r2 = JSON.parse(await runTool(ctx, { format: 'docx' }));
    expect(r2.status).toBe('error');
    expect(r2.error).toContain('output_path');
  });

  it('错误路径：非法格式与空内容返回 error 而非崩溃', async () => {
    const ctx = makeCtx();
    const r1 = JSON.parse(await runTool(ctx, { format: 'doc', output_path: out('x.doc') }));
    expect(r1.status).toBe('error');
    expect(r1.error).toContain('不支持的格式');
    const r2 = JSON.parse(await runTool(ctx, { format: 'pptx', output_path: out('x.pptx') }));
    expect(r2.status).toBe('error');
    expect(r2.error).toContain('内容为空');
  });

  it('交付物登记失败时文件仍成功生成，返回告警不吞异常', async () => {
    const ctx = makeCtx({
      deliverableCreate: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    const path = out('still-ok.pdf');
    const res = JSON.parse(await runTool(ctx, { format: 'pdf', output_path: path, title: 'OK' }));
    expect(res.status).toBe('success');
    expect(res.deliverableWarning).toContain('db down');
    expect(existsSync(path)).toBe(true);
  });

  it('未配置交付物服务时跳过登记并提示', async () => {
    const ctx = makeCtx({ deliverableCreate: undefined });
    const path = out('no-dv.pdf');
    const res = JSON.parse(await runTool(ctx, { format: 'pdf', output_path: path, title: 'Hi' }));
    expect(res.status).toBe('success');
    expect(res.deliverableWarning).toContain('跳过自动登记');
    expect(res.deliverableId).toBeUndefined();
  });

  it('中文 PDF：工具层成功生成（本机有 CJK 字体）', async () => {
    if (!existsSync(KNOWN_CJK_FONT)) return;
    const ctx = makeCtx();
    const path = out('中文PDF.pdf');
    const res = JSON.parse(await runTool(ctx, { format: 'pdf', output_path: path, title: '中文标题', paragraphs: ['中文内容行'] }));
    expect(res.status).toBe('success');
    expect(statSync(path).size).toBeGreaterThan(0);
  });
});

// 工具辅助：写一个极简合法 PDF（测试 printHtmlToPdf 回调用）
function writeMiniPdf(path: string): void {
  const bytes = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n189\n%%EOF\n',
  );
  writeFileSync(path, bytes);
}

/** 返回 PDF 原始字节（Buffer）。 */
function rawBytesOf(path: string): Buffer {
  return readFileSync(path);
}

/** 解压 PDF 中所有 FlateDecode 流，返回拼接后的 latin1 文本（用于检查嵌入字体/内容）。 */
function inflateAllStreams(pdf: Buffer): string {
  const text = pdf.toString('latin1');
  const parts: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const data = Buffer.from(m[1], 'latin1');
    try {
      parts.push(inflateSync(data).toString('latin1'));
    } catch {
      // 非压缩流（未压缩的字体原始数据等）跳过
    }
  }
  return parts.join('\n');
}