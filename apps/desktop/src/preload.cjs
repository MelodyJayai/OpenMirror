const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (callback) => {
    ipcRenderer.on(channel, (event, payload) => callback(payload));
  };
}

contextBridge.exposeInMainWorld('openmirror', {
  onCodec: subscribe('om:codec'),
  onVideo: subscribe('om:video'),
  onReset: subscribe('om:reset'),
  onStatus: subscribe('om:status'),
  onReceiverInfo: subscribe('om:receiver-info'),
  getSettings: () => ipcRenderer.invoke('om:get-settings'),
  getReceiverInfo: () => ipcRenderer.invoke('om:get-receiver-info'),
  saveSettings: (settings) => ipcRenderer.invoke('om:save-settings', settings),
});
