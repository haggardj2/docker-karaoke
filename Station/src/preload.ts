import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('karaokeDockStation', {
  openPlayerWindow: () => ipcRenderer.invoke('station:open-player'),
  togglePlayerFullscreen: () => ipcRenderer.invoke('station:toggle-player-fullscreen'),
  showWindow: (path: string) => ipcRenderer.invoke('station:show-window', path),
  getInfo: () => ipcRenderer.invoke('station:get-info'),
});
