export function buildWindowOptions(preloadPath) {
  return {
    width: 1100,
    height: 760,
    minWidth: 960,
    minHeight: 720,
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
