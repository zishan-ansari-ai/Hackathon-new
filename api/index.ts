import express from 'express';

const proxyApp = express();

let realApp: any = null;
let initError: any = null;

async function getRealApp() {
  if (realApp) return realApp;
  if (initError) throw initError;
  try {
    // Dynamically import the real server app to capture and report any initialization crashes
    const module = await import('../server');
    realApp = module.default || module;
    return realApp;
  } catch (err) {
    initError = err;
    throw err;
  }
}

proxyApp.all('*', async (req, res) => {
  try {
    const appInstance = await getRealApp();
    return appInstance(req, res);
  } catch (err: any) {
    console.error('Failed to initialize Express backend:', err);
    res.status(500).json({
      error: 'Failed to initialize Express backend',
      message: err.message,
      stack: err.stack
    });
  }
});

export default proxyApp;
