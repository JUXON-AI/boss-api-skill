import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {SCORING_POLICY_VERSION} from '../../../scripts/scoring.mjs';
import {validateCandidateRecord, verifyLedger} from './candidate_ledger.mjs';

const script = fileURLToPath(new URL('./candidate_ledger.mjs', import.meta.url));
const jobSha='a'.repeat(64), historySha='b'.repeat(64), evaluationSha='c'.repeat(64);
function record(overrides={}) {
  const base={schema_version:1,policy_version:SCORING_POLICY_VERSION,job:{boss_job_id:'job-1',job_profile_sha256:jobSha},candidate:{uid:101,name:'Candidate A'},history:{sha256:historySha,complete:true,checked_at:'2026-10-24T03:00:00.000Z',last_mid:10,last_direction:'out'},job_fit:{score:85,hard_condition_status:'pass'},score:{dimensions:{core_role_skills:80,project_depth:80,engineering_habits:80,learning_and_collaboration:80},ability_base_score:80,evidence_coverage_percent:100,competitions:[],github_projects:[],competition_bonus:0,github_bonus:0,proof_bonus:0,final_signal_score:80,evaluation_sha256:evaluationSha},state:'ready_for_contact',facts:{confirmed:['Identity matched'],unverified:[],unknown:[]},communication:{round:0,last_outbound_mid:null,last_outbound_at:null,pending_inbound_mids:[]},recommendation:'continue_contact',next_round:1,next_action:'Send the reviewed first-round message',sources:['private-fixture'],updated_at:'2026-10-24T03:01:00.000Z'};
  return {...base,...overrides};
}
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'boss-ledger-test-'));}
function write(root,r){const file=path.join(root,r.job.boss_job_id,`${r.candidate.uid}.json`);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(r,null,2));return file;}

test('validated record directory is addressable by job and uid only',()=>{
  const root=tmp();write(root,record());
  const rows=verifyLedger(root);
  assert.equal(rows.length,1);assert.equal(rows[0].record.candidate.uid,101);assert.match(rows[0].recordSha256,/^[a-f0-9]{64}$/);
});

test('deterministic score mismatch and unknown-base policy fail closed',()=>{
  assert.throws(()=>validateCandidateRecord(record({score:{...record().score,final_signal_score:99}})),/does not match deterministic recomputation/);
  const unknown=record({score:{dimensions:{core_role_skills:null,project_depth:null,engineering_habits:null,learning_and_collaboration:null},ability_base_score:null,evidence_coverage_percent:0,competitions:[],github_projects:[],competition_bonus:0,github_bonus:0,proof_bonus:0,final_signal_score:null,evaluation_sha256:evaluationSha},state:'needs_more_info'});
  assert.throws(()=>validateCandidateRecord(unknown),/unknown ability base must be skipped/);
});

test('inbound pending state must bind at least one exact message id',()=>{
  const bad=record({history:{...record().history,last_mid:11,last_direction:'in'},communication:{round:1,last_outbound_mid:10,last_outbound_at:'2026-10-24T03:00:00.000Z',pending_inbound_mids:[]}});
  assert.throws(()=>validateCandidateRecord(bad),/requires at least one pending inbound mid or no_reply_required/);
});

test('source-bound no-reply acknowledgement needs no fabricated pending mid',()=>{
  const good=record({
    history:{...record().history,last_mid:11,last_direction:'in'},
    communication:({round:1,last_outbound_mid:10,last_outbound_at:'2026-10-24T03:00:00.000Z',pending_inbound_mids:[],no_reply_required:{mid:11,reason:'Candidate acknowledgement requires no reply',source:'private-fixture'}})
  });
  assert.equal(validateCandidateRecord(good).record.communication.no_reply_required.mid,11);
});

