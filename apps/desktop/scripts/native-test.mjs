import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { remote } from 'webdriverio';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeTestTargetDir = path.join(desktopDir, 'src-tauri', 'target', 'native-test');
const tauriCli = path.join(desktopDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const wdioCli = path.join(desktopDir, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');
const executableName =
  process.platform === 'win32'
    ? 'compose-tutor-studio-desktop.exe'
    : 'compose-tutor-studio-desktop';
const nativeTestBinary = path.join(nativeTestTargetDir, 'release', executableName);
const databaseFileName = 'projects-v1.sqlite3';
const databaseFamilySuffixes = ['', '-wal', '-shm', '-journal'];
const eraseMarkerFileName = 'erase-all-v1.json';
const portablePickerProofFileNames = {
  open: '.project-bundle-open.invoked',
  save: '.project-bundle-save.invoked',
};
const recoveryEraseIds = [
  'erase-11111111-1111-4111-8111-111111111111',
  'erase-22222222-2222-4222-8222-222222222222',
];
const externalSentinelContents = 'outside Compose Tutor Studio app data\n';
const buildOnly = process.argv.includes('--build-only');
const embeddedDriverStartupTimeoutMs = 60_000;
const embeddedDriverShutdownTimeoutMs = 15_000;
const sigkillPreDebounceDeadlineMs = 1_000;
const sigkillProtectionAcknowledgement =
  '未保存の変更は保護済みです。自動保存を待っています。';

const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

async function runNodeScript(script, args, env = process.env, acceptFailure) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: desktopDir,
    env,
    stdio: 'inherit',
  });
  const forwardSignal = (signal) => child.kill(signal);
  process.once('SIGINT', forwardSignal);
  process.once('SIGTERM', forwardSignal);

  try {
    const [code, signal] = await once(child, 'exit');
    if (code !== 0 && !(await acceptFailure?.({ code, signal }))) {
      throw new Error(
        `${path.basename(script)} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
      );
    }
  } finally {
    process.off('SIGINT', forwardSignal);
    process.off('SIGTERM', forwardSignal);
  }
}

async function reserveEphemeralPort() {
  const server = net.createServer();
  server.unref();
  server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate an embedded WebDriver port');
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForEmbeddedDriver(port, child, output) {
  const deadline = Date.now() + embeddedDriverStartupTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Native SIGKILL fixture exited before WebDriver started: ${output().slice(-2_000)}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The embedded server is still starting.
    }
    await sleep(50);
  }
  throw new Error(
    `Native SIGKILL fixture WebDriver did not start: ${output().slice(-2_000)}`,
  );
}

async function waitForEmbeddedDriverExit(port) {
  const deadline = Date.now() + embeddedDriverShutdownTimeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(300),
      });
    } catch {
      return;
    }
    await sleep(50);
  }
  throw new Error('SIGKILLed native fixture left its embedded WebDriver server reachable');
}

function forwardInterruptsToOwnedChild(child) {
  let interruptedBy;
  const forceChildDown = (signal) => {
    interruptedBy = signal;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  };
  const forwardSigint = () => forceChildDown('SIGINT');
  const forwardSigterm = () => forceChildDown('SIGTERM');
  process.once('SIGINT', forwardSigint);
  process.once('SIGTERM', forwardSigterm);
  return {
    interruptedBy: () => interruptedBy,
    remove: () => {
      process.off('SIGINT', forwardSigint);
      process.off('SIGTERM', forwardSigterm);
    },
  };
}

async function launchOwnedNativeSession(dataDirectory) {
  const port = await reserveEphemeralPort();
  let capturedOutput = '';
  let spawnError = null;
  const child = spawn(nativeTestBinary, [], {
    cwd: desktopDir,
    env: {
      ...process.env,
      CTS_NATIVE_TEST_DATA_DIR: dataDirectory,
      TAURI_WEBDRIVER_PORT: String(port),
      WDIO_EMBEDDED_SERVER: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const signalForwarding = forwardInterruptsToOwnedChild(child);
  child.once('error', (error) => {
    spawnError = error;
  });
  child.stdout?.on('data', (chunk) => {
    capturedOutput += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    capturedOutput += chunk.toString();
  });
  const output = () => capturedOutput;
  try {
    await waitForEmbeddedDriver(port, child, output);
    if (spawnError) throw spawnError;
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new Error('Owned native SIGKILL fixture has no trustworthy process id');
    }
    const client = await remote({
      logLevel: 'error',
      protocol: 'http',
      hostname: '127.0.0.1',
      port,
      path: '/',
      connectionRetryTimeout: 10_000,
      connectionRetryCount: 0,
      capabilities: {
        browserName: 'tauri',
        'tauri:options': { application: nativeTestBinary },
      },
    });
    await client.waitUntil(
      async () => {
        const shell = await client.$('.app-shell');
        return (await shell.isExisting()) && (await shell.isDisplayed());
      },
      {
        timeout: 30_000,
        interval: 50,
        timeoutMsg: 'Studio shell did not render in the owned SIGKILL fixture',
      },
    );
    return { child, client, port, output, signalForwarding };
  } catch (error) {
    signalForwarding.remove();
    await killOwnedNativeSession({ child, port }).catch(() => undefined);
    throw error;
  }
}

async function killOwnedNativeSession(session, { requireSigkill = false } = {}) {
  const { child, port } = session;
  if (child.exitCode !== null || child.signalCode !== null) {
    await waitForEmbeddedDriverExit(port);
    if (requireSigkill) {
      throw new Error(
        `Native fixture exited with ${
          child.signalCode ?? child.exitCode
        } before SIGKILL was delivered`,
      );
    }
    return { code: child.exitCode, signal: child.signalCode };
  }

  const exited = once(child, 'exit');
  if (!child.kill('SIGKILL')) {
    throw new Error('Could not deliver SIGKILL to the exact native fixture process');
  }
  const [code, signal] = await exited;
  await waitForEmbeddedDriverExit(port);
  if (process.platform !== 'win32' && signal !== 'SIGKILL') {
    throw new Error(`Native fixture exited with ${signal ?? code} instead of SIGKILL`);
  }
  if (process.platform === 'win32' && code === 0) {
    throw new Error('Windows native fixture reported a clean exit after forced termination');
  }
  return { code, signal };
}

async function dismissOwnedSessionOnboarding(client) {
  const onboarding = await client.$('.onboarding-overlay');
  if ((await onboarding.isExisting()) && (await onboarding.isDisplayed())) {
    await (await client.$('button=あとで')).click();
    await client.waitUntil(
      async () => !(await (await client.$('.onboarding-overlay')).isExisting()),
      {
        timeout: 10_000,
        interval: 20,
        timeoutMsg: 'Owned SIGKILL fixture onboarding did not close',
      },
    );
  }
}

async function runSigkillWritePhase(dataDirectory, titles) {
  let session;
  let killed = false;
  try {
    session = await launchOwnedNativeSession(dataDirectory);
    await dismissOwnedSessionOnboarding(session.client);

    const title = await session.client.$('input[aria-label="プロジェクト名"]');
    await title.setValue(titles.baseline);
    await (await session.client.$('button=保存')).click();
    await session.client.waitUntil(
      async () =>
        (await title.getValue()) === titles.baseline &&
        (await (await session.client.$('#project-save-status')).getText()).includes('保存済み'),
      {
        timeout: 10_000,
        interval: 20,
        timeoutMsg: 'SIGKILL baseline did not become an explicit SQLite commit',
      },
    );

    const editStartedAt = performance.now();
    await title.setValue(titles.pending);
    try {
      await session.client.waitUntil(
        async () =>
          (await title.getValue()) === titles.pending &&
          (await (await session.client.$('#project-save-status')).getText()) ===
            sigkillProtectionAcknowledgement,
        {
          timeout: sigkillPreDebounceDeadlineMs,
          interval: 10,
          timeoutMsg:
            'SIGKILL edit did not receive its durable protection acknowledgement before the autosave deadline',
        },
      );
    } catch (error) {
      const observed = {
        title: await title.getValue().catch(() => '<unavailable>'),
        saveStatus: await session.client
          .$('#project-save-status')
          .then((element) => element.getText())
          .catch(() => '<unavailable>'),
        elapsedMs: Math.floor(performance.now() - editStartedAt),
        nativeOutput: session.output().slice(-2_000),
      };
      throw new Error(`${error.message}: ${JSON.stringify(observed)}`, { cause: error });
    }
    const preKillTitle = await title.getValue();
    const preKillSaveStatus = await (
      await session.client.$('#project-save-status')
    ).getText();
    const acceptedElapsedMs = performance.now() - editStartedAt;
    if (
      preKillTitle !== titles.pending ||
      preKillSaveStatus !== sigkillProtectionAcknowledgement
    ) {
      throw new Error(
        `SIGKILL precondition changed before termination: ${JSON.stringify({
          title: preKillTitle,
          saveStatus: preKillSaveStatus,
        })}`,
      );
    }
    if (acceptedElapsedMs >= sigkillPreDebounceDeadlineMs) {
      throw new Error(
        `SIGKILL precondition exceeded the debounce-safe deadline (${acceptedElapsedMs}ms)`,
      );
    }
    const preKill = {
      pid: session.child.pid,
      title: preKillTitle,
      saveStatus: preKillSaveStatus,
      acceptedElapsedMs: Math.floor(acceptedElapsedMs),
    };

    // Do not delete the WebDriver session or request a window close: either path
    // could run pagehide/beforeunload and turn this into a graceful recovery test.
    const exit = await killOwnedNativeSession(session, { requireSigkill: true });
    killed = true;
    const interruptedBy = session.signalForwarding.interruptedBy();
    if (interruptedBy) {
      throw new Error(`Native SIGKILL fixture was interrupted by ${interruptedBy}`);
    }
    console.info('[native-e2e] forced exact process exit before autosave', {
      ...preKill,
      exit,
    });
  } finally {
    session?.signalForwarding.remove();
    if (session && !killed) {
      await killOwnedNativeSession(session).catch((error) => {
        console.warn('Could not clean up the owned SIGKILL fixture:', error);
      });
    }
  }
}

async function hasExpectedCloseProof(proof) {
  try {
    return (await readFile(proof.path, 'utf8')) === proof.token;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function runWdioPhase(
  phase,
  dataDirectory,
  additionalEnvironment = {},
  expectedCloseProof,
) {
  const embeddedPort = await reserveEphemeralPort();
  await runNodeScript(
    wdioCli,
    ['run', 'wdio.conf.ts'],
    {
      ...process.env,
      ...additionalEnvironment,
      TAURI_WEBDRIVER_PORT: String(embeddedPort),
      CTS_NATIVE_TEST_DATA_DIR: dataDirectory,
      CTS_NATIVE_E2E_PHASE: phase,
    },
    async ({ code, signal }) => {
      const accepted =
        expectedCloseProof !== undefined &&
        code === 1 &&
        signal === null &&
        (await hasExpectedCloseProof(expectedCloseProof));
      if (accepted) {
        console.info(
          '[native-e2e] accepted the expected WDIO teardown failure after verified native close',
        );
      }
      return accepted;
    },
  );
  if (expectedCloseProof && !(await hasExpectedCloseProof(expectedCloseProof))) {
    throw new Error(`Native ${phase} phase ended without its fresh close-handoff proof`);
  }
}

function databaseFamilyPaths(dataDirectory) {
  const databasePath = path.join(dataDirectory, databaseFileName);
  return databaseFamilySuffixes.map((suffix) => `${databasePath}${suffix}`);
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertPathsAbsent(paths, context) {
  const remaining = [];
  for (const filePath of paths) {
    if (await pathExists(filePath)) remaining.push(path.basename(filePath));
  }
  if (remaining.length > 0) {
    throw new Error(`${context} left local data behind: ${remaining.join(', ')}`);
  }
}

function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  return `crc32:${((checksum ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')}`;
}

if (crc32(Buffer.from('123456789')) !== 'crc32:cbf43926') {
  throw new Error('Native erase marker CRC32 implementation failed its standard check vector');
}

function eraseMarkerBytes(eraseId) {
  const checksumInput = JSON.stringify({ storageVersion: 1, eraseId });
  return Buffer.from(
    JSON.stringify({
      storageVersion: 1,
      eraseId,
      checksum: crc32(Buffer.from(checksumInput)),
    }),
  );
}

async function portableBundleAssetChecksum(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.length < 32 || bytes.subarray(0, 8).toString('utf8') !== 'CTSBNDL1') {
    throw new Error('Native portable E2E did not create a valid bundle header');
  }
  const manifestLength = bytes.readUInt32LE(12);
  const manifest = JSON.parse(
    bytes.subarray(32, 32 + manifestLength).toString('utf8'),
  );
  const checksum = manifest?.assets?.[0]?.checksumSha256;
  if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error('Native portable E2E bundle has no verified asset checksum');
  }
  return checksum;
}

function portablePickerProofPaths(root) {
  return {
    open: path.join(root, portablePickerProofFileNames.open),
    save: path.join(root, portablePickerProofFileNames.save),
  };
}

async function resetPortablePickerProofs(root) {
  await Promise.all(
    Object.values(portablePickerProofPaths(root))
      .map((proofPath) => rm(proofPath, { force: true })),
  );
}

async function assertPortablePickerProofs(root, context) {
  const proofs = portablePickerProofPaths(root);
  for (const [kind, proofPath] of Object.entries(proofs)) {
    let contents;
    try {
      contents = await readFile(proofPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`${context} did not invoke the native ${kind} picker`);
      }
      throw error;
    }
    if (contents !== `${kind}\n`) {
      throw new Error(`${context} left an invalid native ${kind} picker proof`);
    }
  }
}

function portableAudioObjectPath(dataDirectory, checksum) {
  return path.join(dataDirectory, 'audio-assets-v1', 'sha256', checksum);
}

async function assertPortableAudioObject(dataDirectory, checksum, context) {
  const objectPath = portableAudioObjectPath(dataDirectory, checksum);
  let bytes;
  try {
    bytes = await readFile(objectPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${context} did not persist the imported audio object`);
    }
    throw error;
  }
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) {
    throw new Error(`${context} persisted an audio object with the wrong checksum`);
  }
}

async function snapshotDatabaseFamily(dataDirectory) {
  const snapshot = new Map();
  for (const suffix of databaseFamilySuffixes) {
    const filePath = `${path.join(dataDirectory, databaseFileName)}${suffix}`;
    if (await pathExists(filePath)) snapshot.set(suffix, await readFile(filePath));
  }
  const database = snapshot.get('');
  if (!database || database.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
    throw new Error('Native write/restore did not leave an intact SQLite database to recover');
  }
  return snapshot;
}

async function seedRecoveryFixture(dataDirectory, eraseId, databaseSnapshot) {
  await mkdir(dataDirectory, { recursive: true });
  const databasePath = path.join(dataDirectory, databaseFileName);
  for (const [suffix, bytes] of databaseSnapshot) {
    await writeFile(`${databasePath}${suffix}`, bytes, { flag: 'wx' });
  }
  await writeFile(
    path.join(dataDirectory, eraseMarkerFileName),
    eraseMarkerBytes(eraseId),
    { flag: 'wx' },
  );
}

async function runNativeBinaryUntilExit(dataDirectory, fixtureName) {
  const env = {
    ...process.env,
    CTS_NATIVE_TEST_DATA_DIR: dataDirectory,
    CTS_NATIVE_TEST_CLOSE_GRACE_MS: '250',
  };
  delete env.WDIO_EMBEDDED_SERVER;
  delete env.TAURI_WEBDRIVER_PORT;

  const child = spawn(nativeTestBinary, [], {
    cwd: desktopDir,
    env,
    stdio: 'inherit',
  });
  const forwardSignal = (signal) => child.kill(signal);
  process.once('SIGINT', forwardSignal);
  process.once('SIGTERM', forwardSignal);

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        action();
      };
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        finish(() => reject(new Error(`${fixtureName} recovery did not exit within 45 seconds`)));
      }, 45_000);
      child.once('error', (error) => finish(() => reject(error)));
      child.once('exit', (code, signal) =>
        finish(() => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(
            new Error(
              `${fixtureName} recovery exited${signal ? ` with signal ${signal}` : ` with code ${code}`}`,
            ),
          );
        }),
      );
    });
  } finally {
    process.off('SIGINT', forwardSignal);
    process.off('SIGTERM', forwardSignal);
  }
}

const temporaryDirectories = [];

async function makeTemporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

try {
  await runNodeScript(
    tauriCli,
    [
      'build',
      '--no-bundle',
      '--ci',
      '--features',
      'native-test',
      '--config',
      'src-tauri/tauri.test.conf.json',
    ],
    { ...process.env, CARGO_TARGET_DIR: nativeTestTargetDir },
  );

  if (!buildOnly) {
    const nativeTestDataDirectory = await makeTemporaryDirectory('cts-native-e2e-');
    const externalDirectory = await makeTemporaryDirectory('cts-native-e2e-external-');
    const externalSentinel = path.join(externalDirectory, 'must-survive.txt');
    await writeFile(externalSentinel, externalSentinelContents, { flag: 'wx' });

    await runWdioPhase('write', nativeTestDataDirectory);
    await runWdioPhase('restore', nativeTestDataDirectory);

    const portableRoot = await makeTemporaryDirectory('cts-native-e2e-portable-files-');
    const portableExportData = await makeTemporaryDirectory(
      'cts-native-e2e-portable-export-',
    );
    const portableImportData = await makeTemporaryDirectory(
      'cts-native-e2e-portable-import-',
    );
    const portableCancelData = await makeTemporaryDirectory(
      'cts-native-e2e-portable-cancel-',
    );
    const portableTitle = `Native Portable ${randomBytes(12).toString('hex')}`;
    const seedBundlePath = path.join(portableRoot, 'seed.ctsbundle');
    const exportedBundlePath = path.join(portableRoot, 'exported.ctsbundle');
    const reexportedBundlePath = path.join(portableRoot, 'reexported.ctsbundle');
    const cancelledFinalPath = path.join(portableRoot, 'cancelled.ctsbundle');
    await resetPortablePickerProofs(portableRoot);
    await runWdioPhase('bundle-export', portableExportData, {
      CTS_NATIVE_TEST_PROJECT_BUNDLE_ROOT: portableRoot,
      CTS_NATIVE_TEST_PROJECT_BUNDLE_OPEN_PATH: seedBundlePath,
      CTS_NATIVE_TEST_PROJECT_BUNDLE_SAVE_PATH: exportedBundlePath,
      CTS_NATIVE_E2E_PROJECT_BUNDLE_TITLE: portableTitle,
    });
    await assertPortablePickerProofs(portableRoot, 'Native portable export phase');
    const portableChecksum = await portableBundleAssetChecksum(exportedBundlePath);
    await assertPortableAudioObject(
      portableExportData,
      portableChecksum,
      'Native portable export phase',
    );
    const importedAudioObject = portableAudioObjectPath(
      portableImportData,
      portableChecksum,
    );
    await assertPathsAbsent(
      [importedAudioObject],
      'Native portable storage-isolation precondition',
    );
    await resetPortablePickerProofs(portableRoot);
    await runWdioPhase('bundle-import', portableImportData, {
      CTS_NATIVE_TEST_PROJECT_BUNDLE_ROOT: portableRoot,
      CTS_NATIVE_TEST_PROJECT_BUNDLE_OPEN_PATH: exportedBundlePath,
      CTS_NATIVE_TEST_PROJECT_BUNDLE_SAVE_PATH: reexportedBundlePath,
      CTS_NATIVE_E2E_PROJECT_BUNDLE_CHECKSUM: portableChecksum,
      CTS_NATIVE_E2E_PROJECT_BUNDLE_TITLE: portableTitle,
    });
    await assertPortablePickerProofs(portableRoot, 'Native portable import phase');
    await assertPortableAudioObject(
      portableImportData,
      portableChecksum,
      'Native portable import phase',
    );
    await assertPortableAudioObject(
      portableExportData,
      portableChecksum,
      'Native portable export isolation control',
    );
    await resetPortablePickerProofs(portableRoot);
    await runWdioPhase('bundle-cancel', portableCancelData, {
      CTS_NATIVE_TEST_PROJECT_BUNDLE_ROOT: portableRoot,
      CTS_NATIVE_TEST_PROJECT_BUNDLE_OPEN_PATH: 'cancel',
      CTS_NATIVE_TEST_PROJECT_BUNDLE_SAVE_PATH: 'cancel',
      CTS_NATIVE_E2E_PROJECT_BUNDLE_CANCEL_FINAL_PATH: cancelledFinalPath,
    });
    await assertPortablePickerProofs(portableRoot, 'Native portable cancel phase');
    await assertPathsAbsent(
      [
        cancelledFinalPath,
        portableAudioObjectPath(portableCancelData, portableChecksum),
      ],
      'Native portable cancellation',
    );

    const normalCloseTitle = `Native Close ${randomBytes(12).toString('hex')}`;
    const normalCloseRequest = {
      path: path.join(externalDirectory, 'normal-close.request'),
      token: randomBytes(32).toString('hex'),
    };
    const normalCloseProof = {
      path: path.join(externalDirectory, 'normal-close-handoff.proof'),
      token: randomBytes(32).toString('hex'),
    };
    await runWdioPhase(
      'normal-close',
      nativeTestDataDirectory,
      {
        CTS_NATIVE_TEST_CLOSE_GRACE_MS: '3000',
        CTS_NATIVE_E2E_NORMAL_CLOSE_TITLE: normalCloseTitle,
        CTS_NATIVE_E2E_NORMAL_CLOSE_REQUEST_PATH: normalCloseRequest.path,
        CTS_NATIVE_E2E_NORMAL_CLOSE_REQUEST_TOKEN: normalCloseRequest.token,
        CTS_NATIVE_E2E_CLOSE_PROOF_PATH: normalCloseProof.path,
        CTS_NATIVE_E2E_CLOSE_PROOF_TOKEN: normalCloseProof.token,
      },
      normalCloseProof,
    );
    if (!(await hasExpectedCloseProof(normalCloseRequest))) {
      throw new Error('Native normal-close phase did not preserve its fresh external request');
    }
    await runWdioPhase(
      'normal-close-restart',
      nativeTestDataDirectory,
      { CTS_NATIVE_E2E_NORMAL_CLOSE_TITLE: normalCloseTitle },
    );

    const sigkillDataDirectory = await makeTemporaryDirectory('cts-native-e2e-sigkill-');
    const sigkillToken = randomBytes(12).toString('hex');
    const sigkillTitles = {
      baseline: `Native SIGKILL Baseline ${sigkillToken}`,
      pending: `Native SIGKILL Pending ${sigkillToken}`,
      writable: `Native SIGKILL Writable ${sigkillToken}`,
    };
    await runSigkillWritePhase(sigkillDataDirectory, sigkillTitles);
    await runWdioPhase('sigkill-restart', sigkillDataDirectory, {
      CTS_NATIVE_E2E_SIGKILL_BASELINE_TITLE: sigkillTitles.baseline,
      CTS_NATIVE_E2E_SIGKILL_PENDING_TITLE: sigkillTitles.pending,
      CTS_NATIVE_E2E_SIGKILL_WRITABLE_TITLE: sigkillTitles.writable,
    });
    await runWdioPhase('sigkill-second-restart', sigkillDataDirectory, {
      CTS_NATIVE_E2E_SIGKILL_BASELINE_TITLE: sigkillTitles.baseline,
      CTS_NATIVE_E2E_SIGKILL_PENDING_TITLE: sigkillTitles.pending,
      CTS_NATIVE_E2E_SIGKILL_WRITABLE_TITLE: sigkillTitles.writable,
    });

    const databaseSnapshot = await snapshotDatabaseFamily(nativeTestDataDirectory);

    const closeProof = {
      path: path.join(externalDirectory, 'erase-close-handoff.proof'),
      token: randomBytes(32).toString('hex'),
    };
    await runWdioPhase(
      'erase',
      nativeTestDataDirectory,
      {
        CTS_NATIVE_TEST_CLOSE_GRACE_MS: '3000',
        CTS_NATIVE_E2E_CLOSE_PROOF_PATH: closeProof.path,
        CTS_NATIVE_E2E_CLOSE_PROOF_TOKEN: closeProof.token,
      },
      closeProof,
    );
    await assertPathsAbsent(
      [
        ...databaseFamilyPaths(nativeTestDataDirectory),
        path.join(nativeTestDataDirectory, eraseMarkerFileName),
      ],
      'Native UI erase',
    );
    if ((await readFile(externalSentinel, 'utf8')) !== externalSentinelContents) {
      throw new Error('Native UI erase changed a sentinel outside the app data directory');
    }

    const intactRecoveryDirectory = await makeTemporaryDirectory(
      'cts-native-e2e-recovery-intact-',
    );
    await seedRecoveryFixture(
      intactRecoveryDirectory,
      recoveryEraseIds[0],
      databaseSnapshot,
    );
    await runNativeBinaryUntilExit(intactRecoveryDirectory, 'Intact database');
    await assertPathsAbsent(
      [
        ...databaseFamilyPaths(intactRecoveryDirectory),
        path.join(intactRecoveryDirectory, eraseMarkerFileName),
      ],
      'Intact-database startup recovery',
    );

    const sidecarRecoveryDirectory = await makeTemporaryDirectory(
      'cts-native-e2e-recovery-sidecar-',
    );
    await seedRecoveryFixture(
      sidecarRecoveryDirectory,
      recoveryEraseIds[1],
      new Map([['-wal', Buffer.from('partial SQLite sidecar')]]),
    );
    await runNativeBinaryUntilExit(sidecarRecoveryDirectory, 'Partial sidecar');
    await assertPathsAbsent(
      [
        ...databaseFamilyPaths(sidecarRecoveryDirectory),
        path.join(sidecarRecoveryDirectory, eraseMarkerFileName),
      ],
      'Partial-sidecar startup recovery',
    );

    // Restart the directory that held the copied PROJECT_TITLE database plus a
    // pending marker. This proves startup recovery, not only the UI erase path,
    // made that saved project durably absent to the next normal repository boot.
    await runWdioPhase('blank-restart', intactRecoveryDirectory);
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  for (const directory of temporaryDirectories.reverse()) {
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      console.warn('Could not remove an isolated native-test directory:', error);
    });
  }
}
