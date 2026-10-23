import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {archivePath, defaultAppMain, selectWindowsMain, privateDirectory, sameOutputPath} from './platform.mjs';

const executable='C:\\Program Files\\boss-zhipin\\boss-zhipin.exe';
const main={ProcessId:123,ExecutablePath:executable,CommandLine:'"'+executable+'" '};

test('CIM selection excludes renderer/crashpad and matches paths case-insensitively',()=>{
  const rows=[main,{...main,ProcessId:124,CommandLine:main.CommandLine+'--type=renderer'},
    {...main,ProcessId:125,CommandLine:main.CommandLine+'--type=crashpad-handler'},
    {...main,ProcessId:126,CommandLine:main.CommandLine+'"--type=renderer"'},
    {...main,ProcessId:127,CommandLine:main.CommandLine+'"--type"="renderer"'}];
  assert.equal(selectWindowsMain(rows,executable.toUpperCase()).ProcessId,123);
  assert.equal(defaultAppMain('win32',{},rows),executable);
  assert.equal(defaultAppMain('win32',{BOSS_APP_MAIN:executable},[]),executable);
  for(const invalid of [[],[main,main],[{...main,ExecutablePath:null}],[{...main,ProcessId:0}]])
    assert.throws(()=>selectWindowsMain(invalid,executable));
  assert.throws(()=>selectWindowsMain([main],'C:\\Other\\boss-zhipin.exe'));
});

test('archive layout uses Windows resources and preserves Mac layout',()=>{
  assert.equal(archivePath(executable,'win32'),'C:\\Program Files\\boss-zhipin\\resources\\app.asar');
  assert.equal(archivePath('D:\\应用 空格\\boss-zhipin.exe','win32'),'D:\\应用 空格\\resources\\app.asar');
  const mac='/Applications/BOSS直聘.app/Contents/MacOS/BOSS直聘';
  assert.equal(defaultAppMain('darwin',{}),mac);
  assert.equal(archivePath(mac,'darwin'),'/Applications/BOSS直聘.app/Contents/Resources/app.asar');
  assert.throws(()=>archivePath('/unknown','linux'));
});

test('Windows private output rejects an existing inherited directory and supports Unicode paths', {skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'boss-output-'));
  try {
    assert.throws(()=>privateDirectory(root),/inherits permissions/);
    const child=path.join(root,'资料 空格 $()');
    privateDirectory(child);
    privateDirectory(child);
    assert.ok(fs.statSync(child).isDirectory());
    const file=path.join(child,'ordinary-file');fs.writeFileSync(file,'fixture');
    assert.throws(()=>privateDirectory(file),/ordinary directory/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('output path comparison resolves directory aliases and Windows case aliases before any write',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'boss-path-'));
  try {
    const real=path.join(root,'real');fs.mkdirSync(real);
    const alias=path.join(root,'alias');fs.symlinkSync(real,alias,process.platform==='win32'?'junction':'dir');
    assert.equal(sameOutputPath(path.join(real,'new','attempt.json'),path.join(alias,'new','attempt.json')),true);
    assert.equal(sameOutputPath(path.join(real,'attempt.json'),path.join(real,'output.json')),false);
    if(process.platform==='win32') {
      assert.equal(sameOutputPath(path.join(real,'Attempt.json'),path.join(real,'attempt.json')),true);
      for(const name of ['attempt.json.','attempt.json ','attempt.json:stream'])
        assert.throws(()=>sameOutputPath(path.join(real,name),path.join(real,'result.json')),/Ambiguous Windows output path/);
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
