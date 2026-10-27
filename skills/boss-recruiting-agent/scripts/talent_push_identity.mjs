import path from 'node:path';
import {canonicalJsonSha256} from './candidate_ledger.mjs';

/** Non-secret binding: health must identify this routing configuration. */
export function talentPushConfigId(config,configFile){
  return canonicalJsonSha256({configFile:path.resolve(configFile),host:config.host,port:config.port,workspaceRoot:config.workspaceRoot,workspaceConfigFile:config.workspaceConfigFile,jobId:String(config.jobId),jobProfile:config.jobProfile,chatId:config.chatId,appId:config.appId,botOpenId:config.botOpenId,baseUrl:config.baseUrl,baseToken:config.baseToken,tableId:config.tableId,receiptsDir:config.receiptsDir,runSources:config.runSources,evidenceRoots:config.evidenceRoots});
}
