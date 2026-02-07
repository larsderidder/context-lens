#!/usr/bin/env node

const { spawn } = require('child_process');
const { join } = require('path');
const { platform } = require('os');
const fs = require('fs');
const net = require('net');

// Known tool config: env vars for the child process, extra CLI args, server env vars, and whether mitmproxy is needed
const PROXY_URL = 'http://localhost:4040';
const MITM_PORT = 8080;
const MITM_PROXY_URL = `http://localhost:${MITM_PORT}`;

const TOOL_CONFIG = {
  'claude': {
    childEnv: { ANTHROPIC_BASE_URL: PROXY_URL },
    extraArgs: [],
    serverEnv: {},
    needsMitm: false,
  },
  'codex': {
    // Codex subscription uses chatgpt.com with Cloudflare — needs forward proxy (mitmproxy)
    // to intercept HTTPS traffic without breaking TLS fingerprinting.
    childEnv: {
      https_proxy: MITM_PROXY_URL,
      SSL_CERT_FILE: join(process.env.HOME || '', '.mitmproxy', 'mitmproxy-ca-cert.pem'),
    },
    extraArgs: [],
    serverEnv: {},
    needsMitm: true,
  },
  'aider': {
    childEnv: { ANTHROPIC_BASE_URL: PROXY_URL, OPENAI_BASE_URL: PROXY_URL },
    extraArgs: [],
    serverEnv: {},
    needsMitm: false,
  },
};

function getToolConfig(toolName) {
  return TOOL_CONFIG[toolName] || {
    childEnv: { ANTHROPIC_BASE_URL: PROXY_URL, OPENAI_BASE_URL: PROXY_URL },
    extraArgs: [],
    serverEnv: {},
    needsMitm: false,
  };
}

const LOCKFILE = '/tmp/context-lens.lock';

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
  // Standalone mode: just start the proxy server
  const serverPath = join(__dirname, 'server.js');
  const server = spawn('node', [serverPath], { stdio: 'inherit' });
  server.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => server.kill('SIGINT'));
  process.on('SIGTERM', () => server.kill('SIGTERM'));
  // Prevent early exit
  process.stdin.resume();
  return;
}

// Skip '--' separator if present
let commandArgs = args;
if (args[0] === '--') {
  commandArgs = args.slice(1);
}

if (commandArgs.length === 0) {
  console.error('Error: No command specified after --');
  process.exit(1);
}

const commandName = commandArgs[0];
const commandArguments = commandArgs.slice(1);

// Get tool-specific config
const toolConfig = getToolConfig(commandName);

