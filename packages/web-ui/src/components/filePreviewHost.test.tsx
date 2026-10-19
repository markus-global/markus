/**
 * The file preview modal must survive the recycling of the message row that
 * contains the link.
 *
 * Defect this fixes (mobile only): `FilePathLink` used to own `<FilePreviewModal>`
 * in its own state. Rows are rendered by the chat virtualizer and recycled as
 * soon as they leave the rendered window, so the portal node at `document.body`
 * was unmounted together with its React owner — the document the user was
 * reading closed itself with no user action. Desktop never showed it because
 * there the same click is routed to the right panel (`hostAvailable`), whose
 * lifetime belongs to the page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../api.ts', () => ({
  api: {
    files: {
      check: vi.fn(async (paths: string[]) => ({
        results: Object.fromEntries(
          paths.map(p => [p, { exists: true, isFile: true, type: 'markdown' }]),
        ),
      })),
      preview: vi.fn(async (p: string) => ({
        type: 'markdown',
        name: p.split('/').pop() ?? p,
        content: '# hello',
      })),
      reveal: vi.fn(async () => ({})),
      streamUrl: (p: string) => `/api/files/stream?path=${encodeURIComponent(p)}`,
    },
  },
}));

import { FilePathLink, FilePreviewHost } from './FilePathLink.tsx';
import { closeFilePreview } from './filePreviewStore.ts';

const DOC = '/tmp/recycled-row/doc.md';

/** Stand-in for a chat message row: the virtualizer mounts and unmounts this. */
function MessageRow({ path }: { path: string }) {
  return <div data-message-row>{<FilePathLink path={path} />}</div>;
}

async function readyLink(): Promise<Element> {
  return waitFor(() => {
    const el = document.querySelector('[data-file-path-link="ready"]');
    if (!el) throw new Error('file link not ready yet');
    return el;
  });
}

describe('FilePreviewHost — preview ownership is independent of the message row', () => {
  beforeEach(() => {
    closeFilePreview();
  });

  it('keeps the document open when the row that owns the link is recycled', async () => {
    const { rerender } = render(
      <>
        <MessageRow path={DOC} />
        <FilePreviewHost />
      </>,
    );

    fireEvent.click(await readyLink());
    expect(await screen.findByText('复制路径')).toBeTruthy();

    // The virtualizer drops the row (auto-follow while streaming, load-more
    // prepending history, background reconcile, resize …). The reader did
    // nothing — the document must stay open.
    rerender(
      <>
        <FilePreviewHost />
      </>,
    );

    expect(screen.queryByText('复制路径')).toBeTruthy();
  });

  it('closes only when the user closes it', async () => {
    render(
      <>
        <MessageRow path={DOC} />
        <FilePreviewHost />
      </>,
    );

    fireEvent.click(await readyLink());
    const header = await screen.findByText('复制路径');
    const closeButton = header.parentElement!.parentElement!.querySelector('button:last-of-type')!;
    fireEvent.click(closeButton);

    await waitFor(() => expect(screen.queryByText('复制路径')).toBeNull());
  });

  it('renders exactly one modal no matter how many links were clicked', async () => {
    const { rerender } = render(
      <>
        <MessageRow path={DOC} />
        <FilePreviewHost />
      </>,
    );
    fireEvent.click(await readyLink());
    expect(await screen.findByText('复制路径')).toBeTruthy();

    // Same row, second document (chat keeps replacing rows instead of stacking
    // modals — one owner means one modal, always showing the newest path).
    rerender(
      <>
        <MessageRow path="/tmp/recycled-row/other.md" />
        <FilePreviewHost />
      </>,
    );
    const link = await waitFor(() => {
      const el = document.querySelector('[data-file-path-link="ready"]');
      if (!el) throw new Error('second link not ready yet');
      return el;
    });
    fireEvent.click(link);

    expect(await screen.findByText('other.md')).toBeTruthy();
    expect(screen.getAllByText('复制路径')).toHaveLength(1);
  });
});
