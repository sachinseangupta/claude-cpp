// Launches a real VS Code (the installed app, with a throwaway profile) and runs suite.js inside it.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');

// If we were started from inside VS Code (e.g. its terminal), don't leak its Electron/VS Code env into the test instance.
delete process.env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(process.env)) if (k.startsWith('VSCODE_')) delete process.env[k];

(async () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cpp-ws-'))); // canonical: macOS /var -> /private/var
  fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n');
  fs.mkdirSync(path.join(workspace, 'src'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cpp-profile-'));
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.resolve(__dirname, 'suite.js'),
      extensionTestsEnv: { CLAUDE_CPP_WORKSPACE: workspace },
      launchArgs: [workspace, '--user-data-dir', path.join(profile, 'data'), '--extensions-dir', path.join(profile, 'ext'), '--disable-extensions'],
    });
  } catch (e) {
    console.error('Integration tests failed:', e);
    process.exit(1);
  }
})();
