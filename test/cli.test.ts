import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Start `mockgen serve` and resolve with the URL it says it's ready at. */
function readyUrl(args: string[], env: Record<string, string>): Promise<string> {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve', 'examples/petstore.yaml', '--port', '0', '--no-watch', ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (proc.kill(), reject(new Error(`no ready line:\n${out}`))), 15_000);
    const onData = (chunk: Buffer) => {
      out += chunk.toString().replace(/\x1b\[[0-9;]*m/g, '');
      const url = out.match(/Mock server ready at (http:\/\/\S+)/)?.[1];
      if (url) {
        clearTimeout(timer);
        proc.kill();
        resolve(url);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  });
}

describe('serve --host', { timeout: 30_000 }, () => {
  it('defaults to 127.0.0.1', async () => {
    expect(await readyUrl([], { MOCKGEN_HOST: '' })).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  // The Docker image sets MOCKGEN_HOST=0.0.0.0 so the server is reachable from outside the container.
  it('takes its default from MOCKGEN_HOST', async () => {
    expect(await readyUrl([], { MOCKGEN_HOST: '0.0.0.0' })).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/);
  });

  it('prefers an explicit --host over MOCKGEN_HOST', async () => {
    expect(await readyUrl(['--host', '127.0.0.1'], { MOCKGEN_HOST: '0.0.0.0' })).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