// Check if proxy is already running
function isProxyRunning() {
  return new Promise((resolve) => {
    const socket = net.connect({ port: 4040, host: 'localhost' }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// Increment reference count in lockfile
function incrementRefCount() {
  try {
    let count = 0;
    if (fs.existsSync(LOCKFILE)) {
      const data = fs.readFileSync(LOCKFILE, 'utf8');
      count = parseInt(data) || 0;
    }
    fs.writeFileSync(LOCKFILE, String(count + 1));
    return count + 1;
  } catch (err) {
    console.error('Warning: failed to update lockfile:', err.message);
    return 1;
  }
}

// If the proxy isn't actually running but a lockfile exists, it's stale (e.g. prior crash).
function clearStaleLockfile() {
  try {
    if (fs.existsSync(LOCKFILE)) fs.unlinkSync(LOCKFILE);
  } catch (err) {
    console.error('Warning: failed to clear stale lockfile:', err.message);
  }
}

// Decrement reference count in lockfile
function decrementRefCount() {
  try {
    if (!fs.existsSync(LOCKFILE)) return 0;
    const data = fs.readFileSync(LOCKFILE, 'utf8');
    const count = Math.max(0, (parseInt(data) || 1) - 1);
    if (count === 0) {
      fs.unlinkSync(LOCKFILE);
    } else {
      fs.writeFileSync(LOCKFILE, String(count));
    }
    return count;
  } catch (err) {
    console.error('Warning: failed to update lockfile:', err.message);
    return 0;
  }
}

let serverProcess = null;
let mitmProcess = null;
let serverReady = false;
let mitmReady = false;
let childProcess = null;
let shouldShutdownProxy = false;

// Start proxy or attach to existing one
async function initializeProxy() {
  const alreadyRunning = await isProxyRunning();
  
  if (alreadyRunning) {
    console.log('🔍 Context Lens proxy already running, attaching to it...');
    incrementRefCount();
    serverReady = true;
    shouldShutdownProxy = false;
    maybeStartMitmThenChild();
  } else {
    console.log('🔍 Starting Context Lens proxy and web UI...');
    // No proxy is listening on :4040. Any existing lockfile is stale and would prevent shutdown later.
    clearStaleLockfile();
    incrementRefCount();
    shouldShutdownProxy = true;
    
    const serverPath = join(__dirname, 'server.js');
    serverProcess = spawn('node', [serverPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: { ...toolConfig.serverEnv, ...process.env, CONTEXT_LENS_CLI: '1' },
    });

    // Wait for server to be ready, then suppress output (visible in web UI at :4041)
    serverProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (!serverReady) {
        process.stderr.write(output);
      }
      if (output.includes('Context Lens Web UI running') && !serverReady) {
        serverReady = true;
        maybeStartMitmThenChild();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      if (!serverReady) {
        process.stderr.write(data);
      }
    });

    serverProcess.on('error', (err) => {
      console.error('Failed to start server:', err);
      decrementRefCount();
      process.exit(1);
    });

    serverProcess.on('exit', (code) => {
      if (!serverReady) {
        console.error('Server exited unexpectedly');
        decrementRefCount();
        process.exit(code || 1);
      }
    });

    // Open browser after a short delay (only when starting new server)
    setTimeout(() => {
      openBrowser('http://localhost:4041');
    }, 1000);
  }
}

initializeProxy();

// Start mitmproxy if needed, then start the child
function maybeStartMitmThenChild() {
  if (!toolConfig.needsMitm) {
    return startChild();
  }

  const addonPath = join(__dirname, 'mitm_addon.py');
  console.log('🔒 Starting mitmproxy (forward proxy for HTTPS interception)...');

  mitmProcess = spawn('mitmdump', ['-s', addonPath, '--quiet', '--listen-port', String(MITM_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  mitmProcess.on('error', (err) => {
    console.error('Failed to start mitmproxy:', err.message);
    console.error('Install it: pipx install mitmproxy');
    cleanup(1);
  });

  mitmProcess.on('exit', (code) => {
    if (!mitmReady) {
      console.error('mitmproxy exited unexpectedly');
      cleanup(code || 1);
    }
  });

  // Poll until mitmproxy is accepting connections
  const pollMitm = setInterval(() => {
    const socket = net.connect({ port: MITM_PORT, host: 'localhost' }, () => {
      socket.end();
      if (!mitmReady) {
        mitmReady = true;
        clearInterval(pollMitm);
        console.log(`🔒 mitmproxy listening on port ${MITM_PORT}`);
        startChild();
      }
    });
    socket.on('error', () => {}); // not ready yet
    socket.setTimeout(500, () => socket.destroy());
  }, 200);
}

// Start the child command
function startChild() {
  // Inject extra args (e.g. codex -c chatgpt_base_url=...) before user args
  const allArgs = [...toolConfig.extraArgs, ...commandArguments];
  console.log(`\n🚀 Launching: ${commandName} ${allArgs.join(' ')}\n`);

  const childEnv = {
    ...process.env,
    ...toolConfig.childEnv,
  };

  // Spawn the child process with inherited stdio (interactive)
  // No shell: true — avoids intermediate process that breaks signal delivery
  childProcess = spawn(commandName, allArgs, {
    stdio: 'inherit',
    env: childEnv,
  });

  childProcess.on('error', (err) => {
    console.error(`\nFailed to start ${commandName}:`, err.message);
    cleanup(1);
  });

  // When the child exits (however it happens), clean up and mirror its exit code
  childProcess.on('exit', (code, signal) => {
    cleanup(signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : (code || 0));
  });
}

// Open browser (cross-platform)
function openBrowser(url) {
  const cmd = platform() === 'darwin' ? 'open' 
    : platform() === 'win32' ? 'start' 
    : 'xdg-open';
  
  const browserProcess = spawn(cmd, [url], {
    stdio: 'ignore',
    detached: true,
  });
  
  browserProcess.unref(); // Don't wait for browser to close
}

// Cleanup on exit
function cleanup(exitCode) {
  if (cleanup._didRun) return;
  cleanup._didRun = true;

  const remainingRefs = decrementRefCount();

  if (mitmProcess && !mitmProcess.killed) {
    mitmProcess.kill();
  }

  if (remainingRefs === 0 && shouldShutdownProxy && serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }

  process.exit(exitCode);
}

// Ignore SIGINT in the parent — let it flow to the child (claude/codex) naturally.
// The child handles Ctrl+C itself; when it eventually exits, cleanup runs via the 'exit' handler.
process.on('SIGINT', () => {});

// SIGTERM: external shutdown request — forward to child
process.on('SIGTERM', () => {
  if (childProcess && !childProcess.killed) childProcess.kill('SIGTERM');
});
