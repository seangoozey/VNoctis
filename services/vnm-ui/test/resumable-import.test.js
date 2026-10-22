import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {uploadGameArchive, importRequest} from '../src/utils/resumableImport.js';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const file=text=>new File([text],'game.zip',{lastModified:123});
const fail=(status,code='NETWORK_ERROR')=>Object.assign(new Error('Simulated upload failure'),{status,code});
function fixture(t,options={}){
 t.mock.method(console,'warn',()=>{});
 const records=new Map(),cache=new Map(),calls=[],events=[],diagnostics=[];let user='alice',failureCount=0,queued=0,hashCount=0;
 const storage={getItem:key=>cache.get(key)||null,setItem:(key,value)=>cache.set(key,value),removeItem:key=>cache.delete(key)};
 const identity=()=>({userId:user,token:'do-not-log-this-secret'});
 const request=async(path,opts={})=>{
  calls.push({path,method:opts.method||'GET',bytes:opts.body instanceof Blob?opts.body.size:0});
  if(path.endsWith('/limits')){if(options.oldServer)throw fail(404);return {maxBytes:options.maxBytes||1e9,chunkSize:options.chunkSize||3};}
  const id=path.split('/').at(-1)==='complete'?path.split('/').at(-2):path.split('/').at(-1).split('?')[0];
  if(path.endsWith('/import-uploads')&&(opts.method||'GET')==='GET')return [...records.values()].filter(r=>r.status==='uploading').map(r=>({...r}));
  if(path.endsWith('/import-uploads')&&opts.method==='POST'){const body=JSON.parse(opts.body);const state={...body,jobId:body.uploadId,offset:0,status:'uploading',chunkSize:options.chunkSize||3,expiresAt:new Date(Date.now()+86400000).toISOString()};records.set(body.uploadId,state);return {...state};}
  if(path.includes('/chunk?')){
   const uploadId=path.split('/').at(-2),state=records.get(uploadId),offset=Number(new URL(path,'http://test').searchParams.get('offset'));
   if(opts.body.size>(options.proxyCap||Infinity))throw fail(413);
   if(options.failChunks){failureCount++;throw fail(503);}
   assert.equal(opts.headers['X-Chunk-SHA256'],digest(Buffer.from(await opts.body.arrayBuffer())));
   assert.equal(offset,state.offset);state.offset+=opts.body.size;opts.onProgress?.(opts.body.size);opts.onSent?.();
   if(options.changeUser)user='bob';
   if(options.abort){options.abort.abort();throw options.abort.signal.reason;}
   if(options.loseAck&&!failureCount++){throw fail(0);}
   return {...state};
  }
  const state=records.get(id);if(!state)throw fail(404);
  if(path.endsWith('/complete')){if(state.status==='uploading'){state.status='queued';queued++;}if(options.loseCompletion&&!failureCount++){throw fail(503);}return {...state};}
  return {...state};
 };
 const hasherFactory=()=>({hash:async(blob,progress)=>{hashCount++;progress?.(blob.size);return digest(Buffer.from(await blob.arrayBuffer()));},close(){}});
 const run=(archive,extra={})=>uploadGameArchive(archive,{identity,request,storage,hasherFactory,onProgress:e=>events.push(e),onDiagnostic:e=>diagnostics.push(e),delay:async()=>{},maxRetries:2,...extra});
 return {run,records,cache,calls,events,diagnostics,options,get queued(){return queued},get hashCount(){return hashCount},get failures(){return failureCount}};
}
test('chunks and acknowledgements expose exact progress without a whole-file request',async t=>{
 const f=fixture(t),archive=file('abcdefghij');const result=await f.run(archive);assert.equal(result.status,'queued');assert.equal(f.queued,1);assert.deepEqual(f.calls.filter(c=>c.path.includes('/chunk?')).map(c=>c.bytes),[3,3,3,1]);assert.equal(f.cache.size,0);assert.ok(f.events.some(e=>e.stage==='confirming-chunk'&&e.sentBytes>e.confirmedBytes));assert.equal(f.events.at(-1).confirmedBytes,10);
});
test('lost chunk acknowledgement queries durable offset without resending accepted bytes',async t=>{
 const f=fixture(t,{loseAck:true});await f.run(file('abcdef'));assert.equal(f.queued,1);assert.equal(f.calls.filter(c=>c.path.includes('/chunk?offset=0')).length,1);assert.ok(f.diagnostics.some(e=>e.stage==='chunk'));assert.ok(!JSON.stringify(f.diagnostics).includes('do-not-log-this-secret'));
});
test('lost completion acknowledgement queues one import and retries safely',async t=>{
 const f=fixture(t,{loseCompletion:true});await f.run(file('abcdef'));assert.equal(f.queued,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/complete')).length,2);
});
test('bounded retry exhaustion retains upload identity and a later attempt resumes',async t=>{
 const f=fixture(t,{failChunks:true}),archive=file('abcdef');await assert.rejects(f.run(archive),error=>error.uploadId&&error.confirmedBytes===0);assert.equal(f.failures,3);assert.equal(f.cache.size,1);f.options.failChunks=false;await f.run(archive);assert.equal(f.records.size,1);assert.equal(f.queued,1);
});
test('pause after a committed chunk resumes at the server offset',async t=>{
 const controller=new AbortController(),f=fixture(t,{abort:controller}),archive=file('abcdef');await assert.rejects(f.run(archive,{signal:controller.signal}),{name:'AbortError'});assert.equal([...f.records.values()][0].offset,3);delete f.options.abort;await f.run(archive);assert.equal(f.calls.filter(c=>c.path.includes('/chunk?offset=0')).length,1);assert.equal(f.records.size,1);
});
test('proxy 413 reduces chunk size and continues with bounded requests',async t=>{
 const f=fixture(t,{chunkSize:16*1024*1024,proxyCap:256*1024});await f.run(file(new Uint8Array(600*1024)));assert.equal(f.queued,1);assert.ok(f.diagnostics.some(e=>e.status===413));assert.ok(f.calls.filter(c=>c.path.includes('/chunk?')).some(c=>c.bytes===256*1024));
});
test('account change stops before sending chunks under another account',async t=>{
 const f=fixture(t,{changeUser:true});await assert.rejects(f.run(file('abcdef')),error=>error.code==='ACCOUNT_CHANGED');assert.equal(f.calls.filter(c=>c.path.includes('/chunk?')).length,1);assert.equal(f.queued,0);
});
test('cancelled cached sessions get a new identity rather than reusing a dead upload',async t=>{
 const f=fixture(t,{failChunks:true}),archive=file('abcdef');await assert.rejects(f.run(archive));const original=[...f.records.values()][0];original.status='cancelled';f.options.failChunks=false;await f.run(archive);assert.equal(f.records.size,2);assert.equal(f.queued,1);
});
test('explicit resume refuses a different archive without sending file data',async t=>{
 const f=fixture(t,{failChunks:true});await assert.rejects(f.run(file('abcdef')));const id=[...f.records.keys()][0],before=f.calls.length;f.options.failChunks=false;await assert.rejects(f.run(file('different'),{resumeId:id}),error=>error.code==='UPLOAD_IDENTITY_MISMATCH');assert.equal(f.calls.slice(before).filter(c=>c.path.includes('/chunk?')).length,0);
});
test('server limits and old APIs fail before reading a large local file',async t=>{
 const f=fixture(t,{maxBytes:2});await assert.rejects(f.run(file('abcdef')),error=>error.code==='UPLOAD_TOO_LARGE');assert.equal(f.hashCount,0);const old=fixture(t,{oldServer:true});await assert.rejects(old.run(file('abcdef')),error=>error.code==='SERVER_UPDATE_REQUIRED');assert.equal(old.hashCount,0);
});

test('idle chunk watchdog reports a stall and aborts the stalled request',async t=>{
 const previous=globalThis.XMLHttpRequest;let aborted=false;
 globalThis.XMLHttpRequest=class {constructor(){this.upload={};}open(){}setRequestHeader(){}send(){}abort(){aborted=true;this.onabort?.();}};
 t.after(()=>{if(previous===undefined)delete globalThis.XMLHttpRequest;else globalThis.XMLHttpRequest=previous;});
 await assert.rejects(importRequest('/test',{method:'PUT',body:new Blob(['bytes']),idleMs:1}),error=>error.code==='UPLOAD_STALLED');assert.equal(aborted,true);
});
