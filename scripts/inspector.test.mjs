import test from 'node:test';
import assert from 'node:assert/strict';
import {targets} from './runtime.mjs';

test('Inspector discovery retries a reset read once, then requires a real discovery result',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async(_url,options)=>{
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.connection,'close');
    if(++calls===1)throw new TypeError('fixture reset',{cause:{code:'ECONNRESET'}});
    return {ok:true,json:async()=>[{type:'node',id:'offline-fixture'}]};
  };
  try {assert.equal((await targets())[0].id,'offline-fixture');assert.equal(calls,2);}
  finally {globalThis.fetch=original;}
});

test('Inspector discovery does not interpret a repeated reset or timeout as an absent server',async()=>{
  const original=globalThis.fetch;
  try {
    for(const code of ['ECONNRESET','UND_ERR_SOCKET','ETIMEDOUT']) {
      let calls=0;
      globalThis.fetch=async()=>{calls++;throw new TypeError('fixture transport failure',{cause:{code}});};
      await assert.rejects(targets(),/fixture transport failure/);
      assert.equal(calls,code==='ETIMEDOUT'?1:2);
    }
  } finally {globalThis.fetch=original;}
});

test('Inspector discovery rejects HTTP/schema failures and only refusal means no listener',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>({ok:false,status:403});
    await assert.rejects(targets(),/Inspector HTTP 403/);
    globalThis.fetch=async()=>({ok:true,json:async()=>({not:'targets'})});
    await assert.rejects(targets(),/Unexpected Inspector discovery body/);
    globalThis.fetch=async()=>{throw new TypeError('fixture refusal',{cause:{code:'ECONNREFUSED'}});};
    assert.deepEqual(await targets(),[]);
  } finally {globalThis.fetch=original;}
});
