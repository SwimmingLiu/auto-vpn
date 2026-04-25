export function buildWindowOptions(preloadPath) {
  return {
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 640,
    useContentSize: true,
    center: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#09111f',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  };
}
