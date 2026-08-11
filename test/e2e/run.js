const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
  runTests,
  TestRunFailedError,
} = require('@vscode/test-electron');
const { runVisualAcceptance } = require('./visual-controller');

const SQLTOOLS_EXTENSION_ID = 'mtxr.sqltools';

async function main() {
  if (shouldStartDisplayServer()) {
    process.exit(await runWithDisplayServer());
  }

  const projectRoot = path.resolve(__dirname, '../..');
  const testRoot = path.join(projectRoot, '.vscode-test', 'e2e');
  const userDataDir = path.join(testRoot, 'user-data');
  const extensionsDir = path.join(testRoot, 'extensions');
  const workspacePath = path.join(__dirname, 'workspace');
  const extensionTestsPath = path.join(__dirname, 'suite');
  let visualControlDir = '';

  try {
    configureLinuxRuntimeLibraryPath(projectRoot);
    fs.mkdirSync(testRoot, { recursive: true });
    const visualRequested = process.env.KDB_SQLTOOLS_E2E_SKIP_VISUAL !== '1';
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });

    const vscodeExecutablePath = await downloadAndUnzipVSCode({
      version: process.env.KDB_SQLTOOLS_E2E_VSCODE_VERSION || 'stable',
    });
    const sqltoolsInstalled = await ensureSqlToolsExtension(vscodeExecutablePath, extensionsDir, userDataDir);
    const visualAcceptance = visualRequested && sqltoolsInstalled;
    if (visualRequested && !sqltoolsInstalled) {
      console.warn('Skipping native visual acceptance because the SQLTools extension is unavailable.');
    }
    visualControlDir = visualAcceptance
      ? fs.mkdtempSync(path.join(os.tmpdir(), 'kdb-sqltools-visual-acceptance-'))
      : '';
    const remoteDebuggingPort = visualAcceptance ? await availablePort() : 0;

    const visualPromise = visualAcceptance
      ? runVisualAcceptance({ port: remoteDebuggingPort, controlDir: visualControlDir })
      : Promise.resolve();
    const testOptions = {
      vscodeExecutablePath,
      extensionDevelopmentPath: projectRoot,
      extensionTestsPath,
      extensionTestsEnv: {
        KDB_SQLTOOLS_E2E_SQLTOOLS_INSTALLED: sqltoolsInstalled ? '1' : '0',
        KDB_SQLTOOLS_E2E_VISUAL: visualAcceptance ? '1' : '0',
        KDB_SQLTOOLS_E2E_VISUAL_CONTROL_DIR: visualControlDir,
      },
      launchArgs: [
        workspacePath,
        '--extensions-dir',
        extensionsDir,
        '--user-data-dir',
        userDataDir,
        ...(visualAcceptance ? [`--remote-debugging-port=${remoteDebuggingPort}`] : []),
      ],
    };
    const testsPromise = visualAcceptance
      ? runReloadAwareVisualTests({
        testOptions,
        controlDir: visualControlDir,
        remoteDebuggingPort,
      })
      : runTests(testOptions);
    const [testsResult, visualResult] = await Promise.allSettled([testsPromise, visualPromise]);
    if (testsResult.status === 'rejected') {
      throw testsResult.reason;
    }
    if (visualResult.status === 'rejected') {
      throw visualResult.reason;
    }
  } finally {
    if (visualControlDir) {
      fs.rmSync(visualControlDir, { recursive: true, force: true });
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function runReloadAwareVisualTests({ testOptions, controlDir, remoteDebuggingPort }) {
  const markerPath = path.join(controlDir, 'grid-reload-marker.json');
  try {
    await runTests(testOptions);
    throw new Error('Grid reload phase returned normally instead of terminating the VS Code test host.');
  } catch (error) {
    const marker = readReloadMarker(markerPath);
    if (
      !(error instanceof TestRunFailedError) ||
      error.code !== 1 ||
      !marker ||
      marker.version !== 1 ||
      marker.phaseOneComplete !== true ||
      marker.reloadCommand !== 'workbench.action.reloadWindow' ||
      marker.reloadCommandIssued !== true ||
      (
        marker.reloadPromiseCancellation &&
        (
          marker.reloadPromiseCancellation.name !== 'Canceled' ||
          marker.reloadPromiseCancellation.message !== 'Canceled'
        )
      )
    ) {
      throw error;
    }
    if (marker.reloadPromiseCancellation) {
      console.log('Reload command was canceled by the expected Extension Host teardown.');
    }
    console.log('VS Code test host exited for workbench.action.reloadWindow; starting persisted-profile phase 2.');
  }

  await waitForPortAvailable(remoteDebuggingPort, 30000);
  await runTests(testOptions);
}

function readReloadMarker(markerPath) {
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function shouldStartDisplayServer() {
  return process.platform === 'linux'
    && !process.env.DISPLAY
    && !process.env.KDB_SQLTOOLS_E2E_XVFB
    && (Boolean(findExecutable('xvfb-run')) || Boolean(findExecutable('Xvfb')));
}

async function runWithDisplayServer() {
  if (findExecutable('xvfb-run') && findExecutable('xauth')) {
    return runWithXvfbRun();
  }

  if (findExecutable('Xvfb')) {
    return runWithDirectXvfb();
  }

  throw new Error('No DISPLAY is set and neither xvfb-run nor Xvfb is available.');
}

function runWithXvfbRun() {
  const xvfbRun = findExecutable('xvfb-run');
  const result = cp.spawnSync(xvfbRun, ['-a', process.execPath, __filename], {
    env: Object.assign({}, process.env, { KDB_SQLTOOLS_E2E_XVFB: '1' }),
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  return result.status === null ? 1 : result.status;
}

async function runWithDirectXvfb() {
  const xvfb = cp.spawn(findExecutable('Xvfb'), ['-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  try {
    const display = await readDisplayNumber(xvfb);
    const result = cp.spawnSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, {
        DISPLAY: `:${display}`,
        KDB_SQLTOOLS_E2E_XVFB: '1',
      }),
      stdio: 'inherit',
    });

    if (result.error) {
      throw result.error;
    }
    return result.status === null ? 1 : result.status;
  } finally {
    xvfb.kill();
  }
}

function readDisplayNumber(xvfb) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for Xvfb to start')), 10000);

    xvfb.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    xvfb.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Xvfb exited before reporting a display number with code ${code}`));
    });
    xvfb.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      const match = output.match(/\d+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
  });
}

function findExecutable(command) {
  const result = cp.spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    encoding: 'utf8',
    shell: process.platform !== 'win32',
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.split(/\r?\n/).find(Boolean) || null;
}

function configureLinuxRuntimeLibraryPath(projectRoot) {
  if (process.platform !== 'linux') {
    return;
  }

  const candidates = [
    process.env.KDB_SQLTOOLS_E2E_RUNTIME_LIB_DIR,
    path.join(projectRoot, '.vscode-test', 'apt-libs', 'root', 'usr', 'lib', 'x86_64-linux-gnu'),
  ].filter(Boolean);

  const existing = candidates.filter(candidate => fs.existsSync(candidate));
  if (existing.length === 0) {
    return;
  }

  process.env.LD_LIBRARY_PATH = existing
    .concat(process.env.LD_LIBRARY_PATH ? [process.env.LD_LIBRARY_PATH] : [])
    .join(path.delimiter);
}

async function ensureSqlToolsExtension(vscodeExecutablePath, extensionsDir, userDataDir) {
  if (process.env.KDB_SQLTOOLS_E2E_SKIP_SQLTOOLS_INSTALL === '1') {
    return hasInstalledExtension(extensionsDir, SQLTOOLS_EXTENSION_ID);
  }

  if (hasInstalledExtension(extensionsDir, SQLTOOLS_EXTENSION_ID) && process.env.KDB_SQLTOOLS_E2E_FORCE_SQLTOOLS_INSTALL !== '1') {
    return true;
  }

  const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
  const args = [
    '--extensions-dir',
    extensionsDir,
    '--user-data-dir',
    userDataDir,
    '--install-extension',
    SQLTOOLS_EXTENSION_ID,
    '--force',
  ];

  const result = cp.spawnSync(cliPath, args, {
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0 && hasInstalledExtension(extensionsDir, SQLTOOLS_EXTENSION_ID)) {
    return true;
  }

  if (process.env.KDB_SQLTOOLS_E2E_ALLOW_SQLTOOLS_INSTALL_FAILURE === '1') {
    console.warn(`Could not install ${SQLTOOLS_EXTENSION_ID}; continuing with driver-only VS Code host tests.`);
    return false;
  }

  throw new Error(`Failed to install ${SQLTOOLS_EXTENSION_ID} into ${extensionsDir}. Set KDB_SQLTOOLS_E2E_ALLOW_SQLTOOLS_INSTALL_FAILURE=1 to run the driver-only fallback.`);
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForPortAvailable(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const server = net.createServer();
      server.unref();
      server.once('error', error => {
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for CDP port ${port} after reload: ${error.message}`));
          return;
        }
        setTimeout(attempt, 100);
      });
      server.listen(port, '127.0.0.1', () => {
        server.close(error => error ? reject(error) : resolve());
      });
    };
    attempt();
  });
}

function hasInstalledExtension(extensionsDir, extensionId) {
  if (!fs.existsSync(extensionsDir)) {
    return false;
  }

  const prefix = `${extensionId.toLowerCase()}-`;
  return fs.readdirSync(extensionsDir).some(entry => entry.toLowerCase().startsWith(prefix));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
