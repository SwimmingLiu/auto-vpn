import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ManagedToolError,
  normalizeManagedToolCommandForSpawn,
  resolveManagedNpmTool
} from '../../dist/runtime/managed-tools.js';

async function makeTempRoot(name) {
  return await mkdir(path.join(os.tmpdir(), `autovpn-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`), {
    recursive: true
  });
}

async function writeExecutable(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '#!/bin/sh\necho 1.2.3\n', 'utf8');
  await chmod(filePath, 0o755);
}

test('resolveManagedNpmTool uses an existing managed install after --version verification', async () => {
  const toolsRoot = await makeTempRoot('managed-tools-existing');
  const projectRoot = await makeTempRoot('managed-tools-project');
  const binaryPath = path.join(toolsRoot, 'npm', 'example-tool', '1.2.3', 'node_modules', '.bin', 'example');
  await writeExecutable(binaryPath);
  const commands = [];

  const resolved = await resolveManagedNpmTool({
    packageName: 'example-tool',
    binaryName: 'example',
    version: '1.2.3',
    toolsRoot,
    projectRoot,
    runCommand: async (command, options) => {
      commands.push({ command, options });
      return { returncode: 0, stdout: 'example 1.2.3\n', stderr: '' };
    }
  });

  assert.deepEqual(resolved, {
    command: binaryPath,
    args: [],
    source: 'managed',
    packageName: 'example-tool',
    version: 'example 1.2.3',
    requestedVersion: '1.2.3'
  });
  assert.deepEqual(commands.map((entry) => entry.command), [[binaryPath, '--version']]);
});

test('resolveManagedNpmTool installs a missing managed tool and verifies it', async () => {
  const toolsRoot = await makeTempRoot('managed-tools-install');
  const projectRoot = await makeTempRoot('managed-tools-project');
  const installDir = path.join(toolsRoot, 'npm', '@scope', 'example-tool', '2.0.0');
  const binaryPath = path.join(installDir, 'node_modules', '.bin', 'example');
  const commands = [];

  const resolved = await resolveManagedNpmTool({
    packageName: '@scope/example-tool',
    binaryName: 'example',
    version: '2.0.0',
    toolsRoot,
    projectRoot,
    installMissing: true,
    runCommand: async (command, options) => {
      commands.push({ command, options });
      if (command[0] === 'npm') {
        await writeExecutable(binaryPath);
        return { returncode: 0, stdout: 'installed\n', stderr: '' };
      }
      return { returncode: 0, stdout: 'example 2.0.0\n', stderr: '' };
    }
  });

  assert.equal(resolved.command, binaryPath);
  assert.equal(resolved.source, 'managed');
  assert.equal(resolved.version, 'example 2.0.0');
  assert.equal(resolved.requestedVersion, '2.0.0');
  assert.deepEqual(commands[0].command, ['npm', 'install', '--no-save', '--no-audit', '--no-fund', '@scope/example-tool@2.0.0']);
  assert.equal(commands[0].options.cwd, installDir);
  assert.equal(commands[0].options.env.NPM_CONFIG_YES, 'true');
  assert.deepEqual(commands[1].command, [binaryPath, '--version']);
});

test('resolveManagedNpmTool falls back to the project binary when allowed', async () => {
  const toolsRoot = await makeTempRoot('managed-tools-fallback');
  const projectRoot = await makeTempRoot('managed-tools-project');
  const projectBinary = path.join(projectRoot, 'node_modules', '.bin', 'example');
  await writeExecutable(projectBinary);

  const resolved = await resolveManagedNpmTool({
    packageName: 'example-tool',
    binaryName: 'example',
    version: '1.0.0',
    toolsRoot,
    projectRoot,
    allowProjectFallback: true,
    runCommand: async () => ({ returncode: 0, stdout: 'example 0.9.0\n', stderr: '' })
  });

  assert.equal(resolved.command, projectBinary);
  assert.equal(resolved.source, 'project');
  assert.equal(resolved.version, 'example 0.9.0');
  assert.equal(resolved.requestedVersion, '1.0.0');
});

test('resolveManagedNpmTool defaults to project fallback before installing', async () => {
  const toolsRoot = await makeTempRoot('managed-tools-default-fallback');
  const projectRoot = await makeTempRoot('managed-tools-project');
  const projectBinary = path.join(projectRoot, 'node_modules', '.bin', 'example');
  const commands = [];
  await writeExecutable(projectBinary);

  const resolved = await resolveManagedNpmTool({
    packageName: 'example-tool',
    binaryName: 'example',
    version: '1.0.0',
    toolsRoot,
    projectRoot,
    runCommand: async (command) => {
      commands.push(command);
      return { returncode: 0, stdout: 'example 1.0.0\n', stderr: '' };
    }
  });

  assert.equal(resolved.command, projectBinary);
  assert.equal(resolved.source, 'project');
  assert.deepEqual(commands, [[projectBinary, '--version']]);
});

test('resolveManagedNpmTool defaults to installing when managed and project binaries are missing', async () => {
  const toolsRoot = await makeTempRoot('managed-tools-default-install');
  const projectRoot = await makeTempRoot('managed-tools-project');
  const installDir = path.join(toolsRoot, 'npm', 'example-tool', '1.0.0');
  const binaryPath = path.join(installDir, 'node_modules', '.bin', 'example');
  const commands = [];

  const resolved = await resolveManagedNpmTool({
    packageName: 'example-tool',
    binaryName: 'example',
    version: '1.0.0',
    toolsRoot,
    projectRoot,
    runCommand: async (command, options) => {
      commands.push({ command, options });
      if (command[0] === 'npm') {
        await writeExecutable(binaryPath);
        return { returncode: 0, stdout: 'installed\n', stderr: '' };
      }
      return { returncode: 0, stdout: 'example 1.0.0\n', stderr: '' };
    }
  });

  assert.equal(resolved.command, binaryPath);
  assert.equal(resolved.source, 'managed');
  assert.deepEqual(commands[0].command, ['npm', 'install', '--no-save', '--no-audit', '--no-fund', 'example-tool@1.0.0']);
});

