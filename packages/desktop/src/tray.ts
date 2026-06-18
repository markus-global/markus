import { Tray, Menu, nativeImage, app, shell } from 'electron';
import { join } from 'node:path';
import { restoreOrCreateWindow } from './window.js';

let tray: Tray | null = null;

export function setupTray(backendUrl: string): void {
  const iconPath = join(app.getAppPath(), 'build', 'icon.png');
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Markus');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => restoreOrCreateWindow(backendUrl),
    },
    {
      label: 'Open in Browser',
      click: () => shell.openExternal(backendUrl),
    },
    { type: 'separator' },
    {
      label: 'Quit Markus',
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
