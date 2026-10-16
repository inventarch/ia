// Test preload for qualify-sdk.test.ts, which runs `node --import <this> tools/runtime/qualify-sdk.mjs ...` offline.
// The JSON fixture IA_QUALIFY_FIXTURE names supplies the release rows, so the script's release, receipt and language
// manifest readers, which need a prepared candidate, resolve to stubs; the archive reading under test is unchanged.
// Every buffer the script hands to tar is recorded in the fixture's log. With `race`, the selected archive at
// `race.path` is changed once at a named moment: `open` just before the script opens it by descriptor, `read` at the
// first read through that descriptor, and `tar` when its checked bytes are handed to tar. Built-in functions are
// replaced on their module objects and published to the script's ES imports with syncBuiltinESMExports.
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const fixture = JSON.parse(fs.readFileSync(process.env.IA_QUALIFY_FIXTURE ?? '', 'utf8'));
const source = (text) => `data:text/javascript,${encodeURIComponent(text)}`;
const stubs = {
  '../release/public-pack.mjs': source(
    `export const publicPackageInputs = () => (${JSON.stringify({ sha256: 'fixture', receipt: { source: 'fixture' } })});`,
  ),
  '../distribution/npm-release.mjs': source(
    `export const verifyRelease = () => (${JSON.stringify({ packages: fixture.packages })});`,
  ),
  '../native/public-systems.mjs': source('export const publicSystemNames = () => [];'),
};
registerHooks({
  resolve: (specifier, context, next) =>
    context.parentURL?.endsWith('/tools/runtime/qualify-sdk.mjs') && Object.hasOwn(stubs, specifier)
      ? { url: stubs[specifier], shortCircuit: true }
      : next(specifier, context),
});

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const { openSync, readSync } = fs,
  { execFileSync } = childProcess;
const race = fixture.race;
const changes = {
  // Another archive copied over the name.
  replace: () => fs.copyFileSync(race.replacement, race.path),
  // A symbolic link at the name, to the archive moved aside.
  link: () => {
    fs.renameSync(race.path, `${race.path}.moved`);
    fs.symlinkSync(`${race.path}.moved`, race.path);
  },
  // A FIFO at the name, with no writer.
  fifo: () => {
    fs.rmSync(race.path);
    execFileSync('mkfifo', [race.path]);
  },
  grow: () => fs.appendFileSync(race.path, Buffer.from([0])),
  shrink: () => fs.truncateSync(race.path, fs.statSync(race.path).size - 1),
  // Other bytes at the same size, with an older modification time.
  rewrite: () => {
    const bytes = fs.readFileSync(race.path);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(race.path, bytes);
    fs.utimesSync(race.path, new Date(2000, 0, 1), new Date(2000, 0, 1));
  },
  // The same bytes under a new identity: a copy renamed over the name.
  identity: () => {
    fs.copyFileSync(race.path, `${race.path}.copy`);
    fs.renameSync(`${race.path}.copy`, race.path);
  },
};
let raced = false;
const change = (at) => {
  if (race?.at === at && !raced) {
    raced = true;
    changes[race.change]();
  }
};
const descriptors = new Set();
fs.openSync = function (path, flags, ...rest) {
  // The script opens a selected archive with numeric flags; its earlier reads by name pass a string.
  const selected = race !== undefined && typeof flags === 'number' && basename(String(path)) === basename(race.path);
  if (selected) change('open');
  const descriptor = Reflect.apply(openSync, fs, [path, flags, ...rest]);
  if (selected) descriptors.add(descriptor);
  return descriptor;
};
fs.readSync = function (descriptor, ...rest) {
  if (descriptors.has(descriptor)) change('read');
  return Reflect.apply(readSync, fs, [descriptor, ...rest]);
};
childProcess.execFileSync = function (file, args, options) {
  if (file === 'tar') {
    const input = Buffer.from(options.input);
    fs.appendFileSync(fixture.log, `${JSON.stringify({ args, sha256: digest(input), bytes: input.length })}\n`);
    if (race?.at === 'tar' && digest(input) === digest(fs.readFileSync(race.path))) change('tar');
  }
  return Reflect.apply(execFileSync, this, [file, args, options]);
};
syncBuiltinESMExports();
