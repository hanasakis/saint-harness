import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const app = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = app.version;
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw Error('Invalid application version');
const tag = `v${version}`, repo = 'hanasakis/saint-harness', packageName = '@hanasakis/saint-harness';
const asset = `Saint-Harness-${version}-x64.zip`, archive = path.resolve('release/publish', asset);
const packageDir = path.resolve('release/github-package'), distributionDir = path.resolve('release/distributions');
const tarball = path.join(distributionDir, `hanasakis-saint-harness-${version}.tgz`);
const notes = `docs/releases/${tag}.md`;
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
function npm(args, cwd = process.cwd()) {
  // On Windows npm.cmd is a shell wrapper. All arguments below are our fixed
  // commands, validated versions or repository-owned relative paths.
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) throw Error(result.stderr || result.stdout || 'npm failed');
  return result.stdout.trim();
}
function release() {
  try { return JSON.parse(gh('api', `repos/${repo}/releases/tags/${tag}`)); }
  catch (error) { if (String(error.stderr).includes('HTTP 404')) return; throw error; }
}
function inspect() {
  const existing = release();
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== tag) throw Error('Git tag must match package.json version');
  if (!existing?.draft && existing) {
    console.log(`${tag} is already published; versions are not overwritten.`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish=false\nversion=${version}\n`);
    return;
  }
  if (!fs.existsSync(notes)) throw Error(`Write release notes in ${notes} before publishing`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish=true\nversion=${version}\n`);
  console.log(`Will build, test and publish ${tag}`);
}
function prepare() {
  if (!fs.statSync(archive).isFile()) throw Error('Build the Windows zip first');
  fs.mkdirSync(packageDir, { recursive: true }); fs.mkdirSync(distributionDir, { recursive: true });
  fs.copyFileSync(archive, path.join(packageDir, asset));
  fs.copyFileSync('THIRD_PARTY_NOTICES.md', path.join(packageDir, 'THIRD_PARTY_NOTICES.md'));
  const manifest = { name: packageName, version, description: 'Saint Harness Windows x64 desktop distribution, with Electron and Pi included', license: app.license, author: app.author,
    repository: { type: 'git', url: `https://github.com/${repo}.git` }, homepage: `https://github.com/${repo}/releases/tag/${tag}`,
    files: [asset, 'README.md', 'THIRD_PARTY_NOTICES.md'], publishConfig: { registry: 'https://npm.pkg.github.com' } };
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(packageDir, 'README.md'), `# Saint Harness ${version}\n\nWindows x64 desktop application with Electron, Node and Pi included.\n\nThis distribution contains **${asset}**, the same portable application provided in [GitHub Releases](https://github.com/${repo}/releases/tag/${tag}). Extract that zip into a writable folder and launch **Saint Harness.exe**. Keep all extracted files together. No npm lifecycle script is run and no system settings are changed by this package.\n\nFor the simplest download, use Releases; it requires no GitHub token or Node.js installation. GitHub's npm registry requires authentication even for public packages.\n\nUser settings and conversations live separately in %APPDATA%/Saint Harness. When updating, close Saint Harness, back up the old application directory, then extract the new zip. Do not delete your application data directory.\n\nSupported platform: Windows 10/11 x64. This is an unsigned development build. See the included third-party notices and the Release's validation notes.\n`);
  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', '../distributions'], packageDir))[0];
  if (packed.filename !== path.basename(tarball)) throw Error('Unexpected npm distribution filename');
  if (fs.statSync(tarball).size >= 256 * 1024 * 1024) throw Error('GitHub npm packages must be smaller than 256 MB');
  console.log(JSON.stringify({ version, archive, tarball, files: packed.files.map(f => f.path), bytes: packed.size }, null, 2));
}
async function publish() {
  if (!process.env.NODE_AUTH_TOKEN || !process.env.GH_TOKEN) throw Error('Run publishing in GitHub Actions with package and repository permissions');
  if (!fs.existsSync(tarball) || !fs.existsSync(notes)) throw Error('Prepare and validate the distribution first');
  let current = release();
  if (current && !current.draft) throw Error('This release is already public; publish a new version instead');
  const commit = process.env.GITHUB_SHA || gh('api', `repos/${repo}/commits/main`, '--jq', '.sha');
  if (current && current.target_commitish !== commit) throw Error('The draft belongs to a different commit; inspect it before retrying');
  if (!current) {
    gh('release', 'create', tag, '--repo', repo, '--target', commit, '--title', `Saint Harness ${version}`, '--notes-file', notes, '--draft');
    current = release();
  }
  // An interrupted upload can be retried while the Release is still a draft.
  gh('release', 'upload', tag, archive, tarball, '--repo', repo, '--clobber');
  const response = await fetch(`https://npm.pkg.github.com/${packageName.replace('/', '%2f')}`, { headers: { Authorization: `Bearer ${process.env.NODE_AUTH_TOKEN}` } });
  if (!response.ok && response.status !== 404) throw Error(`Cannot inspect package registry: HTTP ${response.status}`);
  const metadata = response.ok ? await response.json() : {};
  if (!metadata.versions?.[version]) console.log(npm(['publish', path.relative(process.cwd(), tarball), '--registry=https://npm.pkg.github.com', '--access=public', ...(version.includes('-') ? ['--tag=next'] : [])]));
  else console.log(`Package ${packageName}@${version} already exists; finishing its draft Release.`);
  // npm visibility and GitHub package-page visibility can differ; package access
  // is checked after the first publication and documented in the release guide.
  const verified = JSON.parse(npm(['view', `${packageName}@${version}`, 'version', '--registry=https://npm.pkg.github.com', '--json']));
  if (verified !== version) throw Error('Published package version could not be verified');
  gh('release', 'edit', tag, '--repo', repo, '--draft=false', `--prerelease=${version.includes('-')}`, ...(version.includes('-') ? [] : ['--latest']));
  console.log(`Published https://github.com/${repo}/releases/tag/${tag}`);
}
const action = process.argv[2];
if (action === 'inspect') inspect();
else if (action === 'prepare') prepare();
else if (action === 'publish') await publish();
else throw Error('Usage: node scripts/release.mjs inspect|prepare|publish');
