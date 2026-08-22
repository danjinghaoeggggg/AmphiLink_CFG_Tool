import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export async function isFile(filePath: string | undefined): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    const value = await stat(filePath);
    return value.isFile();
  } catch {
    return false;
  }
}

export async function isDirectory(directoryPath: string | undefined): Promise<boolean> {
  if (!directoryPath) {
    return false;
  }
  try {
    const value = await stat(directoryPath);
    return value.isDirectory();
  } catch {
    return false;
  }
}

export async function isExecutable(filePath: string | undefined): Promise<boolean> {
  if (!(await isFile(filePath))) {
    return false;
  }
  if (process.platform === 'win32') {
    return true;
  }
  try {
    await access(filePath!, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function executableNames(baseName: string): string[] {
  if (process.platform !== 'win32') {
    return [baseName];
  }
  if (/\.(exe|cmd|bat)$/i.test(baseName)) {
    return [baseName];
  }
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT')
    .split(';')
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  return [baseName, ...extensions.map((extension) => `${baseName}${extension}`)];
}

export async function findOnPath(baseName: string): Promise<string | undefined> {
  return (await findAllOnPath(baseName))[0];
}

export async function findAllOnPath(baseName: string): Promise<string[]> {
  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const results: string[] = [];
  const visited = new Set<string>();
  for (const directory of directories) {
    for (const name of executableNames(baseName)) {
      const candidate = path.join(directory, name);
      const normalized = path.resolve(candidate);
      if (!visited.has(normalized) && (await isExecutable(normalized))) {
        results.push(normalized);
        visited.add(normalized);
      }
    }
  }
  return results;
}

export async function firstExecutable(candidates: Array<string | undefined>): Promise<string | undefined> {
  const visited = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const normalized = path.resolve(expandHome(candidate));
    if (!visited.has(normalized) && (await isExecutable(normalized))) {
      return normalized;
    }
    visited.add(normalized);
  }
  return undefined;
}

export function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export async function versionedBinDirectories(root: string): Promise<string[]> {
  if (!(await isDirectory(root))) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    .map((entry) => path.join(root, entry.name, 'bin'));
}

export async function walkFiles(
  root: string,
  predicate: (filePath: string) => boolean,
  options: { maxDepth?: number; excluded?: Set<string> } = {}
): Promise<string[]> {
  const results: string[] = [];
  const maxDepth = options.maxDepth ?? 5;
  const excluded = options.excluded ?? new Set(['.git', 'node_modules']);

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!excluded.has(entry.name)) {
            await visit(entryPath, depth + 1);
          }
        } else if (entry.isFile() && predicate(entryPath)) {
          results.push(entryPath);
        }
      })
    );
  };

  await visit(root, 0);
  return results;
}
