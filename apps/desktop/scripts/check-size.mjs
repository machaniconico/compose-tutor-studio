import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function getExecutableBudget(budgets, platform, arch) {
  const platformKey = `${platform}-${arch}`;
  const budget = budgets.platforms?.[platformKey]?.executable;
  if (!budget || !Number.isSafeInteger(budget.maxBytes) || budget.maxBytes <= 0) {
    throw new Error(`No valid executable size budget for ${platformKey}`);
  }
  return { platformKey, ...budget };
}

export function evaluateSize(actualBytes, budget) {
  if (!Number.isSafeInteger(actualBytes) || actualBytes < 0) {
    throw new Error(`Invalid artifact size: ${actualBytes}`);
  }
  return {
    actualBytes,
    maxBytes: budget.maxBytes,
    baselineBytes: budget.baselineBytes ?? null,
    deltaFromBaseline:
      budget.baselineBytes === undefined ? null : actualBytes - budget.baselineBytes,
    remainingBytes: budget.maxBytes - actualBytes,
    provisional: budget.provisional === true,
    ok: actualBytes <= budget.maxBytes,
  };
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function resolveProductionExecutable() {
  const manifestPath = path.join(desktopDir, 'src-tauri', 'Cargo.toml');
  const { stdout } = await execFileAsync(
    'cargo',
    ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifestPath],
    { cwd: desktopDir, maxBuffer: 4 * 1024 * 1024 },
  );
  const metadata = JSON.parse(stdout);
  const manifest = metadata.packages.find(
    (entry) => path.resolve(entry.manifest_path) === manifestPath,
  );
  const binary = manifest?.targets.find((target) => target.kind.includes('bin'));
  if (!binary) throw new Error('Cargo metadata did not contain a desktop binary target');

  const filename = `${binary.name}${process.platform === 'win32' ? '.exe' : ''}`;
  return path.join(metadata.target_directory, 'release', filename);
}

export async function checkProductionExecutable({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const budgetPath = path.join(desktopDir, 'size-budgets.json');
  const budgets = JSON.parse(await readFile(budgetPath, 'utf8'));
  if (budgets.schemaVersion !== 1) {
    throw new Error(`Unsupported size budget schema: ${budgets.schemaVersion}`);
  }

  const budget = getExecutableBudget(budgets, platform, arch);
  const executablePath = await resolveProductionExecutable();
  const artifact = await stat(executablePath);
  if (!artifact.isFile()) throw new Error(`Production executable is not a file: ${executablePath}`);

  const evaluation = evaluateSize(artifact.size, budget);
  const report = {
    schemaVersion: 1,
    artifact: 'production-executable',
    platform: budget.platformKey,
    path: executablePath,
    ...evaluation,
  };
  const resultsDir = path.join(desktopDir, 'test-results');
  await mkdir(resultsDir, { recursive: true });
  await writeFile(
    path.join(resultsDir, `size-${budget.platformKey}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const status = evaluation.ok ? 'PASS' : 'FAIL';
  const summary = `${status}: ${budget.platformKey} production executable ${formatMiB(
    evaluation.actualBytes,
  )} / ${formatMiB(evaluation.maxBytes)} max${
    evaluation.provisional ? ' (provisional)' : ''
  }`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${summary}\n`);
  }
  if (!evaluation.ok) {
    throw new Error(
      `Production executable exceeds its size budget by ${formatMiB(-evaluation.remainingBytes)}`,
    );
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkProductionExecutable().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
