// Programmatic entry point: `import { createApp } from 'seed-harness'`.
import { App } from './app.js';

export { App };
export { VERSION, APP_DIR } from './util.js';

/** Create and initialize an app. Call `await app.listen()` to serve the UI and the API. */
export async function createApp(options) {
  const app = new App(options);
  await app.init();
  return app;
}
