// Style pack workbench: rebuilds the packs on every save (with lint warnings) and serves the gallery and demo.
//   npm run styles:dev                 (builds everything first; PORT=8080 to change the port)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../demo/serve.mjs';

const watcher = spawn(
  process.execPath,
  [fileURLToPath(new URL('../../packages/videojs/scripts/style-packs.mjs', import.meta.url)), '--watch'],
  { stdio: 'inherit' },
);
const port = Number(process.env.PORT ?? 5173);
const server = createStaticServer().listen(port, '127.0.0.1', () => {
  console.log('Style pack workbench running:');
  console.log(`  gallery:      http://localhost:${port}/examples/styles/`);
  console.log(`  one pack:     http://localhost:${port}/examples/styles/?pack=<name>`);
  console.log(`  in a player:  http://localhost:${port}/examples/demo/?theme=<name>`);
});

const stop = () => {
  watcher.kill();
  server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
