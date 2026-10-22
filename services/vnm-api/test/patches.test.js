import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import patchRoutes from '../src/routes/patches.js';
import buildRoutes from '../src/routes/build.js';
import internalRoutes from '../src/routes/internal.js';
import { mapPackage, packageRoots } from '../src/services/patches.js';
const gameId='a'.repeat(32), admin={'x-role':'admin'};
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'vnm-patch-')), db=new DatabaseSync(join(root,'test.db'));
 for(const name of readdirSync('prisma/migrations').sort()) if(name!=='migration_lock.toml') db.exec(readFileSync(join('prisma/migrations',name,'migration.sql'),'utf8'));
 db.exec('ALTER TABLE Game ADD COLUMN publishStatus TEXT NOT NULL DEFAULT "not_published"; ALTER TABLE Game ADD COLUMN publishedAt DATETIME; ALTER TABLE Game ADD COLUMN publishedVersion TEXT;');db.close();
 const prisma=new PrismaClient({datasources:{db:{url:`file:${join(root,'test.db').replaceAll('\\','/')}`}}});
 process.env.WEB_BUILDS_PATH=root;
 const app=Fastify();app.decorate('prisma',prisma);app.decorate('jobRunner',{log:async()=>{},wake:()=>{}});
 app.addHook('onRequest',async request=>{request.user={role:request.headers['x-role']||'viewer'};});
 await app.register(multipart);await app.register(patchRoutes,{prefix:'/api/v1'});await app.register(buildRoutes,{prefix:'/api/v1'});await app.register(internalRoutes,{prefix:'/api/v1'});
 await mkdir(join(root,'source/game'),{recursive:true});await writeFile(join(root,'source/game/script.rpy'),'original');
 await prisma.game.create({data:{id:gameId,directoryPath:join(root,'source'),directoryName:'source',extractedTitle:'Fixture'}});
 t.after(async()=>{await app.close();await prisma.$disconnect();await rm(root,{recursive:true,force:true});});
 const base=`/api/v1/games/${gameId}/patches`,send=(method,url,payload)=>app.inject({method,url,headers:admin,payload});
 async function upload(name,bytes){const boundary='vnm-patch-test',payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),Buffer.from(bytes),Buffer.from(`\r\n--${boundary}--\r\n`)]);return app.inject({method:'POST',url:base+'/preview',headers:{...admin,'content-type':`multipart/form-data; boundary=${boundary}`},payload});}
 return {root,prisma,app,base,send,upload};
}
async function zip(entries){const archive=new ZipFile(),chunks=[];archive.outputStream.on('data',chunk=>chunks.push(chunk));const done=new Promise((resolve,reject)=>{archive.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));archive.outputStream.on('error',reject);});for(const [name,text]of Object.entries(entries))archive.addBuffer(Buffer.from(text),name);archive.end();return done;}
test('layout detection, ambiguity, source preference and unsupported files',()=>{
 const files=['Wrapper/Instructions.txt','Wrapper/game/mod.rpy','Wrapper/game/mod.rpyc','Wrapper/game/mod/images/a.png'].map(source=>({source}));
 assert.equal(packageRoots(files).suggestedRoot,'Wrapper/game');const mapped=mapPackage(files,'Wrapper/game');assert.deepEqual(mapped.files.map(f=>f.path),['game/mod.rpy','game/mod/images/a.png']);assert.equal(mapped.excluded.length,2);
 assert.equal(packageRoots([{source:'mod.rpy'}]).suggestedRoot,'');assert.equal(packageRoots([{source:'A/game/a.rpy'},{source:'B/game/b.rpy'}]).suggestedRoot,null);
 assert.throws(()=>mapPackage(files,'../bad'),/Choose a folder/);assert.equal(mapPackage([{source:'setup.exe'},{source:'saves/a.save'},{source:'_vnm_hook.rpy'}],'').files.length,0);
});
test('admin-only preview, confirmed installation, revisions, build snapshots and removal',async t=>{
 const {app,prisma,root,base,send,upload}=await fixture(t);assert.equal((await app.inject({url:base})).statusCode,403);
 let response=await upload('patch.zip',await zip({'Mod/Instructions.txt':'Copy game into the project.','Mod/game/script.rpy':'label start:\n    return','Mod/game/script.rpyc':'stale compiled','Mod/game/images/new.png':'image'}));assert.equal(response.statusCode,200,response.body);const preview=response.json();
 assert.equal(preview.root,'Mod/game');assert.equal(preview.files.length,2);assert.equal(preview.instructions.length,1);assert.equal(preview.files.find(f=>f.path==='game/script.rpy').replaces,'Original game file');
 assert.equal((await send('POST',base,{packageId:preview.packageId,root:preview.root,revision:0})).statusCode,400);
 response=await send('POST',base,{packageId:preview.packageId,root:preview.root,revision:0,confirmed:true});assert.equal(response.statusCode,200,response.body);
 assert.equal((await send('POST',base,{packageId:preview.packageId,root:preview.root,revision:0,confirmed:true})).json().alreadyInstalled,true);
 assert.equal(await readFile(join(root,'source/game/script.rpy'),'utf8'),'original');let list=(await send('GET',base)).json();assert.equal(list.needsBuild,true);assert.equal(list.revision,1);
 assert.equal((await send('PUT',base,{patches:[{id:preview.packageId,enabled:false}],revision:0,confirmed:true})).statusCode,409);
 response=await send('POST',`/api/v1/build/${gameId}`,{compressAssets:false});assert.equal(response.statusCode,202,response.body);const work=await prisma.workJob.findUnique({where:{id:response.json().jobId}}),input=JSON.parse(work.input);assert.equal(input.patchRevision,1);assert.equal(input.patches[0].id,preview.packageId);assert.equal(input.patches[0].files.length,2);
 assert.equal((await send('DELETE',`${base}/${preview.packageId}?revision=1`)).statusCode,409);
 response=await send('POST',`/api/v1/internal/build/${work.id}/status`,{status:'done',webBuildPath:'/web-builds/source'});assert.equal(response.statusCode,200,response.body);
 assert.equal((await prisma.game.findUnique({where:{id:gameId}})).builtPatchRevision,1);assert.equal((await send('GET',base)).json().needsBuild,false);
 response=await send('PUT',base,{patches:[{id:preview.packageId,enabled:false}],revision:1,confirmed:true});assert.equal(response.statusCode,200,response.body);
 list=(await send('GET',base)).json();assert.equal(list.patches[0].enabled,false);assert.equal(list.needsBuild,true);assert.equal(JSON.parse(work.input).patches.length,1);
 response=await send('DELETE',`${base}/${preview.packageId}?revision=2`);assert.equal(response.statusCode,200,response.body);await assert.rejects(access(join(root,'.vnm-patches',gameId,preview.packageId)));
});
test('raw scripts, malformed archives, unsupported packages and game isolation',async t=>{
 const {prisma,base,send,upload}=await fixture(t);let response=await upload('patch.rpy','init python:\n    value=1');assert.equal(response.statusCode,200,response.body);const preview=response.json();assert.equal(preview.files[0].path,'game/patch.rpy');
 const second='b'.repeat(32);await prisma.game.create({data:{id:second,directoryPath:'/other',directoryName:'other',extractedTitle:'Other'}});assert.equal((await send('POST',`/api/v1/games/${second}/patches/${preview.packageId}/preview`,{root:''})).statusCode,404);
 response=await upload('installer.zip',await zip({'setup.exe':'binary'}));assert.equal(response.statusCode,200);assert.equal(response.json().canInstall,false);assert.equal((await upload('broken.zip','not a zip')).statusCode,400);
});

test('preview rejects structural conflicts and reports compiled-only replacements',async t=>{
 const {root,base,send,upload}=await fixture(t);await mkdir(join(root,'source/game/folder.rpy'),{recursive:true});
 let response=await upload('conflict.zip',await zip({'folder.rpy':'file','a.rpy':'code'}));assert.equal(response.statusCode,200,response.body);assert.equal(response.json().canInstall,false);assert.ok(response.json().files.find(f=>f.path==='game/folder.rpy')?.conflict || response.json().excluded.some(f=>f.source==='folder.rpy'));
 response=await upload('compiled.zip',await zip({'script.rpyc':'bytecode'}));assert.equal(response.statusCode,200,response.body);assert.ok(response.json().files[0].replaces.includes('source'));assert.ok(response.json().warnings.some(w=>w.includes('Compiled-only')));
});
