import { execFile } from 'node:child_process';
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');
const jsonOutputPath = join(releaseOutputDir, 'THIRD_PARTY_NOTICES.json');
const markdownOutputPath = join(releaseOutputDir, 'THIRD_PARTY_NOTICES.md');
const cargoLockPath = join(appRoot, 'src-tauri', 'Cargo.lock');
const cargoRoot = join(appRoot, 'src-tauri');

const workspacePackagePrefix = '@cts/';
const npmRoots = [join(appRoot, 'node_modules'), join(repoRoot, 'node_modules')];
const pnpmStorePath = join(repoRoot, 'node_modules', '.pnpm');

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function dependencyNames(packageJson) {
  return Object.keys(packageJson.dependencies ?? {})
    .filter((name) => !name.startsWith(workspacePackagePrefix))
    .sort((left, right) => left.localeCompare(right));
}

function packagePath(root, name) {
  return join(root, ...name.split('/'), 'package.json');
}

async function findPackageJson(name, fromDir = null) {
  const roots = fromDir ? [join(fromDir, 'node_modules'), ...npmRoots] : npmRoots;
  for (const root of roots) {
    const candidate = packagePath(root, name);
    if (await exists(candidate)) return candidate;
  }
  if (await exists(pnpmStorePath)) {
    for (const entry of await readdir(pnpmStorePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = packagePath(join(pnpmStorePath, entry.name, 'node_modules'), name);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

function repositoryUrl(repository) {
  if (!repository) return '';
  if (typeof repository === 'string') return repository;
  return repository.url ?? '';
}

async function collectNpmRuntimeDependencies() {
  const studioPackage = await readJson(join(appRoot, 'package.json'));
  const pending = dependencyNames(studioPackage).map((name) => ({ name, fromDir: null }));
  const seen = new Set();
  const packages = [];

  while (pending.length > 0) {
    const { name, fromDir } = pending.shift();
    if (seen.has(name) || name.startsWith(workspacePackagePrefix)) continue;
    seen.add(name);

    const packageJsonPath = await findPackageJson(name, fromDir);
    if (!packageJsonPath) {
      packages.push({
        name,
        version: 'UNKNOWN',
        license: 'UNKNOWN',
        homepage: '',
        repository: '',
        path: '',
      });
      continue;
    }

    const packageJson = await readJson(packageJsonPath);
    const packageDir = dirname(packageJsonPath);

    packages.push({
      name: packageJson.name ?? name,
      version: packageJson.version ?? 'UNKNOWN',
      license: normalizeLicense(packageJson.license),
      homepage: packageJson.homepage ?? '',
      repository: repositoryUrl(packageJson.repository),
      path: relativeFromRepo(packageJsonPath),
    });

    for (const dependency of dependencyNames(packageJson)) {
      if (!seen.has(dependency)) pending.push({ name: dependency, fromDir: packageDir });
    }

    for (const dependency of Object.keys(packageJson.optionalDependencies ?? {})) {
      if (!seen.has(dependency) && !dependency.startsWith(workspacePackagePrefix)) {
        const nestedPath = await findPackageJson(dependency, packageDir);
        if (nestedPath) pending.push({ name: dependency, fromDir: packageDir });
      }
    }
  }

  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeLicense(value) {
  if (!value) return 'UNKNOWN';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.type === 'string') return value.type;
  return 'UNKNOWN';
}

async function collectCargoDependencies() {
  const { stdout } = await execFileAsync(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--filter-platform', 'x86_64-pc-windows-msvc'],
    {
      cwd: cargoRoot,
      maxBuffer: 50 * 1024 * 1024,
      timeout: 120000,
    },
  );
  const metadata = JSON.parse(stdout);
  const resolvedIds = new Set((metadata.resolve?.nodes ?? []).map((node) => node.id));

  return metadata.packages
    .filter((cargoPackage) => resolvedIds.has(cargoPackage.id))
    .filter((cargoPackage) => cargoPackage.source?.includes('crates.io'))
    .map((cargoPackage) => ({
      name: cargoPackage.name,
      version: cargoPackage.version,
      license: normalizeLicense(cargoPackage.license ?? (cargoPackage.license_file ? `license-file:${cargoPackage.license_file}` : 'UNKNOWN')),
      homepage: cargoPackage.homepage ?? '',
      repository: cargoPackage.repository || `https://crates.io/crates/${cargoPackage.name}`,
      checksum: '',
      path: cargoPackage.manifest_path ? relativeFromRepo(cargoPackage.manifest_path) : '',
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

function licenseSummary(groups) {
  const summary = new Map();
  for (const group of groups) {
    for (const item of group) {
      summary.set(item.license, (summary.get(item.license) ?? 0) + 1);
    }
  }
  return [...summary.entries()]
    .map(([license, count]) => ({ license, count }))
    .sort((left, right) => left.license.localeCompare(right.license));
}

function markdownTable(rows, columns) {
  const header = `| ${columns.map((column) => column.label).join(' |')} |`;
  const separator = `|${columns.map(() => '---').join('|')}|`;
  const body = rows
    .map((row) => `| ${columns.map((column) => column.value(row).replace(/\|/g, '/')).join(' |')} |`)
    .join('\n');
  return `${header}\n${separator}\n${body}`;
}

function renderMarkdown(inventory) {
  const summaryTable = markdownTable(inventory.summary.licenses, [
    { label: 'License', value: (row) => row.license },
    { label: 'Count', value: (row) => String(row.count) },
  ]);
  const npmTable = markdownTable(inventory.npm, [
    { label: 'Package', value: (row) => row.name },
    { label: 'Version', value: (row) => row.version },
    { label: 'License', value: (row) => row.license },
    { label: 'Repository', value: (row) => row.repository || row.homepage || '' },
  ]);
  const cargoTable = markdownTable(inventory.cargo, [
    { label: 'Crate', value: (row) => row.name },
    { label: 'Version', value: (row) => row.version },
    { label: 'License', value: (row) => row.license },
    { label: 'Repository', value: (row) => row.repository || row.homepage || '' },
  ]);

  return `# Third Party Notices

Generated at: ${inventory.generatedAt}

This inventory is generated from runtime npm dependencies in \`${relativeFromRepo(join(appRoot, 'package.json'))}\` and crates in \`${relativeFromRepo(cargoLockPath)}\`.

It is intended as release evidence for Compose Tutor Studio. It does not replace legal review for a public commercial launch.

## Summary

| Ecosystem | Count |
|---|---:|
| npm runtime packages | ${inventory.npm.length} |
| Rust crates | ${inventory.cargo.length} |

${summaryTable}

## npm Runtime Packages

${npmTable}

## Rust Crates

${cargoTable}
`;
}

async function main() {
  const npm = await collectNpmRuntimeDependencies();
  const cargo = await collectCargoDependencies();
  const inventory = {
    generatedAt: new Date().toISOString(),
    sources: {
      npmPackage: relativeFromRepo(join(appRoot, 'package.json')),
      cargoLock: relativeFromRepo(cargoLockPath),
    },
    summary: {
      npmCount: npm.length,
      cargoCount: cargo.length,
      licenses: licenseSummary([npm, cargo]),
    },
    npm,
    cargo,
  };

  await mkdir(releaseOutputDir, { recursive: true });
  await writeFile(jsonOutputPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  await writeFile(markdownOutputPath, renderMarkdown(inventory), 'utf8');

  console.log(`Created ${relativeFromRepo(jsonOutputPath)}`);
  console.log(`Created ${relativeFromRepo(markdownOutputPath)}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
