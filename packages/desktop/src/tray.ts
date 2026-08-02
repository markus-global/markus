import { Tray, Menu, nativeImage, app, shell } from 'electron';
import { join } from 'node:path';
import { restoreOrCreateWindow } from './window.js';

let tray: Tray | null = null;

export function setupTray(backendUrl: string): void {
  const iconPath = join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'dist', 'icon.png');
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Markus');

  const isZh = app.getLocale().startsWith('zh');
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isZh ? '显示窗口' : 'Show Window',
      click: () => restoreOrCreateWindow(backendUrl),
    },
    {
      label: isZh ? '在浏览器中打开' : 'Open in Browser',
      click: () => shell.openExternal(backendUrl),
    },
    { type: 'separator' },
    {
      label: isZh ? '退出 Markus' : 'Quit Markus',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    restoreOrCreateWindow(backendUrl);
  });
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
