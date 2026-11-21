import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const setup = spawn(process.execPath, ['central-backend/scripts/setup-dev-license.mjs'], {
  cwd: root,
  stdio: 'inherit',
});

setup.once('error', (error) => {
  console.error('Could not prepare the local development license:', error);
  process.exitCode = 1;
});

setup.once('exit', (code) => {
  if (code !== 0) {
    process.exitCode = code || 1;
    return;
  }
  const tsxCli = path.join(root, 'node_modules/tsx/dist/cli.mjs');
  const server = spawn(process.execPath, [tsxCli, 'central-backend/src/devServer.ts'], {
    cwd: root,
    stdio: 'inherit',
  });
  server.once('error', (error) => {
    console.error('Could not start the local development licensing service:', error);
    process.exitCode = 1;
  });
  server.once('exit', (serverCode) => {
    process.exitCode = serverCode || 0;
  });
});
