import { spawn } from 'node:child_process';
import type { ProcessResult } from '../types';

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function runProcess(
  command: string,
  args: string[] = [],
  options: RunProcessOptions = {}
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false
    });

    const finish = (code: number | null, error?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ command, args, code, stdout, stderr, timedOut, error });
    };

    child.stdout?.on('data', (data: Buffer | string) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data: Buffer | string) => {
      stderr += data.toString();
    });
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));

    const abort = (): void => {
      child.kill();
      finish(null, 'Cancelled');
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(null, `Timed out after ${options.timeoutMs ?? 10000} ms`);
    }, options.timeoutMs ?? 10000);
    if (options.signal?.aborted) {
      abort();
    }
  });
}

export function processOutput(result: ProcessResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}
