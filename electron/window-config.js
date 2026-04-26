const MIN_WIDTH = 880;
const MIN_HEIGHT = 640;
const MAX_DEFAULT_WIDTH = 1480;
const MAX_DEFAULT_HEIGHT = 860;

export function buildWindowOptions(preloadPath, workAreaSize = {}) {
  const width = fitDimension(workAreaSize.width, 0.86, MIN_WIDTH, MAX_DEFAULT_WIDTH);
  const height = fitDimension(workAreaSize.height, 0.8, MIN_HEIGHT, MAX_DEFAULT_HEIGHT);

  return {
    width,
    height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    useContentSize: true,
    center: true,
    fullscreen: false,
    maximizable: true,
    titleBarStyle: 'hidden',
    backgroundColor: '#09111f',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  };
}

function fitDimension(value, ratio, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Math.min(maximum, Math.max(minimum, Math.round(maximum * 0.86)));
  }
  return Math.min(maximum, Math.max(minimum, Math.round(numeric * ratio)));
}
