#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash} from './runtime.mjs';
import {privateDirectory} from './platform.mjs';
import {validateProposal} from '../skills/boss-recruiting-agent/scripts/proposal_validation.mjs';

export function validateProposalFiles({packetFile, proposalFile, recordFile, jobFile}) {
  const bytes = Object.fromEntries(Object.entries({packetFile, proposalFile, recordFile, jobFile}).map(([key, file]) => [key, fs.readFileSync(file)]));
  const parse = key => JSON.parse(bytes[key].toString('utf8'));
  const result = validateProposal({packet: parse('packetFile'), proposal: parse('proposalFile'), currentRecord: parse('recordFile'),
    jobProfile: parse('jobFile'), jobProfileBytes: bytes.jobFile});
  return {...result, inputFileSha256: Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, hash(value)])),
    mainApprovalRequired: true, SDKInvoked: false, formalRecordWritten: false};
}
function main() {
  const [mode, packetFile, proposalFile, recordFile, jobFile, output] = process.argv.slice(2);
  if (mode !== 'validate' || !output) throw new Error('Usage: recruiting-proposal.mjs validate <packet> <proposal> <current-record> <job-profile> <new-output>');
  if ([packetFile, proposalFile, recordFile, jobFile].some(file => path.resolve(file) === path.resolve(output)) || fs.existsSync(output)) throw new Error('Validation output must be a separate new file');
  const result = validateProposalFiles({packetFile, proposalFile, recordFile, jobFile});
  privateDirectory(path.dirname(path.resolve(output)));
  fs.writeFileSync(output, JSON.stringify(result, null, 2), {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({valid: result.valid, errorCodes: result.errors.map(x => x.code), warningCodes: result.warnings.map(x => x.code), mainApprovalRequired: true}));
  if (!result.valid) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {main();} catch (error) {console.error(JSON.stringify({ok: false, stage: 'proposal_validation', error: error.name})); process.exitCode = 1;}
}
