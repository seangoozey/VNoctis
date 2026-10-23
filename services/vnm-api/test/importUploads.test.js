import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, readFile, appendFile, access } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import importRoutes from '../src/routes/import.js';
import jobsRoutes from '../src/routes/jobs.js';
import { createJobRunner } from '../src/services/jobRunner.js';
import { createImportUploads } from '../src/services/importUploads.js';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const headers={'x-role':'admin','x-user':'alice'};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'vnm-upload-'));const db=new DatabaseSync(join(root,'test.db'));
 for(const name of readdirSync('prisma/migrations').sort())if(name!=='migration_lock.toml')db.exec(readFileSync(join('prisma/migrations',name,'migration.sql'),'utf8'));
 db.close();const prisma=new PrismaClient({datasources:{db:{url:'file:'+join(root,'test.db').replaceAll('\\','/')}}});
 const app=Fastify();app.decorate('prisma',prisma);app.addHook('onRequest',async request=>{if(request.headers['x-role'])request.user={role:request.headers['x-role'],userId:request.headers['x-user']||'alice'};});
 process.env.GAMES_PATH=join(root,'games');process.env.WEB_BUILDS_PATH=root;await mkdir(process.env.GAMES_PATH);
 const runner=createJobRunner(app,{storage:join(root,'uploads'),logs:root});runner.wake=()=>{};const handlers=new Map(),register=runner.register.bind(runner);runner.register=(kind,handler)=>{handlers.set(kind,handler);register(kind,handler);};app.decorate('jobRunner',runner);
 await app.register(multipart);await app.register(importRoutes,{prefix:'/api/v1'});await app.register(jobsRoutes,{prefix:'/api/v1'});
 t.after(async()=>{await app.close();await runner.stop();await prisma.$disconnect();await rm(root,{recursive:true,force:true});});
 const base='/api/v1/library/import-uploads';const send=(method,url,payload,extra={})=>app.inject({method,url,headers:{...headers,...extra},payload});
 async function create(bytes=Buffer.from('archive bytes'),id=randomUUID()){const input={uploadId:id,name:'game.zip',size:bytes.length,checksum:digest(bytes)};const response=await send('POST',base,input);assert.equal(response.statusCode,201,response.body);return {...response.json(),bytes,input};}
 const chunk=(upload,offset,bytes,extra={})=>send('PUT',`${base}/${upload.uploadId}/chunk?offset=${offset}`,bytes,{'content-type':'application/octet-stream','x-chunk-sha256':digest(bytes),...extra});
 return {root,prisma,app,runner,handlers,base,send,create,chunk};
}
test('upload records precede bytes; creation is idempotent and owner/admin scoped',async t=>{
 const {prisma,app,base,send,create}=await fixture(t);const upload=await create();const job=await prisma.workJob.findUnique({where:{id:upload.uploadId}});assert.equal(job.status,'uploading');assert.equal(job.bytesDone,0n);
 assert.equal((await send('POST',base,upload.input)).json().offset,0);assert.equal(await prisma.workJob.count(),1);
 assert.equal((await app.inject({url:base})).statusCode,401);assert.equal((await send('GET',base,undefined,{'x-role':'viewer'})).statusCode,403);
 assert.equal((await send('GET',`${base}/${upload.uploadId}`,undefined,{'x-user':'bob'})).statusCode,404);assert.equal((await send('POST',base,upload.input,{'x-user':'bob'})).statusCode,404);
 assert.equal((await send('GET','/api/v1/jobs?active=1')).json().items[0].status,'uploading');
 assert.equal((await send('POST',base,{...upload.input,checksum:'0'.repeat(64)})).statusCode,409);
 assert.equal((await send('GET',base)).json().length,1);assert.equal((await send('GET',`${base}/${upload.uploadId}`)).json().input,undefined);
});
test('chunks acknowledge durable offsets, survive lost acknowledgements and discard uncommitted tails',async t=>{
 const {root,app,prisma,runner,base,send,create,chunk}=await fixture(t);const upload=await create(Buffer.from('0123456789'));const first=upload.bytes.subarray(0,4);
 let response=await chunk(upload,0,first);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().offset,4);
 response=await chunk(upload,0,first);assert.equal(response.statusCode,200);assert.equal(response.json().offset,4);
 assert.equal((await chunk(upload,0,Buffer.from('xxxx'))).statusCode,409);assert.equal((await chunk(upload,6,Buffer.from('x'))).statusCode,409);assert.equal((await chunk(upload,4,Buffer.from('x'),{'x-chunk-sha256':'0'.repeat(64)})).statusCode,422);
 assert.equal((await send('POST',`${base}/${upload.uploadId}/complete`)).statusCode,409);
 const archive=join(runner.directory(upload.uploadId),'archive.zip');await appendFile(archive,'unconfirmed crash tail');
 const restarted=createImportUploads(app);assert.equal((await restarted.get(upload.uploadId,'alice')).offset,4);
 response=await chunk(upload,4,upload.bytes.subarray(4));assert.equal(response.statusCode,200,response.body);assert.equal(response.json().offset,10);assert.deepEqual(await readFile(archive),upload.bytes);
 response=await send('POST',`${base}/${upload.uploadId}/complete`);assert.equal(response.statusCode,202,response.body);assert.equal(response.json().status,'queued');
 assert.equal((await send('POST',`${base}/${upload.uploadId}/complete`)).statusCode,202);assert.equal(await prisma.workJob.count(),1);
 const job=await prisma.workJob.findUnique({where:{id:upload.uploadId}});assert.equal(JSON.parse(job.input).uploadPending,false);assert.equal(JSON.parse(job.input).expectedHash,digest(upload.bytes));
 assert.equal((await chunk(upload,0,first)).statusCode,409);assert.deepEqual(await readFile(archive),upload.bytes);
});
test('parallel duplicate chunks cannot append twice; cancellation and expiry protect the queue',async t=>{
 const {prisma,runner,base,send,create,chunk}=await fixture(t);const upload=await create(Buffer.from('abcdefgh'));const results=await Promise.all([chunk(upload,0,upload.bytes.subarray(0,4)),chunk(upload,0,upload.bytes.subarray(0,4))]);assert.ok(results.every(r=>r.statusCode===200));
 assert.equal((await send('GET',`${base}/${upload.uploadId}`)).json().offset,4);
 assert.equal((await send('POST',`/api/v1/jobs/${upload.uploadId}/cancel`)).statusCode,200);await assert.rejects(access(runner.directory(upload.uploadId)));assert.equal((await chunk(upload,4,upload.bytes.subarray(4))).statusCode,409);
 assert.equal((await send('POST',`/api/v1/jobs/${upload.uploadId}/retry`)).statusCode,409);
 const expired=await create();await prisma.importUpload.update({where:{id:expired.uploadId},data:{expiresAt:new Date(0)}});assert.equal((await chunk(expired,0,expired.bytes)).statusCode,410);assert.equal((await prisma.workJob.findUnique({where:{id:expired.uploadId}})).status,'failed');await assert.rejects(access(runner.directory(expired.uploadId)));
});
test('assembled archive verification rejects corruption before any extraction',async t=>{
 const {prisma,runner,handlers,base,send,create,chunk}=await fixture(t);const upload=await create();assert.equal((await chunk(upload,0,upload.bytes)).statusCode,200);await send('POST',`${base}/${upload.uploadId}/complete`);
 const job=await prisma.workJob.findUnique({where:{id:upload.uploadId}}),input=JSON.parse(job.input);input.expectedHash='0'.repeat(64);const stages=[];
 await assert.rejects(handlers.get('import')(job,input,{directory:runner.directory(job.id),signal:new AbortController().signal,log:async()=>{},progress:async data=>stages.push(data.stage)}),/checksum mismatch/);assert.ok(stages.includes('verifying'));assert.ok(!stages.includes('inspecting'));
});