test('no-reply evidence must bind the exact last mid and a listed nonempty source',()=>{
  const base=record({
    history:{...record().history,last_mid:11,last_direction:'in'},
    communication:({round:1,last_outbound_mid:10,last_outbound_at:'2026-10-24T03:00:00.000Z',pending_inbound_mids:[],no_reply_required:{mid:11,reason:'Candidate acknowledgement requires no reply',source:'private-fixture'}})
  });
  assert.throws(()=>validateCandidateRecord({...base,communication:{...base.communication,no_reply_required:{...base.communication.no_reply_required,mid:12}}}),/must exactly match history.last_mid/);
  assert.throws(()=>validateCandidateRecord({...base,communication:{...base.communication,no_reply_required:{mid:11,source:'private-fixture'}}}),/reason is required/);
  assert.throws(()=>validateCandidateRecord({...base,communication:{...base.communication,no_reply_required:{...base.communication.no_reply_required,source:'unlisted-source'}}}),/source must reference record.sources/);
});

test('no-reply evidence cannot coexist with pending ids or a non-inbound last direction',()=>{
  const base=record({
    history:{...record().history,last_mid:11,last_direction:'in'},
    communication:({round:1,last_outbound_mid:10,last_outbound_at:'2026-10-24T03:00:00.000Z',pending_inbound_mids:[],no_reply_required:{mid:11,reason:'Candidate acknowledgement requires no reply',source:'private-fixture'}})
  });
  assert.throws(()=>validateCandidateRecord({...base,communication:{...base.communication,pending_inbound_mids:[11]}}),/cannot coexist with pending inbound mids/);
  assert.throws(()=>validateCandidateRecord({...base,history:{...base.history,last_direction:'out'}}),/requires history.last_direction=in/);
});

test('changed job profile is rejected before an upsert',()=>{
  const root=tmp();const r=record();const recordDir=tmp();const recordFile=path.join(recordDir,'record.json');fs.writeFileSync(recordFile,JSON.stringify(r));
  const profileFile=path.join(tmp(),'job.json');fs.writeFileSync(profileFile,'{}');
  const out=spawnSync(process.execPath,[script,'upsert','--dir',root,'--record',recordFile,'--job-profile',profileFile],{encoding:'utf8'});
  assert.notEqual(out.status,0);assert.match(out.stderr,/job profile SHA-256 changed/);
});

test('CLI rejects stale overwrite and indexes candidates deterministically',()=>{
  const root=tmp();const first=record();const file=write(root,first);
  const out=spawnSync(process.execPath,[script,'verify','--dir',root],{encoding:'utf8'});
  assert.equal(out.status,0,out.stderr||out.stdout);
  const second=record({state:'awaiting_candidate_reply',updated_at:'2026-10-24T03:02:00.000Z'});
  const secondDir=tmp();const secondFile=path.join(secondDir,'second.json');fs.writeFileSync(secondFile,JSON.stringify(second));
  const stale=spawnSync(process.execPath,[script,'upsert','--dir',root,'--record',secondFile],{encoding:'utf8'});
  assert.notEqual(stale.status,0);assert.match(stale.stderr,/expected-sha256/);
  const show=spawnSync(process.execPath,[script,'show','--dir',root,'--job-id','job-1','--uid','101'],{encoding:'utf8'});
  const sha=JSON.parse(show.stdout).recordSha256;
  const update=spawnSync(process.execPath,[script,'upsert','--dir',root,'--record',secondFile,'--expected-sha256',sha],{encoding:'utf8'});
  assert.equal(update.status,0,update.stderr||update.stdout);
  const indexFile=path.join(root,'index.json');const index=spawnSync(process.execPath,[script,'index','--dir',root,'--output',indexFile],{encoding:'utf8'});
  assert.equal(index.status,0,index.stderr||index.stdout);
  const parsed=JSON.parse(fs.readFileSync(indexFile,'utf8'));
  assert.equal(parsed.records[0].candidate_uid,101);assert.equal(parsed.records[0].state,'awaiting_candidate_reply');
  assert.ok(fs.existsSync(file));
});