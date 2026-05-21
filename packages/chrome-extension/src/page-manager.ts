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
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  get selectedPageId(): number | null { return this._selectedPageId; }
  get selectedTabId(): number | null {
    if (this._selectedPageId === null) return null;
    return this.pageToTab.get(this._selectedPageId) ?? null;
  }

  /**
   * Restore PM state from chrome.storage.session.
   * Called on service worker startup to recover page↔tab mappings
   * that would otherwise be lost when the service worker is terminated.
   */
  async restore(): Promise<boolean> {
    try {
      const data = await chrome.storage.session.get('pm_state');
      if (!data.pm_state) return false;
      const s = data.pm_state as {
        tabToPage: [number, number][];
        pageToTab: [number, number][];
        nextPageId: number;
        selectedPageId: number | null;
      };

      // Verify tabs still exist before restoring mappings
      const liveTabs = new Set<number>();
      try {
        for (const tab of await chrome.tabs.query({})) {
          if (tab.id) liveTabs.add(tab.id);
        }
      } catch { /* ignore */ }

      this.tabToPage = new Map();
      this.pageToTab = new Map();
      let maxId = 0;
      for (const [tabId, pageId] of s.tabToPage) {
        if (liveTabs.has(tabId)) {
          this.tabToPage.set(tabId, pageId);
          this.pageToTab.set(pageId, tabId);
          if (pageId > maxId) maxId = pageId;
        }
      }
      this.nextPageId = Math.max(s.nextPageId, maxId + 1);
      this._selectedPageId =
        s.selectedPageId !== null && this.pageToTab.has(s.selectedPageId)
          ? s.selectedPageId
          : null;

      console.log(`[Markus] PM restored: ${this.tabToPage.size} pages, nextId=${this.nextPageId}`);
      return true;
    } catch (err) {
      console.warn('[Markus] PM restore failed:', err);
      return false;
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      chrome.storage.session.set({
        pm_state: {
          tabToPage: [...this.tabToPage.entries()],
          pageToTab: [...this.pageToTab.entries()],
          nextPageId: this.nextPageId,
          selectedPageId: this._selectedPageId,
        },
      }).catch(() => { /* ignore persist failures */ });
    }, 50);
  }

  getPageId(tabId: number): number {
    let pageId = this.tabToPage.get(tabId);
    if (pageId === undefined) {
      pageId = this.nextPageId++;
      this.tabToPage.set(tabId, pageId);
      this.pageToTab.set(pageId, tabId);
      this.schedulePersist();
    }
    return pageId;
  }

  /** Read-only lookup: returns existing pageId for a tabId, or undefined. */
  peekPageId(tabId: number): number | undefined {
    return this.tabToPage.get(tabId);
  }

  getTabId(pageId: number): number | undefined {
    return this.pageToTab.get(pageId);
  }

  /**
   * Resolve which tab to operate on. If params contains `_pageId`, use that
   * explicit page (multi-agent safe). Otherwise fall back to the global
   * selectedTabId (legacy / npx compat).
   */
  resolveTabId(params: Record<string, unknown>): number {
    const pageId = params._pageId as number | undefined;
    if (pageId !== undefined) {
      const tabId = this.pageToTab.get(pageId);
      if (tabId === undefined) throw new Error(`Page ${pageId} not found.`);
      return tabId;
    }
    if (this._selectedPageId === null) throw new Error('No page selected. Call new_page or select_page first.');
    const tabId = this.pageToTab.get(this._selectedPageId);
    if (tabId === undefined) throw new Error('No page selected. Call new_page or select_page first.');
    return tabId;
  }

  selectPage(pageId: number): boolean {
    if (!this.pageToTab.has(pageId)) return false;
    this._selectedPageId = pageId;
    this.schedulePersist();
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
    this.schedulePersist();
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
    this.schedulePersist();
  }
}
