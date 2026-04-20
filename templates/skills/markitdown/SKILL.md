---
name: markitdown
description: Convert documents (PDF, Word, Excel, PowerPoint, images) to Markdown text for LLM processing
---

# MarkItDown File Converter

You have access to the MarkItDown MCP tool (`markitdown__convert_to_markdown`) for converting files to Markdown.

## When to use

Use this tool when:
- The user asks you to read, analyze, or summarize a document (PDF, Word, Excel, PowerPoint, etc.)
- You need to extract text content from an image (OCR)
- The user shares a file path and wants you to understand its contents
- You are working with a file format that your text tools cannot directly read

**Note:** For images attached directly in chat, the system automatically handles conversion when your model doesn't support vision. This skill is for converting files on disk that you encounter during tasks.

## Supported formats

MarkItDown supports 29+ file formats including:
- **Documents**: PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx/.xls)
- **Images**: JPEG, PNG, GIF, WebP (EXIF metadata + OCR)
- **Web**: HTML, XML
- **Data**: CSV, JSON
- **Other**: ZIP (iterates contents), EPUB, Outlook messages (.msg)

## Usage

```
markitdown__convert_to_markdown({ uri: "file:///path/to/document.pdf" })
```

The tool accepts a file URI and returns the content converted to Markdown format.

## Prerequisites

MarkItDown requires Python 3.10+ and the `markitdown` package:

```bash
pip install 'markitdown[all]'
```

Or install only specific format support:

```bash
pip install 'markitdown[pdf,docx,pptx]'
```

## Best practices

1. **Check file existence first**: Verify the file path is valid before attempting conversion.
2. **Large files**: For very large documents, the converted markdown may be lengthy. Summarize key sections for the user rather than dumping everything.
3. **Image OCR quality**: OCR results depend on image clarity. Mention if text extraction seems incomplete.
4. **Fallback**: If conversion fails (e.g., markitdown not installed), inform the user and suggest installing with `pip install 'markitdown[all]'`.
