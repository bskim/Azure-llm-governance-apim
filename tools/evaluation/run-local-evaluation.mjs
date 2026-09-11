import { runEvaluation } from './runner.mjs';
import { fileURLToPath } from 'node:url';

export async function runCli({
  args = process.argv.slice(2),
  run = runEvaluation,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (args.length !== 0) {
    stderr.write('Usage: node tools\\evaluation\\run-local-evaluation.mjs\n');
    return 2;
  }
  try {
    const report = await run();
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.pass ? 0 : 1;
  } catch (error) {
    stderr.write(`Evaluation failed: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCli();
}
