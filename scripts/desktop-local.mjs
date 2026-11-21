import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicKeyPath = path.join(root, 'central-backend', '.dev', 'license-public.pem');
if (!fs.existsSync(publicKeyPath)) {
  console.error('Local development keys are missing. Start `npm run central:dev` first.');
  process.exit(1);
}

const mode = process.argv[2] === 'package' ? 'desktop:package' : 'desktop:start';
const isWindows = process.platform === 'win32';
const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const args = isWindows ? ['/d', '/s', '/c', `npm run ${mode}`] : ['run', mode];
const child = spawn(command, args, {
  cwd: root,
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    CENTRAL_API_URL: 'http://127.0.0.1:4000',
    CENTRAL_LICENSE_PUBLIC_KEY: fs.readFileSync(publicKeyPath, 'utf8'),
    PHARMA_LOCAL_LICENSE_DEV: 'true',
  },
});

child.once('error', (error) => {
  console.error('Could not start the local desktop build:', error);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code || 0;
});
