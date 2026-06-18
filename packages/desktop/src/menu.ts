import { app, Menu, shell, BrowserWindow } from 'electron';

const IS_MAS = process.env['MARKUS_MAS'] === 'true';
const isMac = process.platform === 'darwin';

const i18n: Record<string, Record<string, string>> = {
  zh: {
    file: '文件',
    edit: '编辑',
    view: '视图',
    window: '窗口',
    help: '帮助',
    openInBrowser: '在浏览器中打开',
    settings: '设置',
    documentation: '文档',
    reportIssue: '反馈问题',
    checkForUpdates: '检查更新…',
    upgradeToFull: '升级到完整版',
    about: '关于 Markus',
    services: '服务',
    hide: '隐藏 Markus',
    hideOthers: '隐藏其他',
    unhide: '显示全部',
    quit: '退出 Markus',
    close: '关闭窗口',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    selectAll: '全选',
    reload: '重新加载',
    forceReload: '强制重新加载',
    devTools: '开发者工具',
    resetZoom: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    fullscreen: '进入全屏幕',
    minimize: '最小化',
    zoom: '缩放',
    front: '前置全部窗口',
  },
  en: {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    help: 'Help',
    openInBrowser: 'Open in Browser',
    settings: 'Settings',
    documentation: 'Documentation',
    reportIssue: 'Report Issue',
    checkForUpdates: 'Check for Updates…',
    upgradeToFull: 'Upgrade to Full Version',
    about: 'About Markus',
    services: 'Services',
    hide: 'Hide Markus',
    hideOthers: 'Hide Others',
    unhide: 'Show All',
    quit: 'Quit Markus',
    close: 'Close Window',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    reload: 'Reload',
    forceReload: 'Force Reload',
    devTools: 'Toggle Developer Tools',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fullscreen: 'Toggle Full Screen',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front',
  },
};

function getLocale(): string {
  const locale = app.getLocale();
  return locale.startsWith('zh') ? 'zh' : 'en';
}

export function setupMenu(backendUrl: string): void {
  const lang = getLocale();
  const t = i18n[lang] ?? i18n['en'];

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const, label: t['about'] },
        { type: 'separator' as const },
        { role: 'services' as const, label: t['services'] },
        { type: 'separator' as const },
        { role: 'hide' as const, label: t['hide'] },
        { role: 'hideOthers' as const, label: t['hideOthers'] },
        { role: 'unhide' as const, label: t['unhide'] },
        { type: 'separator' as const },
        { role: 'quit' as const, label: t['quit'] },
      ],
    }] : []),
    {
      label: t['file'],
      submenu: [
        {
          label: t['openInBrowser'],
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => shell.openExternal(backendUrl),
        },
        { type: 'separator' },
        {
          label: t['settings'],
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.loadURL(`${backendUrl}/#settings`);
          },
        },
        { type: 'separator' },
        isMac
          ? { role: 'close' as const, label: t['close'] }
          : { role: 'quit' as const, label: t['quit'] },
      ],
    },
    {
      label: t['edit'],
      submenu: [
        { role: 'undo', label: t['undo'] },
        { role: 'redo', label: t['redo'] },
        { type: 'separator' },
        { role: 'cut', label: t['cut'] },
        { role: 'copy', label: t['copy'] },
        { role: 'paste', label: t['paste'] },
        { role: 'selectAll', label: t['selectAll'] },
      ],
    },
    {
      label: t['view'],
      submenu: [
        { role: 'reload', label: t['reload'] },
        { role: 'forceReload', label: t['forceReload'] },
        { role: 'toggleDevTools', label: t['devTools'] },
        { type: 'separator' },
        { role: 'resetZoom', label: t['resetZoom'] },
        { role: 'zoomIn', label: t['zoomIn'] },
        { role: 'zoomOut', label: t['zoomOut'] },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t['fullscreen'] },
      ],
    },
    {
      label: t['window'],
      submenu: [
        { role: 'minimize', label: t['minimize'] },
        { role: 'zoom', label: t['zoom'] },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const, label: t['front'] },
        ] : [
          { role: 'close' as const, label: t['close'] },
        ]),
      ],
    },
    {
      label: t['help'],
      submenu: [
        {
          label: t['documentation'],
          click: () => shell.openExternal('https://markus.global/docs'),
        },
        {
          label: t['reportIssue'],
          click: () => shell.openExternal('https://github.com/markus-global/markus/issues'),
        },
        { type: 'separator' },
        ...(IS_MAS ? [{
          label: t['upgradeToFull'],
          click: () => shell.openExternal('https://markus.global/download'),
        }] : [{
          label: t['checkForUpdates'],
          click: async () => {
            const { autoUpdater } = await import('electron-updater');
            autoUpdater.checkForUpdatesAndNotify();
          },
        }]),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
