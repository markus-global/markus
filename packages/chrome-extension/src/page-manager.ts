/**
 * Manages the mapping between sequential page IDs (1, 2, 3...)
 * used by the MCP protocol and Chrome's native tab IDs.
 * Also tracks which page is "selected" (active for CDP operations).
 */

export class PageManager {
  private tabToPage = new Map<number, number>();
  private pageToTab = new Map<number, number>();
  private nextPageId = 1;
  private _selectedPageId: number | null = null;
  private debuggerAttached = new Set<number>();

  get selectedPageId(): number | null { return this._selectedPageId; }
  get selectedTabId(): number | null {
    if (this._selectedPageId === null) return null;
    return this.pageToTab.get(this._selectedPageId) ?? null;
  }

  getPageId(tabId: number): number {
    let pageId = this.tabToPage.get(tabId);
    if (pageId === undefined) {
      pageId = this.nextPageId++;
      this.tabToPage.set(tabId, pageId);
      this.pageToTab.set(pageId, tabId);
    }
    return pageId;
  }

  getTabId(pageId: number): number | undefined {
    return this.pageToTab.get(pageId);
  }

  selectPage(pageId: number): boolean {
    if (!this.pageToTab.has(pageId)) return false;
    this._selectedPageId = pageId;
    return true;
  }

  removePage(pageId: number): void {
    const tabId = this.pageToTab.get(pageId);
    if (tabId !== undefined) {
      this.tabToPage.delete(tabId);
      this.debuggerAttached.delete(tabId);
    }
    this.pageToTab.delete(pageId);
    if (this._selectedPageId === pageId) {
      this._selectedPageId = null;
    }
  }

  removeByTabId(tabId: number): void {
    const pageId = this.tabToPage.get(tabId);
    if (pageId !== undefined) {
      this.removePage(pageId);
    }
  }

  isDebuggerAttached(tabId: number): boolean {
    return this.debuggerAttached.has(tabId);
  }

  setDebuggerAttached(tabId: number, attached: boolean): void {
    if (attached) {
      this.debuggerAttached.add(tabId);
    } else {
      this.debuggerAttached.delete(tabId);
    }
  }

  getAllPages(): Array<{ pageId: number; tabId: number }> {
    return [...this.pageToTab.entries()].map(([pageId, tabId]) => ({ pageId, tabId }));
  }

  clear(): void {
    this.tabToPage.clear();
    this.pageToTab.clear();
    this.debuggerAttached.clear();
    this._selectedPageId = null;
    this.nextPageId = 1;
  }
}
