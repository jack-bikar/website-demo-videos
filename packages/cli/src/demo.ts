#!/usr/bin/env tsx
/**
 * One-command pipeline (legacy file mode): record → parallel [smooth, trim+keyframes] → render.
 * Each stage runs as a child process so a failure or Ctrl-C tears down cleanly.
 */
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const ROOT = process.cwd();
const HERE = path.dirname(new URL(import.meta.url).pathname);
const local = process.argv.includes('--local') || process.env.DEMO_LOCAL === '1';
const activeChildren = new Set<ChildProcess>();

function stopActiveChildren() {
  for (const child of activeChildren) {
    if (!child.killed) child.kill('SIGTERM');
  }
}

function run(label: string, script: string, extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n▶ ${label}`);
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(HERE, script)], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    });
    activeChildren.add(child);

    child.on('error', (error) => {
      activeChildren.delete(child);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      activeChildren.delete(child);
      if (code === 0) {
        console.log(`✓ ${label}`);
        resolve();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${label} failed with ${detail}`));
    });
  });
}

async function runMetadata() {
  await run('Trim clips', 'trim.ts');
  await run('Generate keyframes', 'keyframes.ts');
}

async function main() {
  await run(local ? 'Record locally' : 'Record', 'record.ts', local ? { DEMO_LOCAL: '1' } : {});

  console.log('\n▶ Parallel post-processing');
  await Promise.all([run('Smooth footage', 'smooth.ts'), runMetadata()]);
  console.log('✓ Parallel post-processing');

  await run('Render output', 'render.ts');
}

main().catch((err) => {
  stopActiveChildren();
  console.error(`\n✗ Demo failed: ${err.message}`);
  process.exit(1);
});
