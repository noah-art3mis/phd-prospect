// What can be checked about the deployment without a VM.
//
// Most of ticket #34's acceptance criteria are properties of a running instance and are
// verified on the box (see docs/deploy.md). These are the ones that can rot silently in the
// repo: a Compose file that publishes a port, an image missing a file the app loads at
// runtime, or a deploy doc that drifts from the commands that exist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = (...parts) => path.join(__dirname, '..', ...parts);
const read = (...parts) => fs.readFileSync(root(...parts), 'utf8');

const compose = read('compose.yaml');
const dockerfile = read('Dockerfile');
const deployDoc = read('docs', 'deploy.md');

test('the container publishes no ports', () => {
  // Long polling means nothing dials in. A published port would be an attack surface with
  // nothing behind it.
  assert.ok(!/^\s*ports:/m.test(compose), 'compose.yaml publishes a port');
  assert.ok(!/^\s*EXPOSE/m.test(dockerfile), 'the Dockerfile exposes a port');
});

test('the container restarts unless deliberately stopped', () => {
  assert.match(compose, /restart:\s*unless-stopped/);
});

test('the database directory is bind-mounted, so it survives the container', () => {
  assert.match(compose, /- \.\/data:\/data/);
  assert.match(compose, /DB_PATH=\/data\//);
});

test('configuration comes from the env file the app validates at boot', () => {
  assert.match(compose, /env_file:\s*\.env/);
});

test('everything the app loads at runtime is copied into the image', () => {
  // The prompt and the seed are read from disk at boot; an image missing either starts and
  // then fails on the first ingest.
  for (const directory of ['src', 'prompts', 'seed', 'tools']) {
    assert.match(dockerfile, new RegExp(`^COPY ${directory} `, 'm'), `${directory}/ is not in the image`);
  }
});

test('the image runs as a non-root user', () => {
  assert.match(dockerfile, /^USER node$/m);
});

test('the image pins a Node version that has node:sqlite', () => {
  // The app uses node:sqlite rather than a native dependency, precisely so there is nothing
  // to compile on a shared-core e2-micro. An older base image would break at require time.
  const [, major] = dockerfile.match(/^FROM node:(\d+)/m);
  assert.ok(Number(major) >= 22, `node:${major} predates node:sqlite`);
  const { engines } = JSON.parse(read('package.json'));
  assert.match(engines.node, />=22/);
});

test('the healthcheck is the same boot check CI runs, not a bespoke second path', () => {
  assert.match(dockerfile, /--check/);
});

test('every command the deploy doc tells you to run exists', () => {
  const { scripts } = JSON.parse(read('package.json'));
  for (const [, name] of deployDoc.matchAll(/npm run ([a-z-]+)/g)) {
    assert.ok(scripts[name], `docs/deploy.md references \`npm run ${name}\`, which is not a script`);
  }
});

test('the deploy doc records the accepted single-project risk rather than leaving it implicit', () => {
  // Primary and backup share a GCP project, so a billing or account problem takes both. The
  // mitigation is that a manual off-box copy is trivial – which only works if it is written
  // down where someone will read it.
  assert.match(deployDoc, /same GCP project/i);
  assert.match(deployDoc, /npm run backup/);
});

test('the deploy doc covers restart-on-failure and restore', () => {
  assert.match(deployDoc, /kill 1/);
  assert.match(deployDoc, /restore/i);
});

test('the build ignores what should never enter the image', () => {
  const dockerignore = read('.dockerignore');
  for (const excluded of ['.env', 'node_modules', 'data', 'notion-snapshot']) {
    assert.match(dockerignore, new RegExp(`^${excluded.replace('.', '\\.')}`, 'm'), `${excluded} is not ignored`);
  }
});
