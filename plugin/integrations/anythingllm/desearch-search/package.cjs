const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desearch-skill-'));
try {
  const destination = path.join(temp, 'desearch-search');
  fs.mkdirSync(destination);
  for (const file of ['handler.js', 'plugin.json', 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) {
    fs.copyFileSync(path.join(__dirname, file), path.join(destination, file));
  }
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: destination, stdio: 'inherit' });
  const archive = path.join(__dirname, 'desearch-search.tgz');
  execFileSync('tar', ['-czf', archive, '-C', temp, 'desearch-search']);
  console.log(archive);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