test('resolveManagedNpmTool times out default spawned commands', async () => {
  const toolsRoot = await makeTempRoot('managed-tools-timeout');
  const projectRoot = await makeTempRoot('managed-tools-project');
  const projectBinary = path.join(projectRoot, 'node_modules', '.bin', 'example');
  await mkdir(path.dirname(projectBinary), { recursive: true });
  await writeFile(projectBinary, '#!/bin/sh\nsleep 5\n', 'utf8');
  await chmod(projectBinary, 0o755);

  await assert.rejects(
    resolveManagedNpmTool({
      packageName: 'example-tool',
      binaryName: 'example',
      version: '1.0.0',
      toolsRoot,
      projectRoot,
      timeoutMs: 20
    }),
    (error) => {
      assert.ok(error instanceof ManagedToolError);
      assert.equal(error.code, 'MANAGED_TOOL_VERSION_FAILED');
      assert.match(error.message, /timed out/i);
      return true;
    }
  );
});

test('resolveManagedNpmTool rejects unsafe package, version, and binary path inputs', async () => {
  const toolsRoot = await makeTempRoot('managed-tools-unsafe');
  const projectRoot = await makeTempRoot('managed-tools-project');
  const unsafeOptions = [
    { packageName: '../pkg', binaryName: 'example', version: '1.0.0' },
    { packageName: '/pkg', binaryName: 'example', version: '1.0.0' },
    { packageName: '@scope/pkg/extra', binaryName: 'example', version: '1.0.0' },
    { packageName: 'example-tool', binaryName: '../example', version: '1.0.0' },
    { packageName: 'example-tool', binaryName: 'nested/example', version: '1.0.0' },
    { packageName: 'example-tool', binaryName: 'example', version: '../1.0.0' },
    { packageName: 'example-tool', binaryName: 'example', version: '1/0/0' }
  ];

  for (const candidate of unsafeOptions) {
    await assert.rejects(
      resolveManagedNpmTool({
        ...candidate,
        toolsRoot,
        projectRoot,
        runCommand: async () => ({ returncode: 0, stdout: '', stderr: '' })
      }),
      (error) => {
        assert.ok(error instanceof ManagedToolError);
        assert.equal(error.code, 'MANAGED_TOOL_INVALID_OPTIONS');
        return true;
      }
    );
  }
});

test('resolveManagedNpmTool supports Windows .cmd shims', async () => {
  const toolsRoot = await makeTempRoot('managed-tools-cmd');
  const projectRoot = await makeTempRoot('managed-tools-project');
  const binaryPath = path.join(toolsRoot, 'npm', 'example-tool', '1.0.0', 'node_modules', '.bin', 'example.cmd');
  const commands = [];
  await writeExecutable(binaryPath);

  const resolved = await resolveManagedNpmTool({
    packageName: 'example-tool',
    binaryName: 'example',
    version: '1.0.0',
    toolsRoot,
    projectRoot,
    platform: 'win32',
    runCommand: async (command) => {
      commands.push(command);
      return { returncode: 0, stdout: 'example 1.0.0\n', stderr: '' };
    }
  });

  assert.equal(resolved.command, binaryPath);
  assert.equal(resolved.source, 'managed');
  assert.deepEqual(commands, [[binaryPath, '--version']]);
});

test('normalizeManagedToolCommandForSpawn runs Windows cmd and bat shims through cmd.exe', () => {
  const cmdCommand = normalizeManagedToolCommandForSpawn(['C:\\Tools\\example.cmd', '--out', 'C:\\work dir\\bundle & more'], 'win32');
  const batCommand = normalizeManagedToolCommandForSpawn(['C:\\Tools\\example.bat', '--name', 'a&b'], 'win32');

  assert.equal(cmdCommand.executable, 'cmd.exe');
  assert.deepEqual(cmdCommand.args, ['/d', '/s', '/c', '"C:\\Tools\\example.cmd" "--out" "C:\\work dir\\bundle ^& more"']);
  assert.equal(batCommand.executable, 'cmd.exe');
  assert.deepEqual(batCommand.args, ['/d', '/s', '/c', '"C:\\Tools\\example.bat" "--name" "a^&b"']);
});

test('normalizeManagedToolCommandForSpawn leaves non-Windows commands unchanged', () => {
  const command = normalizeManagedToolCommandForSpawn(['/tools/example.cmd', '--version'], 'linux');

  assert.equal(command.executable, '/tools/example.cmd');
  assert.deepEqual(command.args, ['--version']);
});

test('resolveManagedNpmTool throws a safe truncated error when install fails', async () => {
  const toolsRoot = await makeTempRoot('managed-tools-failure');
  const projectRoot = await makeTempRoot('managed-tools-project');
  const longError = `failure ${'x'.repeat(2000)}`;

  await assert.rejects(
    resolveManagedNpmTool({
      packageName: 'example-tool',
      binaryName: 'example',
      version: '3.0.0',
      toolsRoot,
      projectRoot,
      installMissing: true,
      runCommand: async () => ({ returncode: 1, stdout: '', stderr: longError })
    }),
    (error) => {
      assert.ok(error instanceof ManagedToolError);
      assert.match(error.message, /npm install failed/);
      assert.ok(error.message.length < 900);
      assert.ok(!error.message.includes('x'.repeat(1000)));
      return true;
    }
  );
});