test('pipelined chunks survive out-of-order receipt, restart and lost acknowledgements without a full-file checksum',async t=>{
 const {prisma,app,runner,base,send,chunk}=await fixture(t);const id=randomUUID(),bytes=Buffer.from('0123456789');
 let response=await send('POST',base,{uploadId:id,name:'pipeline.zip',size:bytes.length,protocol:2});assert.equal(response.statusCode,201,response.body);
 const upload={uploadId:id};assert.equal(response.json().protocol,2);assert.equal(response.json().maxInflight,3);
 response=await chunk(upload,4,bytes.subarray(4,8));assert.equal(response.statusCode,200,response.body);assert.equal(response.json().offset,0);assert.equal(response.json().pendingChunks.length,1);
 // Offset is the contiguous durable prefix, never the sparse file's size.
 assert.equal((await send('POST',`${base}/${id}/complete`)).statusCode,409);
 const restarted=createImportUploads(app),state=await restarted.get(id,'alice');assert.equal(state.pendingChunks[0].offset,4);
 response=await chunk(upload,4,bytes.subarray(4,8));assert.equal(response.statusCode,200);assert.equal(response.json().pendingChunks.length,1);
 assert.equal((await chunk(upload,4,Buffer.from('xxxx'))).statusCode,409);assert.equal((await chunk(upload,3,Buffer.from('xxx'))).statusCode,409);
 response=await chunk(upload,0,bytes.subarray(0,4));assert.equal(response.json().offset,8);assert.equal(response.json().pendingChunks.length,0);
 await chunk(upload,8,bytes.subarray(8));assert.deepEqual(await readFile(join(runner.directory(id),'archive.zip')),bytes);
 response=await send('POST',`${base}/${id}/complete`);assert.equal(response.statusCode,202);const job=await prisma.workJob.findUnique({where:{id}});assert.equal(JSON.parse(job.input).expectedHash,undefined);assert.equal(job.stage,'inspecting');
 assert.equal((await send('POST',`${base}/${id}/complete`)).statusCode,202);
});

