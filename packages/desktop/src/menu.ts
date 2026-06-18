import { app, Menu, shell, BrowserWindow } from 'electron';

const IS_MAS = process.env['MARKUS_MAS'] === 'true';
const isMac = process.platform === 'darwin';

export function setupMenu(backendUrl: string): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open in Browser',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => shell.openExternal(backendUrl),
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.loadURL(`${backendUrl}/#settings`);
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : [
          { role: 'close' as const },
        ]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => shell.openExternal('https://markus.global/docs'),
        },
        {
          label: 'Report Issue',
          click: () => shell.openExternal('https://github.com/markus-global/markus/issues'),
        },
        { type: 'separator' },
        ...(IS_MAS ? [{
          label: 'Upgrade to Full Version',
          click: () => shell.openExternal('https://markus.global/download'),
        }] : [{
          label: 'Check for Updates...',
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
