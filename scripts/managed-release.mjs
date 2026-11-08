#!/usr/bin/env node
/** Local-only macOS release management. No downloads and no upstream update feed. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_ID = 'com.zxdwhda.hanaagent';
const ownScript = fileURLToPath(import.meta.url);
const quoted = value => `'${value.replaceAll("'", "'\\''")}'`;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value);

function copyTree(source, destination) {
  fs.cpSync(source,destination,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true});
  // Node's cp can mask file modes with the invoking umask. Restore only the
  // source's ordinary rwx bits, after copying children, without following links.
  function restoreModes(from,to) {
    const original=fs.lstatSync(from),copied=fs.lstatSync(to);
    if(original.isSymbolicLink()) {
      if(!copied.isSymbolicLink())throw Error('Copied symlink changed type');
      return;
    }
    if(copied.isSymbolicLink())throw Error('Unexpected symlink in copied tree');
    if(original.isDirectory()) {
      if(!copied.isDirectory())throw Error('Copied directory changed type');
      for(const name of fs.readdirSync(from))restoreModes(path.join(from,name),path.join(to,name));
    } else if(!original.isFile()||!copied.isFile())throw Error('Unsupported copied filesystem item');
    fs.chmodSync(to,original.mode&0o777);
  }
  restoreModes(source,destination);
}

export function hashTree(root) {
  const hash = crypto.createHash('sha256');
  function walk(dir, relative = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), rel = path.join(relative, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) hash.update('L\0' + rel + '\0' + fs.readlinkSync(file) + '\0');
      else if (stat.isDirectory()) { hash.update('D\0' + rel + '\0'); walk(file, rel); }
      else if (stat.isFile()) { hash.update('F\0' + rel + '\0' + (stat.mode & 0o777) + '\0'); hash.update(fs.readFileSync(file)); }
      else throw new Error(`Unsupported filesystem item: ${rel}`);
    }
  }
  walk(root); return hash.digest('hex');
}

function appMetadata(app) {
  const plist = path.join(app, 'Contents/Info.plist');
  const read = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {encoding:'utf8'}).trim();
  return { id:read('CFBundleIdentifier'), version:read('CFBundleShortVersionString'), executable:read('CFBundleExecutable') };
}

function systemProcesses() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,command='], {encoding:'utf8'}).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match ? [{pid:Number(match[1]),command:match[2]}] : [];
  });
}

export function createManagedReleaseManager({homeDir = os.homedir(), deps = {}} = {}) {
  const home = path.resolve(homeDir), root = path.join(home,'zxdwhda/hanaagent');
  const app = path.join(home,'Applications/hanaagent.app'), data = path.join(home,'.hanaagent');
  const statePath = path.join(root,'state.json'), journalPath = path.join(root,'transaction.json');
  const inspectApp = deps.inspectApp || appMetadata;
  const signature = deps.verifySignature || (file => execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',file],{stdio:'pipe'}));
  const processes = deps.processes || systemProcesses;
  const kill = deps.kill || ((pid, signal) => process.kill(pid,signal));
  const sleep = deps.sleep || (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms));
  const rename = deps.rename || fs.renameSync;
  const openAuthorApp = deps.openApp || (file => execFileSync('/usr/bin/open',['-a',file],{stdio:'pipe'}));
  const exists = file => fs.existsSync(file);
  const mkdir = dir => { secure(dir);fs.mkdirSync(dir,{recursive:true,mode:0o700}); };
  const remove = file => { secure(file);(deps.remove||fs.rmSync)(file,{recursive:true,force:true}); };
  function secure(file) {
    const rel = path.relative(home,file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Managed path escaped current home');
    let current = home;
    for(const piece of rel.split(path.sep).filter(Boolean)) {
      current=path.join(current,piece);
      try { if(fs.lstatSync(current).isSymbolicLink())throw Error(`Managed path must not be a symlink: ${current}`); }
      catch(error) { if(error.code!=='ENOENT')throw error; }
    }
  }
  function paths() { for(const p of [root,app,data])secure(p); }
  function json(file, value) {
    secure(file);mkdir(path.dirname(file));const temp=file+`.tmp-${process.pid}`;secure(temp);
    fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);
  }
  function state() {
    if(!exists(statePath))return {schemaVersion:1,current:null,history:[]};
    const value=JSON.parse(fs.readFileSync(statePath,'utf8'));
    if(value.schemaVersion!==1||!Array.isArray(value.history)||(value.current&&!safeId(value.current.releaseId)))throw Error('Invalid managed state');
    return value;
  }
  function verifyApp(file) {
    if(!fs.lstatSync(file).isDirectory()||fs.lstatSync(file).isSymbolicLink())throw Error('App must be a real .app directory');
    const real=fs.realpathSync(file);
    for(const rel of fs.readdirSync(file,{recursive:true})) {
      const item=path.join(file,rel);
      if(fs.lstatSync(item).isSymbolicLink()) {
        const target=fs.realpathSync(item);
        if(target!==real&&!target.startsWith(real+path.sep))throw Error('App contains an escaping symlink');
      }
    }
    const meta=inspectApp(file);
    if(meta.id!==APP_ID||meta.executable!=='hanaagent')throw Error(`App identity must be ${APP_ID} / hanaagent`);
    if(!safeId(meta.version))throw Error('Invalid app version');
    if(!exists(path.join(file,'Contents/MacOS',meta.executable)))throw Error('App executable is missing');
    signature(file);
    return {...meta,sha256:hashTree(file)};
  }
  function ownedProcesses() {
    const all=processes(), bin=path.join(app,'Contents/MacOS/hanaagent');
    const ours=all.filter(p=>p.command===bin||p.command.startsWith(bin+' ')||p.command.startsWith(app+'/Contents/')||p.command.startsWith(path.join(data,'artifacts')+'/'));
    const info=path.join(data,'server-info.json');
    if(exists(info)) {
      try {
        const pid=JSON.parse(fs.readFileSync(info,'utf8')).pid;
        const found=all.find(p=>p.pid===pid);
        if(found&&found.command.startsWith(path.join(data,'artifacts')+'/'))ours.push(found);
        else if(found&&!ours.some(p=>p.pid===pid))throw Error(`Unrecognized server PID ${pid} in managed data; refusing to signal it`);
      } catch(error) { if(!['ENOENT'].includes(error.code))throw error; }
    }
    return [...new Map(ours.map(p=>[p.pid,p])).values()];
  }
  function requireStopped() { if(ownedProcesses().length)throw Error('Stop hanaagent before installing, updating or rolling back'); }
  function verifyInstalled(current) {
    if(!current)throw Error('hanaagent is not installed');
    if(!exists(app)||hashTree(app)!==current.sha256)throw Error('Installed app was modified or its hash does not match managed state');
  }
  function withLock(fn) {
    paths();mkdir(root);const lock=path.join(root,'operation.lock');
    if(exists(lock)) {
      const pid=Number(fs.readFileSync(lock,'utf8'));let live=false;
      try { process.kill(pid,0);live=true; }catch(error){if(error.code!=='ESRCH')throw error;}
      if(live)throw Error('Another release operation is running');fs.unlinkSync(lock);
    }
    const fd=fs.openSync(lock,'wx',0o600);fs.writeSync(fd,String(process.pid));fs.closeSync(fd);
    try { return fn(); }finally { fs.unlinkSync(lock); }
  }
  function eventId() { return new Date().toISOString().replaceAll(/[^0-9]/g,'')+'-'+crypto.randomBytes(4).toString('hex'); }
  function txPaths(id, legacy = false) {
    if(!safeId(id))throw Error('Invalid transaction id');
    const staging=legacy?path.join(home,'Applications'):path.join(root,'staging.noindex');
    return {stagedApp:path.join(staging,`.hanaagent-stage-${id}.app`),savedApp:path.join(staging,`.hanaagent-before-${id}.app`),stagedData:path.join(home,`.hanaagent-stage-${id}`),savedData:path.join(home,`.hanaagent-before-${id}`)};
  }
  function archivePath(hash) {
    if(typeof hash!=='string'||!/^\w{64}$/.test(hash)||!/^[a-f0-9]+$/.test(hash))throw Error('Invalid app hash');
    const file=path.join(root,'archives',hash+'.tar.gz');secure(file);return file;
  }
  const fileHash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  function extractArchive(file,fn) {
    const entries=execFileSync('/usr/bin/tar',['-tzf',file],{encoding:'utf8',maxBuffer:8*1024*1024}).split('\n').filter(Boolean);
    if(!entries.length||entries.some(name=>!/^hanaagent\.app(?:\/|$)/.test(name)||name.split('/').includes('..')))throw Error('Archive contains unexpected paths');
    mkdir(path.join(root,'staging.noindex'));const temp=fs.mkdtempSync(path.join(root,'staging.noindex','extract-'));
    try {
      execFileSync('/usr/bin/tar',['-xzpf',file,'--no-same-owner','-C',temp],{stdio:'pipe'});
      return fn(path.join(temp,'hanaagent.app'));
    }finally{remove(temp);}
  }
  function withInput(input,fn) {
    input=path.resolve(input);
    return input.endsWith('.tar.gz')?extractArchive(input,fn):fn(input);
  }
  function ensureArchive(input,meta) {
    const file=archivePath(meta.sha256);mkdir(path.dirname(file));
    if(!exists(file)) {
      const temp=file+'.tmp-'+eventId();
      // Always normalize the archive root, independently of the input app name.
      mkdir(path.join(root,'staging.noindex'));const packing=fs.mkdtempSync(path.join(root,'staging.noindex','pack-'));
      try {
        copyTree(input,path.join(packing,'hanaagent.app'));
        execFileSync('/usr/bin/tar',['-czf',temp,'-C',packing,'hanaagent.app'],{stdio:'pipe',env:{...process.env,COPYFILE_DISABLE:'1'}});
        extractArchive(temp,restored=>{if(verifyApp(restored).sha256!==meta.sha256)throw Error('Archive round-trip hash mismatch');});
        fs.renameSync(temp,file);
      } finally { if(exists(temp))remove(temp);remove(packing); }
    } else extractArchive(file,restored=>{if(verifyApp(restored).sha256!==meta.sha256)throw Error('Existing archive hash mismatch');});
    return fileHash(file);
  }
  function withStoredApp(meta,fn) {
    const file=archivePath(meta.sha256);
    if(!meta.archiveSha256||fileHash(file)!==meta.archiveSha256)throw Error('Stored archive checksum mismatch');
    return extractArchive(file,restored=>{
      if(verifyApp(restored).sha256!==meta.sha256)throw Error('Stored release failed hash verification');
      return fn(restored);
    });
  }
  function saveRelease(input, tag) {
    const meta=verifyApp(input), id=tag||`${meta.version}-${meta.sha256.slice(0,16)}`;
    if(!safeId(id))throw Error('Invalid release id');
    const folder=path.join(root,'releases',id), releaseApp=path.join(folder,'hanaagent.app');
    if(exists(folder)) {
      const manifest=JSON.parse(fs.readFileSync(path.join(folder,'release.json'),'utf8'));
      if(manifest.sha256!==meta.sha256)throw Error('Release id already exists with different content');
      if(manifest.archiveSha256)withStoredApp(manifest,()=>{});
      else if(hashTree(releaseApp)!==meta.sha256)throw Error('Release id already exists with different content');
      const archiveSha256=ensureArchive(input,meta);
      json(path.join(folder,'release.json'),{...manifest,archiveSha256});
      if(exists(releaseApp))remove(releaseApp);
    } else {
      const archiveSha256=ensureArchive(input,meta);mkdir(folder);
      json(path.join(folder,'release.json'),{releaseId:id,...meta,archiveSha256,createdAt:new Date().toISOString()});
    }
    return {releaseId:id,...meta};
  }
  function storedRelease(id) {
    if(!safeId(id))throw Error('Invalid release id');
    const folder=path.join(root,'releases',id), manifest=JSON.parse(fs.readFileSync(path.join(folder,'release.json'),'utf8'));
    if(manifest.releaseId!==id)throw Error('Stored release id mismatch');
    if(!manifest.archiveSha256) {
      const legacy=path.join(folder,'hanaagent.app'),checked=verifyApp(legacy);
      if(manifest.sha256!==checked.sha256)throw Error('Stored release failed hash verification');
      manifest.archiveSha256=ensureArchive(legacy,checked);json(path.join(folder,'release.json'),manifest);
    }
    withStoredApp(manifest,()=>{});
    const legacy=path.join(folder,'hanaagent.app');
    if(exists(legacy)) {
      if(verifyApp(legacy).sha256!==manifest.sha256)throw Error('Legacy release changed; retained its app copy');
      remove(legacy);
    }
    return manifest;
  }
  function checkpoint(id) {
    const relative=path.join('checkpoints',id,'data'),target=path.join(root,relative);mkdir(path.dirname(target));
    if(exists(data))copyTree(data,target);else mkdir(target);
    json(path.join(root,'checkpoints',id,'checkpoint.json'),{createdAt:new Date().toISOString(),sha256:hashTree(target)});
    return relative;
  }
  function checkpointSource(relative) {
    if(typeof relative!=='string'||!/^checkpoints\/[A-Za-z0-9._-]+\/data$/.test(relative))throw Error('Invalid data checkpoint');
    const folder=path.join(root,relative);secure(folder);
    const meta=JSON.parse(fs.readFileSync(path.join(path.dirname(folder),'checkpoint.json'),'utf8'));
    if(hashTree(folder)!==meta.sha256)throw Error('Checkpoint data hash mismatch');
    return folder;
  }
  function commitRelease(next,{action,dataSource=null,restoreCheckpoint=null}) {
    const old=state();requireStopped();if(old.current)verifyInstalled(old.current);
    const id=eventId(),t=txPaths(id);mkdir(path.dirname(app));mkdir(path.dirname(t.stagedApp));
    const cp=old.current?checkpoint(id):null;
    const replaceData=dataSource!==null||restoreCheckpoint!==null;
    const dataExistedBefore=exists(data);
    withStoredApp(storedRelease(next.releaseId),stored=>copyTree(stored,t.stagedApp));
    if(replaceData){const from=restoreCheckpoint?checkpointSource(restoreCheckpoint):dataSource;copyTree(from,t.stagedData);}
    const entry={id,action,at:new Date().toISOString(),before:old.current,after:next,checkpoint:cp};
    json(journalPath,{schemaVersion:1,id,appStaging:'noindex',before:old,entry,replaceData,dataExistedBefore,createsData:!dataExistedBefore});
    let movedApp=false,movedData=false,newApp=false,newData=false,createdData=false,committed=false;
    try {
      if(exists(app)){rename(app,t.savedApp);movedApp=true;}
      if(replaceData&&exists(data)){rename(data,t.savedData);movedData=true;}
      rename(t.stagedApp,app);newApp=true;
      if(replaceData){rename(t.stagedData,data);newData=true;}else {createdData=!exists(data);mkdir(data);}
      if(hashTree(app)!==next.sha256)throw Error('Activated app hash mismatch');
      const result={schemaVersion:1,current:{...next,installedAt:entry.at},history:[...old.history,entry]};
      json(statePath,result);installEntrypoints();committed=true;
      remove(t.savedApp);remove(t.savedData);fs.unlinkSync(journalPath);return status();
    }catch(error){
      if(committed)throw new Error(`Release committed; cleanup/status failed. Keep the current app and run status/recover: ${error.message}`,{cause:error});
      if(newApp)remove(app);if(movedApp&&exists(t.savedApp))fs.renameSync(t.savedApp,app);
      if(newData||createdData)remove(data);if(movedData&&exists(t.savedData))fs.renameSync(t.savedData,data);
      json(statePath,old);if(exists(journalPath))fs.unlinkSync(journalPath);throw error;
    }finally{remove(t.stagedApp);remove(t.stagedData);}
  }
  function installEntrypoints() {
    mkdir(path.join(root,'management'));
    const installed=path.join(root,'management/managed-release.mjs');
    secure(installed);
    if(path.resolve(installed)!==path.resolve(ownScript))fs.copyFileSync(ownScript,installed);
    const node=path.join(root,'runtime/node');
    const cli=command=>`#!/bin/zsh\nset -eu\nexec ${quoted(node)} ${quoted(installed)} ${command}\n`;
    for(const [name,cmd]of [['start.command','start'],['status.command','status'],['rollback.command','rollback'],['author.command','author'],['manage.command','menu']]){const target=path.join(root,name);secure(target);fs.writeFileSync(target,cli(cmd),{mode:0o755});}
  }
  function pending() { if(exists(journalPath))throw Error('Interrupted release operation detected. Run recover before continuing'); }
  function status() { paths();const value=state();return {...value,paths:{root,app,data},running:ownedProcesses(),needsRecovery:exists(journalPath)}; }
  function install(input,{dataSource=null,releaseId=null}={}) { return withLock(()=>{
    pending();if(state().current)throw Error('Already installed; use update');requireStopped();
    if(exists(app))throw Error('Refusing to overwrite an existing unmanaged app');
    if(exists(data))throw Error('Refusing to overwrite existing unmanaged data');
    if(dataSource){dataSource=path.resolve(dataSource);if(fs.lstatSync(dataSource).isSymbolicLink()||!fs.statSync(dataSource).isDirectory())throw Error('Data source must be a real directory');const stamp=path.join(dataSource,'data-epoch.json');if(exists(stamp)&&JSON.parse(fs.readFileSync(stamp,'utf8')).epoch>1)throw Error('Data epoch requires conversion before installing 450');}
    return withInput(input,from=>{const next=saveRelease(from,releaseId);const result=commitRelease(next,{action:'install',dataSource});consumeIncoming(input,next);return result;});
  }); }
  function update(input,{releaseId=null}={}) { return withLock(()=>{
    pending();requireStopped();const current=state().current;verifyInstalled(current);
    return withInput(input,from=>{const next=saveRelease(from,releaseId);
      const result=next.releaseId===current.releaseId?status():commitRelease(next,{action:'update'});consumeIncoming(input,next);return result;});
  }); }
  function consumeIncoming(input,meta) {
    const source=path.resolve(input);
    if(path.dirname(source)!==path.join(root,'incoming')||!source.endsWith('.app'))return;
    secure(source);if(hashTree(source)!==meta.sha256)throw Error('Incoming app changed; retained it');
    json(path.join(root,'incoming','archived-'+meta.sha256+'.json'),{sourceName:path.basename(source),sha256:meta.sha256,archive:path.relative(root,archivePath(meta.sha256))});
    remove(source);
  }
  function compact() { return withLock(()=>{
    pending();verifyInstalled(state().current);
    const releases=path.join(root,'releases'),converted=[];
    for(const id of fs.readdirSync(releases)) {
      if(!safeId(id))throw Error('Unexpected release directory');
      secure(path.join(releases,id));storedRelease(id);converted.push(id);
    }
    const incoming=path.join(root,'incoming');
    if(exists(incoming))for(const name of fs.readdirSync(incoming).filter(x=>x.endsWith('.app'))) {
      const input=path.join(incoming,name);secure(input);const meta=verifyApp(input);ensureArchive(input,meta);consumeIncoming(input,meta);
    }
    return {converted,archives:fs.readdirSync(path.join(root,'archives')).filter(x=>x.endsWith('.tar.gz')),managed:status()};
  }); }
  function pack(input,output) { return withLock(()=>withInput(input,from=>{
    const meta=verifyApp(from);ensureArchive(from,meta);output=path.resolve(output);secure(output);
    if(!output.endsWith('.tar.gz')||exists(output))throw Error('Use a new .tar.gz output path');
    mkdir(path.dirname(output));fs.copyFileSync(archivePath(meta.sha256),output);return {output,...meta};
  })); }
  function rollback() { return withLock(()=>{
    pending();const value=state();requireStopped();verifyInstalled(value.current);
    const previous=[...value.history].reverse().find(e=>e.after?.releaseId===value.current.releaseId&&e.before&&e.checkpoint);
    if(!previous)throw Error('No previous release/data checkpoint available; use author to return to the preserved original');
    const next=storedRelease(previous.before.releaseId);return commitRelease(next,{action:'rollback',restoreCheckpoint:previous.checkpoint});
  }); }
  function start() {
    pending();const value=state();verifyInstalled(value.current);if(ownedProcesses().length)return status();
    if(deps.openApp)deps.openApp(app);
    else {
      mkdir(path.join(root,'logs'));const log=fs.openSync(path.join(root,'logs/desktop.log'),'a',0o600);
      const env={...process.env,HANA_HOME:data,HANA_PORT:'14501'};delete env.ELECTRON_RUN_AS_NODE;
      const child=spawn(path.join(app,'Contents/MacOS/hanaagent'),[],{env,detached:true,stdio:['ignore',log,log]});
      child.once('error',error=>{console.error('hanaagent launch:',error.message);process.exitCode=1;});
      child.unref();fs.closeSync(log);
    }
    return status();
  }
  function stop() {
    paths();let ours=ownedProcesses();for(const p of ours)try{kill(p.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
    for(let i=0;i<40&&ownedProcesses().length;i++)sleep(200);
    ours=ownedProcesses();for(const p of ours)try{kill(p.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
    for(let i=0;i<10&&ownedProcesses().length;i++)sleep(100);
    if(ownedProcesses().length)throw Error('Managed processes did not stop');return status();
  }
  function author() { const original='/Applications/HanaAgent.app';if(!exists(original))throw Error('Author app is not installed; restore it before switching. hanaagent remains running.');stop();openAuthorApp(original);return {authorApp:original,managed:status()}; }
  function recover() { return withLock(()=>{
    requireStopped();if(!exists(journalPath))return status();const j=JSON.parse(fs.readFileSync(journalPath,'utf8'));
    if(j.schemaVersion!==1||!safeId(j.id)||!j.before||!j.entry)throw Error('Invalid recovery journal');
    const t=txPaths(j.id,j.appStaging!=='noindex'),committed=state().history.some(e=>e.id===j.id);
    if(!committed){
      const failed=path.join(root,'failed-transactions.noindex',j.id);mkdir(failed);
      if(exists(t.savedApp)){if(exists(app))fs.renameSync(app,path.join(failed,'app'));fs.renameSync(t.savedApp,app);}
      else if(!j.before.current&&exists(app)){if(hashTree(app)!==j.entry.after.sha256)throw Error('Unexpected app in interrupted install');fs.renameSync(app,path.join(failed,'app'));}
      if(exists(t.savedData)){if(exists(data))fs.renameSync(data,path.join(failed,'data'));fs.renameSync(t.savedData,data);}
      else if((j.dataExistedBefore===false||j.createsData===true||(!j.before.current&&j.replaceData))&&exists(data))fs.renameSync(data,path.join(failed,'data'));
      json(statePath,j.before);
    }
    for(const file of Object.values(t))if(exists(file)){mkdir(path.join(root,'recovered-staging.noindex',j.id));fs.renameSync(file,path.join(root,'recovered-staging.noindex',j.id,path.basename(file)));}
    fs.unlinkSync(journalPath);return status();
  }); }
  return {status,install,update,rollback,start,stop,author,recover,compact,pack,paths:{root,app,data}};
}

async function main() {
  const args=process.argv.slice(2),command=args.shift()||'status',manager=createManagedReleaseManager();
  const option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  let result;
  if(command==='pack'){if(!option('--app')||!option('--output'))throw Error('Use pack --app APP --output FILE.tar.gz');result=manager.pack(option('--app'),option('--output'));}
  else if(command==='install'||command==='update'){
    const app=option('--app')||args.find(x=>!x.startsWith('--'));if(!app)throw Error('Use install/update --app /path/hanaagent.app');
    if(command==='update'&&option('--data-source'))throw Error('Data source is only accepted for the first install');
    result=manager[command](app,{dataSource:option('--data-source'),releaseId:option('--release-id')});
  }else if(command==='rollback'){manager.stop();result=manager.rollback();}
  else if(['status','start','stop','author','recover','compact'].includes(command))result=manager[command]();
  else if(command==='menu'){
    const {createInterface}=await import('node:readline/promises');const rl=createInterface({input:process.stdin,output:process.stdout});
    try{
      console.log('hanaagent 本地版本管理\n1 查看状态\n2 启动\n3 停止\n4 安装更新\n5 回退上一版本及数据\n6 返回保留的作者版\n7 恢复中断的安装\n0 退出');
      const choice=(await rl.question('选择：')).trim();
      if(choice==='4'){let file=(await rl.question('更新 .tar.gz 归档或 .app 的完整路径：')).trim();if((file.startsWith("'")&&file.endsWith("'"))||(file.startsWith('"')&&file.endsWith('"')))file=file.slice(1,-1);manager.stop();result=manager.update(file);}
      else if(choice==='5'){manager.stop();result=manager.rollback();}
      else if(choice==='0')return;
      else {const action={'1':'status','2':'start','3':'stop','6':'author','7':'recover'}[choice];if(!action)throw Error('Unknown choice');result=manager[action]();}
    }finally{rl.close();}
  }else throw Error('Commands: status | install --app APP_OR_TAR_GZ [--data-source DIR] [--release-id ID] | update --app APP_OR_TAR_GZ [--release-id ID] | pack --app APP --output FILE.tar.gz | compact | start | stop | rollback | author | recover | menu');
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===ownScript)main().catch(error=>{console.error('hanaagent management:',error.message);process.exitCode=1;});