test('pipeline rejects corrupted chunks and skips unconfirmed crash bytes until they are resent',async t=>{
 const {app,runner,base,send,chunk}=await fixture(t);const id=randomUUID(),bytes=Buffer.from('abcdefgh');
 await send('POST',base,{uploadId:id,name:'game.zip',size:8,protocol:2});const upload={uploadId:id};
 assert.equal((await chunk(upload,0,bytes.subarray(0,4),{'x-chunk-sha256':'0'.repeat(64)})).statusCode,422);
 await appendFile(join(runner.directory(id),'archive.zip'),'uncommitted tail from a crash');
 let response=await chunk(upload,4,bytes.subarray(4));assert.equal(response.json().offset,0);
 response=await chunk(upload,0,bytes.subarray(0,4));assert.equal(response.json().offset,8);
 // Trim any uncommitted tail before handing the completed archive to extraction.
 await send('POST',`${base}/${id}/complete`);assert.deepEqual(await readFile(join(runner.directory(id),'archive.zip')),bytes);
});


test('discarding a pipelined upload removes sparse data and permits a new upload with the same filename',async t=>{
 const {runner,base,send,chunk}=await fixture(t),id=randomUUID();
 await send('POST',base,{uploadId:id,name:'same.zip',size:10,protocol:2});await chunk({uploadId:id},5,Buffer.from('56789'));
 assert.equal((await send('DELETE',`${base}/${id}`)).statusCode,200);await assert.rejects(access(runner.directory(id)));
 const next=randomUUID(),response=await send('POST',base,{uploadId:next,name:'same.zip',size:10,protocol:2});assert.equal(response.statusCode,201,response.body);assert.equal(response.json().offset,0);assert.deepEqual(response.json().pendingChunks,[]);
});
