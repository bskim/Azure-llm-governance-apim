import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = process.env.OPENCODEX_PACKAGE_ROOT?.trim();
const port = Number.parseInt(process.env.OPENCODEX_TEST_PORT ?? '', 10);
if (!packageRoot || !Number.isInteger(port) || port <= 0 || port > 65535) {
  process.stderr.write('OPENCODEX_PACKAGE_ROOT and OPENCODEX_TEST_PORT are required.\n');
  process.exit(64);
}

const serverModule = await import(pathToFileURL(path.join(packageRoot, 'src', 'server', 'index.ts')).href);
const readinessModule = await import(pathToFileURL(path.join(packageRoot, 'src', 'server', 'readiness.ts')).href);
const readinessGate = readinessModule.createReadinessGate();
const server = serverModule.startServer(port, { readinessGate });
readinessGate.markReady();
process.stdout.write(`ready http://127.0.0.1:${port}\n`);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  try {
    server.stop(true);
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 60_000);
