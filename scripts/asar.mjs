#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {privateDirectory} from './platform.mjs';

const [archive, operation = 'inventory', member, destination] = process.argv.slice(2);
if (!archive || !['inventory', 'extract'].includes(operation)) {
  throw new Error('Usage: asar.mjs <app.asar> inventory | extract <exact/member> <new-file>');
}
const fd = fs.openSync(archive, 'r');
try {
  const prefix = Buffer.alloc(16);
  if (fs.readSync(fd, prefix, 0, 16, 0) !== 16 || prefix.readUInt32LE(0) !== 4) throw new Error('Unsupported ASAR header');
  const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
  if (jsonSize > 64 * 1024 * 1024 || jsonSize > headerSize - 8) throw new Error('Invalid ASAR header size');
  const bytes = Buffer.alloc(jsonSize);
  if (fs.readSync(fd, bytes, 0, jsonSize, 16) !== jsonSize) throw new Error('Truncated ASAR header');
  const header = JSON.parse(bytes.toString('utf8')), entries = [];
  function walk(files, parent = '') {
    for (const [name, item] of Object.entries(files)) {
      const nameInArchive = parent ? parent + '/' + name : name;
      if (item.files) walk(item.files, nameInArchive);
      else entries.push({path: nameInArchive, size: item.size ?? null, unpacked: Boolean(item.unpacked), link: item.link ?? null, offset: item.offset ?? null, encryption: item.encryption ?? null, encryptedSize: item.encryptedSize ?? null, declaredSha256: item.integrity?.hash ?? null});
    }
  }
  walk(header.files);
  if (operation === 'inventory') {
    console.log(JSON.stringify({archive: path.resolve(archive), bytes: fs.fstatSync(fd).size,
      headerSha256: crypto.createHash('sha256').update(bytes).digest('hex'), count: entries.length, entries}, null, 2));
  } else {
    if (!member || !destination || path.posix.isAbsolute(member) || member.split('/').includes('..')) throw new Error('Exact safe member and new output file required');
    const entry = entries.find(item => item.path === member);
    if (!entry || entry.link) throw new Error('Member missing or symlink; choose an ordinary file');
    if (entry.encryption) throw new Error('Encrypted member: use boss.mjs extract in the installed Electron runtime; raw bytes are not plaintext');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * 1024 * 1024) throw new Error('Member exceeds 64 MiB extraction bound');
    let data;
    if (entry.unpacked) {
      const companion = fs.lstatSync(archive + '.unpacked');
      if (!companion.isDirectory() || companion.isSymbolicLink()) throw new Error('ASAR companion must be an ordinary directory, not a junction or symlink');
      const root = fs.realpathSync(archive + '.unpacked');
      const src = fs.realpathSync(path.join(root, member));
      const relative = path.relative(root, src);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Unpacked member outside archive companion directory');
      data = fs.readFileSync(src);
    } else {
      const offset = Number(entry.offset) + 8 + headerSize;
      if (!Number.isSafeInteger(offset) || offset < 8 + headerSize || offset + entry.size > fs.fstatSync(fd).size) throw new Error('Invalid member range');
      data = Buffer.alloc(entry.size);
      if (fs.readSync(fd, data, 0, entry.size, offset) !== entry.size) throw new Error('Truncated member');
    }
    if (data.length !== entry.size) throw new Error('Member size mismatch');
    if (entry.declaredSha256 && crypto.createHash('sha256').update(data).digest('hex') !== entry.declaredSha256) throw new Error('Declared plaintext integrity mismatch; no output written');
    privateDirectory(path.dirname(path.resolve(destination)));
    fs.writeFileSync(destination, data, {flag: 'wx', mode: 0o600});
    console.log(JSON.stringify({member, output: path.resolve(destination), bytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'), executed: false}));
  }
} finally { fs.closeSync(fd); }
