/**
 * Generic file storage provider interface.
 *
 * Local deployments use the filesystem (~/.markus/uploads/);
 * cloud deployments can swap in an S3/GCS/R2 implementation.
 */

export interface FileStorageUploadResult {
  /** Public-facing URL to access the file (relative path for local, full URL for cloud) */
  url: string;
  /** Provider-specific key used for deletion / reference */
  key: string;
}

export interface FileStorageProvider {
  /**
   * Upload a file and return its public URL + storage key.
   *
   * @param data - Raw file bytes
   * @param opts.name - Original filename (used for extension / content-type inference)
   * @param opts.contentType - MIME type (e.g. 'image/jpeg')
   * @param opts.prefix - Optional subdirectory hint (e.g. 'comments', 'avatars')
   */
  upload(data: Buffer, opts: { name: string; contentType: string; prefix?: string }): Promise<FileStorageUploadResult>;

  /** Delete a previously uploaded file by its storage key. */
  delete(key: string): Promise<void>;
}
