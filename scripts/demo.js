#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const local = process.argv.includes('--local') || process.env.DEMO_LOCAL === '1';
const activeChildren = new Set();

function stopActiveChildren() {
  for (const child of activeChildren) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

function run(label, script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n▶ ${label}`);
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
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
  await run('Trim clips', 'trim.js');
  await run('Generate keyframes', 'keyframes.js');
}

async function main() {
  await run(local ? 'Record locally' : 'Record', 'record.js', local ? { DEMO_LOCAL: '1' } : {});

  console.log('\n▶ Parallel post-processing');
  await Promise.all([run('Smooth footage', 'smooth.js'), runMetadata()]);
  console.log('✓ Parallel post-processing');

  await run('Render output', 'render.js');
}

main().catch((err) => {
  stopActiveChildren();
  console.error(`\n✗ Demo failed: ${err.message}`);
  process.exit(1);
});
