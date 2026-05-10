/**
 * File Upload Middleware - Handles file attachments in external conversations.
 *
 * Validates file type, size, and generates presigned URLs for storage.
 * Files are stored separately and referenced in messages by URL.
 */
import { createLogger, type ExternalContext } from '@markus/shared';
import type { MiddlewareHandler } from './types.js';

const log = createLogger('mw:file-upload');

export interface FileStorageProvider {
  generateUploadUrl(params: { filename: string; mimeType: string; sizeBytes: number; sessionId: string }): Promise<{ uploadUrl: string; downloadUrl: string; fileId: string }>;
  deleteFile(fileId: string): Promise<void>;
}

export interface FileUploadConfig {
  maxFileSizeBytes: number;
  allowedMimeTypes: string[];
  maxFilesPerMessage: number;
  storageProvider: FileStorageProvider;
}

const DEFAULT_CONFIG: Omit<FileUploadConfig, 'storageProvider'> = {
  maxFileSizeBytes: 10 * 1024 * 1024, // 10MB
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'],
  maxFilesPerMessage: 3,
};

export function createFileUploadMiddleware(config: FileUploadConfig): MiddlewareHandler {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return async (ctx: ExternalContext, next) => {
    const attachments = ctx.message.attachments;
    if (!attachments || attachments.length === 0) {
      await next();
      return;
    }

    if (attachments.length > cfg.maxFilesPerMessage) {
      ctx.aborted = true;
      ctx.abortReason = `Too many files. Maximum ${cfg.maxFilesPerMessage} files per message.`;
      ctx.audit.push({ timestamp: new Date().toISOString(), type: 'input_validation', action: 'reject_file_count', success: false });
      return;
    }

    for (const attachment of attachments) {
      if (attachment.sizeBytes > cfg.maxFileSizeBytes) {
        ctx.aborted = true;
        ctx.abortReason = `File "${attachment.filename}" is too large. Maximum size is ${Math.round(cfg.maxFileSizeBytes / 1024 / 1024)}MB.`;
        ctx.audit.push({ timestamp: new Date().toISOString(), type: 'input_validation', action: 'reject_file_size', success: false, detail: `${attachment.sizeBytes} > ${cfg.maxFileSizeBytes}` });
        return;
      }

      if (!cfg.allowedMimeTypes.includes(attachment.mimeType) && !cfg.allowedMimeTypes.includes('*/*')) {
        ctx.aborted = true;
        ctx.abortReason = `File type "${attachment.mimeType}" is not supported.`;
        ctx.audit.push({ timestamp: new Date().toISOString(), type: 'input_validation', action: 'reject_file_type', success: false, detail: attachment.mimeType });
        return;
      }
    }

    ctx.audit.push({ timestamp: new Date().toISOString(), type: 'input_validation', action: 'file_upload_validated', success: true, metadata: { fileCount: attachments.length } });
    await next();
  };
}
