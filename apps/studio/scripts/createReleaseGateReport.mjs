import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const releaseOutputDir = join(appRoot, 'src-tauri', 'target', 'release', 'release');
const jsonOutputPath = join(releaseOutputDir, 'release-gates-report.json');
const markdownOutputPath = join(releaseOutputDir, 'release-gates-report.md');

const defaultGateCommands = [
  'pnpm check',
  'pnpm check:privacy',
  'pnpm check:secrets',
  'pnpm check:assets',
  'pnpm build',
  'pnpm check:size',
  'pnpm test:e2e',
  'pnpm build:desktop',
  'pnpm check:size:desktop',
  'pnpm release:manifest',
  'pnpm release:source-status',
  'pnpm release:source-status:verify',
  'pnpm release:verify',
  'pnpm release:installers:verify',
  'pnpm release:installers:smoke:plan',
  'pnpm release:installers:smoke:verify',
  'pnpm release:signing',
  'pnpm release:signing:verify',
  'pnpm release:notices',
  'pnpm release:notices:verify',
  'pnpm release:notes',
  'pnpm release:notes:verify:draft',
  'pnpm check:release',
];

function relativeFromRepo(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

function configuredGateCommands() {
  const raw = process.env.CTS_RELEASE_GATE_COMMANDS?.trim();
  if (!raw) return defaultGateCommands;

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => (Array.isArray(entry) ? entry.join(' ') : String(entry).trim())).filter(Boolean);
    }
  } catch {
    // Fall back to newline parsing for simple PowerShell/CMD use.
  }

  return raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

function splitCommand(command) {
  const parts = command.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  return parts.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  });
}

function outputTail(value) {
  return value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim()
    .slice(-2000);
}

function formatDuration(durationMs) {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`;
}

async function gitCommit() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function runGateCommand(command) {
  const parts = splitCommand(command);
  if (parts.length === 0) throw new Error('Empty release gate command.');

  const [executable, ...args] = parts;
  const startedAt = new Date();
  const timeout = Number(process.env.CTS_RELEASE_GATE_TIMEOUT_MS || 45 * 60 * 1000);

  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd: repoRoot,
      maxBuffer: 20 * 1024 * 1024,
      shell: process.platform === 'win32',
      timeout,
    });

    return {
      command,
      result: 'Pass',
      exitCode: 0,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      stdoutTail: outputTail(stdout),
      stderrTail: outputTail(stderr),
    };
  } catch (error) {
    return {
      command,
      result: 'Fail',
      exitCode: typeof error?.code === 'number' ? error.code : 1,
      signal: error?.signal ?? null,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      stdoutTail: outputTail(String(error?.stdout ?? '')),
      stderrTail: outputTail(String(error?.stderr ?? error?.message ?? error)),
    };
  }
}

function renderMarkdown(report) {
  const rows = report.commands
    .map(
      (entry) =>
        `| \`${entry.command}\` | ${entry.result} | ${entry.exitCode} | ${formatDuration(entry.durationMs)} | ${entry.finishedAt} |`,
    )
    .join('\n');

  return `# Release Gates Report

Generated at: ${report.generatedAt}

Commit: ${report.commit || 'unknown'}

Overall result: ${report.result}

JSON report: \`${relativeFromRepo(jsonOutputPath)}\`

| Command | Result | Exit code | Duration | Finished at |
|---|---|---:|---:|---|
${rows}
`;
}

async function main() {
  const commands = configuredGateCommands();
  if (commands.length === 0) throw new Error('No release gate commands configured.');

  await mkdir(releaseOutputDir, { recursive: true });

  const results = [];
  const continueOnFail = process.env.CTS_RELEASE_GATE_CONTINUE_ON_FAIL === '1';

  for (const command of commands) {
    console.log(`Running release gate: ${command}`);
    const result = await runGateCommand(command);
    results.push(result);
    console.log(`${result.result} ${command} (${formatDuration(result.durationMs)})`);

    if (result.result !== 'Pass' && !continueOnFail) break;
  }

  const failed = results.filter((entry) => entry.result !== 'Pass');
  const report = {
    generatedAt: new Date().toISOString(),
    commit: await gitCommit(),
    result: failed.length === 0 ? 'Pass' : 'Fail',
    commandSource: process.env.CTS_RELEASE_GATE_COMMANDS ? 'CTS_RELEASE_GATE_COMMANDS' : 'default',
    commands: results,
  };

  await writeFile(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownOutputPath, renderMarkdown(report), 'utf8');

  console.log(`Created ${relativeFromRepo(jsonOutputPath)}`);
  console.log(`Created ${relativeFromRepo(markdownOutputPath)}`);

  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
