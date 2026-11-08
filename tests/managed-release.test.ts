import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedReleaseManager, hashTree } from '../scripts/managed-release.mjs';

const homes: string[] = [];
function fixture(extraDeps: Record<string, unknown> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-managed-test-'));
  homes.push(home);
  let processes: Array<{pid:number;command:string}> = [];
  const killed: number[] = [];
  const manager = createManagedReleaseManager({homeDir:home,deps:{
    inspectApp(app: string) { return JSON.parse(fs.readFileSync(path.join(app,'Contents','Info.plist'),'utf8')); },
    verifySignature(app: string) { if(fs.existsSync(path.join(app,'bad-signature')))throw Error('invalid signature'); },
    processes:()=>processes,
    kill(pid:number){killed.push(pid);processes=processes.filter(x=>x.pid!==pid);},
    sleep(){},
    openApp(){},
    ...extraDeps,
  }});
  function app(version: string, id = 'com.zxdwhda.hanaagent') {
    const dir=path.join(home,'inputs',version+'.app');
    fs.mkdirSync(path.join(dir,'Contents/MacOS'),{recursive:true});
    fs.writeFileSync(path.join(dir,'Contents/Info.plist'),JSON.stringify({id,version,executable:'hanaagent'}));
    fs.writeFileSync(path.join(dir,'Contents/MacOS/hanaagent'),'fake executable '+version,{mode:0o755});
    return dir;
  }
  function candidate() {
    const dir=path.join(home,'candidate');fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir,'data-epoch.json'),JSON.stringify({epoch:1}));
    fs.writeFileSync(path.join(dir,'history.txt'),'migrated history');return dir;
  }
  return {home,manager,app,candidate,killed,setProcesses:(v:typeof processes)=>{processes=v;}};
}
afterEach(()=>{for(const p of homes.splice(0))fs.rmSync(p,{recursive:true,force:true});});

describe('managed independent macOS releases',()=>{
  it('keeps the managed app running when the author app has been uninstalled',()=>{
    const f=fixture();
    f.setProcesses([{pid:20,command:path.join(f.home,'Applications/hanaagent.app/Contents/MacOS/hanaagent')}]);
    const exists=fs.existsSync;
    const mock=vi.spyOn(fs,'existsSync').mockImplementation(file=>file==='/Applications/HanaAgent.app'?false:exists(file));
    try {
      expect(()=>f.manager.author()).toThrow(/not installed/);
      expect(f.killed).toEqual([]);
    } finally { mock.mockRestore(); }
  });
  it('installs to user Applications, leaves the candidate and author data untouched',()=>{
    const f=fixture(),input=f.app('0.450.1'),candidate=f.candidate();
    fs.mkdirSync(path.join(f.home,'.hanako'));fs.writeFileSync(path.join(f.home,'.hanako/original'),'author');
    const result=f.manager.install(input,{dataSource:candidate});
    expect(result.current.version).toBe('0.450.1');
    expect(fs.readFileSync(path.join(f.home,'.hanaagent/history.txt'),'utf8')).toBe('migrated history');
    expect(fs.readFileSync(path.join(candidate,'history.txt'),'utf8')).toBe('migrated history');
    expect(fs.readFileSync(path.join(f.home,'.hanako/original'),'utf8')).toBe('author');
    expect(fs.existsSync(path.join(f.home,'Applications/hanaagent.app'))).toBe(true);
    expect(fs.existsSync(path.join(f.home,'zxdwhda/hanaagent/start.command'))).toBe(true);
  });
  it('rejects the author identity and invalid signature before installing',()=>{
    const f=fixture(),bad=f.app('0.450.0','com.hanako.app');
    expect(()=>f.manager.install(bad)).toThrow(/identity/i);
    const unsigned=f.app('0.450.1');fs.writeFileSync(path.join(unsigned,'bad-signature'),'');
    expect(()=>f.manager.install(unsigned)).toThrow(/signature/i);
    expect(fs.existsSync(path.join(f.home,'Applications/hanaagent.app'))).toBe(false);
  });
  it('rejects an app with an escaping symlink',()=>{
    const f=fixture(),app=f.app('0.450.1');fs.symlinkSync('/tmp',path.join(app,'escape'));
    expect(()=>f.manager.install(app)).toThrow(/symlink/i);
  });
  it('refuses to adopt an unknown existing app or data directory',()=>{
    const f=fixture();fs.mkdirSync(path.join(f.home,'.hanaagent'));fs.writeFileSync(path.join(f.home,'.hanaagent/precious'),'keep');
    expect(()=>f.manager.install(f.app('0.450.1'))).toThrow(/existing.*data/i);
    expect(fs.readFileSync(path.join(f.home,'.hanaagent/precious'),'utf8')).toBe('keep');
  });
  it('rejects unconverted epoch 3 data',()=>{
    const f=fixture(),data=f.candidate();fs.writeFileSync(path.join(data,'data-epoch.json'),'{"epoch":3}');
    expect(()=>f.manager.install(f.app('0.450.1'),{dataSource:data})).toThrow(/epoch/i);
  });
  it('update and rollback restore the matching app and data, preserving post-update work',()=>{
    const f=fixture();f.manager.install(f.app('0.450.1'),{dataSource:f.candidate()});
    const state=f.manager.update(f.app('0.450.2'));
    expect(state.current.version).toBe('0.450.2');
    fs.writeFileSync(path.join(f.home,'.hanaagent/new-work'),'after update');
    const rolled=f.manager.rollback();
    expect(rolled.current.version).toBe('0.450.1');
    expect(fs.readFileSync(path.join(f.home,'.hanaagent/history.txt'),'utf8')).toBe('migrated history');
    expect(fs.existsSync(path.join(f.home,'.hanaagent/new-work'))).toBe(false);
    const last=rolled.history.at(-1);
    expect(fs.readFileSync(path.join(f.home,'zxdwhda/hanaagent',last.checkpoint,'new-work'),'utf8')).toBe('after update');
    expect(f.manager.rollback().current.version).toBe('0.450.2');
    expect(fs.readFileSync(path.join(f.home,'.hanaagent/new-work'),'utf8')).toBe('after update');
  });
  it('refuses updates while the independent app is running',()=>{
    const f=fixture();f.manager.install(f.app('0.450.1'));
    f.setProcesses([{pid:20,command:path.join(f.home,'Applications/hanaagent.app/Contents/MacOS/hanaagent')}]);
    expect(()=>f.manager.update(f.app('0.450.2'))).toThrow(/stop/i);
    expect(f.manager.status().current.version).toBe('0.450.1');
  });
  it('stop kills only processes belonging to this managed app/home',()=>{
    const f=fixture();f.manager.install(f.app('0.450.1'));
    fs.writeFileSync(path.join(f.home,'.hanaagent/server-info.json'),'{"pid":30}');
    f.setProcesses([{pid:20,command:path.join(f.home,'Applications/hanaagent.app/Contents/MacOS/hanaagent')},{pid:30,command:path.join(f.home,'.hanaagent/artifacts/server/450/node')+' bootstrap.js'},{pid:40,command:'/Applications/HanaAgent.app/Contents/MacOS/HanaAgent'}]);
    f.manager.stop();expect(f.killed.sort()).toEqual([20,30]);
  });
  it('stops an owned orphan server even after shutdown removed server-info',()=>{
    const f=fixture();f.manager.install(f.app('0.450.1'));
    f.setProcesses([{pid:31,command:path.join(f.home,'.hanaagent/artifacts/server/450/node')+' bootstrap.js'},{pid:41,command:'/Users/other/.hanako/artifacts/server/node'}]);
    f.manager.stop();expect(f.killed).toEqual([31]);
  });
  it('rejects tampered installed app before updating',()=>{
    const f=fixture();f.manager.install(f.app('0.450.1'));
    fs.appendFileSync(path.join(f.home,'Applications/hanaagent.app/Contents/MacOS/hanaagent'),'tamper');
    expect(()=>f.manager.update(f.app('0.450.2'))).toThrow(/modified|hash/i);
  });
  it('returns identical deterministic tree hashes for copies',()=>{
    const f=fixture(),a=f.app('0.450.1'),b=path.join(f.home,'copy.app');fs.cpSync(a,b,{recursive:true});
    expect(hashTree(a)).toBe(hashTree(b));
  });
  it('preserves relative framework symlinks inside a signed app copy',()=>{
    const f=fixture(),a=f.app('0.450.1');
    const versions=path.join(a,'Contents/Frameworks/Test.framework/Versions');
    fs.mkdirSync(path.join(versions,'A'),{recursive:true});fs.writeFileSync(path.join(versions,'A/Test'),'binary');
    fs.symlinkSync('A',path.join(versions,'Current'));
    f.manager.install(a);
    expect(fs.readlinkSync(path.join(f.home,'Applications/hanaagent.app/Contents/Frameworks/Test.framework/Versions/Current'))).toBe('A');
    expect(hashTree(path.join(f.home,'Applications/hanaagent.app'))).toBe(hashTree(a));
  });
  it('restores the installed app and data if activation fails mid-update',()=>{
    let fail=false;
    const f=fixture({rename(from:string,to:string){
      if(fail&&path.basename(from).startsWith('.hanaagent-stage-')&&to.endsWith('/Applications/hanaagent.app'))throw Error('simulated disk failure');
      fs.renameSync(from,to);
    }});
    f.manager.install(f.app('0.450.1'),{dataSource:f.candidate()});fail=true;
    expect(()=>f.manager.update(f.app('0.450.2'))).toThrow('simulated disk failure');
    expect(f.manager.status().current.version).toBe('0.450.1');
    expect(fs.readFileSync(path.join(f.home,'.hanaagent/history.txt'),'utf8')).toBe('migrated history');
    expect(JSON.parse(fs.readFileSync(path.join(f.home,'Applications/hanaagent.app/Contents/Info.plist'),'utf8')).version).toBe('0.450.1');
    expect(f.manager.status().needsRecovery).toBe(false);
  });
  it('allows an explicit new release id for the same app and snapshots data for rollback',()=>{
    const f=fixture(),a=f.app('0.450.1');f.manager.install(a);
    const first=f.manager.status().current.releaseId;
    expect(f.manager.update(a).current.releaseId).toBe(first);
    expect(f.manager.update(a,{releaseId:'rehearsal-2'}).current.releaseId).toBe('rehearsal-2');
    expect(f.manager.rollback().current.releaseId).toBe(first);
  });
  it('keeps the committed new app when post-commit cleanup fails and recovers residue',()=>{
    let fail=false;
    const f=fixture({remove(file:string,options:fs.RmOptions){
      if(fail&&path.basename(file).startsWith('.hanaagent-before-')&&file.endsWith('.app'))throw Error('cleanup denied');
      fs.rmSync(file,options);
    }});
    f.manager.install(f.app('0.450.1'),{dataSource:f.candidate()});fail=true;
    expect(()=>f.manager.update(f.app('0.450.2'))).toThrow(/committed/i);
    expect(f.manager.status().current.version).toBe('0.450.2');
    expect(f.manager.status().needsRecovery).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(f.home,'Applications/hanaagent.app/Contents/Info.plist'),'utf8')).version).toBe('0.450.2');
    fail=false;expect(f.manager.recover().needsRecovery).toBe(false);
    expect(f.manager.status().current.version).toBe('0.450.2');
    expect(f.manager.rollback().current.version).toBe('0.450.1');
  });
  it('recovers a real interrupted child process before the commit point',()=>{
    const f=fixture();f.manager.install(f.app('0.450.1'),{dataSource:f.candidate()});
    const next=f.app('0.450.2'),script=path.join(f.home,'crash-operation.mjs');
    fs.writeFileSync(script,`import fs from 'node:fs';
      import {createManagedReleaseManager} from ${JSON.stringify(pathToFileURL(path.resolve('scripts/managed-release.mjs')).href)};
      const manager=createManagedReleaseManager({homeDir:${JSON.stringify(f.home)},deps:{
        inspectApp(app){return JSON.parse(fs.readFileSync(app+'/Contents/Info.plist','utf8'));},verifySignature(){},processes(){return [];},
        rename(from,to){fs.renameSync(from,to);if(from.includes('.hanaagent-stage-')&&to.endsWith('/Applications/hanaagent.app'))process.kill(process.pid,'SIGKILL');}
      }});manager.update(${JSON.stringify(next)});`);
    const child=spawnSync(process.execPath,[script],{encoding:'utf8'});
    expect(child.signal).toBe('SIGKILL');
    expect(f.manager.status().needsRecovery).toBe(true);
    expect(f.manager.recover().current.version).toBe('0.450.1');
    expect(fs.readFileSync(path.join(f.home,'.hanaagent/history.txt'),'utf8')).toBe('migrated history');
    expect(JSON.parse(fs.readFileSync(path.join(f.home,'Applications/hanaagent.app/Contents/Info.plist'),'utf8')).version).toBe('0.450.1');
  });
  it('archives data created by an interrupted first install without a data source and permits retry',()=>{
    const f=fixture(),input=f.app('0.450.1'),script=path.join(f.home,'crash-first-install.mjs');
    fs.writeFileSync(script,`import fs from 'node:fs';
      import {createManagedReleaseManager} from ${JSON.stringify(pathToFileURL(path.resolve('scripts/managed-release.mjs')).href)};
      const originalRename=fs.renameSync;
      fs.renameSync=(from,to)=>{if(to.endsWith('/state.json')){
        fs.writeFileSync(${JSON.stringify(path.join(f.home,'.hanaagent/orphan-marker'))},'preserve generated data');process.kill(process.pid,'SIGKILL');
      }return originalRename(from,to);};
      const manager=createManagedReleaseManager({homeDir:${JSON.stringify(f.home)},deps:{
        inspectApp(app){return JSON.parse(fs.readFileSync(app+'/Contents/Info.plist','utf8'));},verifySignature(){},processes(){return [];}
      }});manager.install(${JSON.stringify(input)});`);
    const child=spawnSync(process.execPath,[script],{encoding:'utf8'});
    expect(child.signal).toBe('SIGKILL');
    const journal=JSON.parse(fs.readFileSync(path.join(f.home,'zxdwhda/hanaagent/transaction.json'),'utf8'));
    expect(fs.existsSync(path.join(f.home,'.hanaagent/orphan-marker'))).toBe(true);
    expect(f.manager.recover().current).toBeNull();
    expect(fs.existsSync(path.join(f.home,'.hanaagent'))).toBe(false);
    expect(fs.readFileSync(path.join(f.home,'zxdwhda/hanaagent/failed-transactions.noindex',journal.id,'data/orphan-marker'),'utf8')).toBe('preserve generated data');
    expect(f.manager.install(input).current.version).toBe('0.450.1');
  });
  it('preserves app and private data modes under umask 077 across install, update and rollback',()=>{
    const f=fixture(),first=f.app('0.450.1'),second=f.app('0.450.2'),candidate=f.candidate();
    fs.chmodSync(path.join(first,'Contents/Info.plist'),0o644);
    fs.chmodSync(path.join(first,'Contents/MacOS/hanaagent'),0o755);
    fs.chmodSync(path.join(candidate,'history.txt'),0o644);
    fs.writeFileSync(path.join(candidate,'credentials.json'),'private test fixture',{mode:0o600});
    const previous=process.umask(0o077);
    try {
      f.manager.install(first,{dataSource:candidate});
      expect(hashTree(path.join(f.home,'Applications/hanaagent.app'))).toBe(hashTree(first));
      expect(fs.statSync(path.join(f.home,'Applications/hanaagent.app/Contents/Info.plist')).mode&0o777).toBe(0o644);
      expect(fs.statSync(path.join(f.home,'.hanaagent/credentials.json')).mode&0o777).toBe(0o600);
      f.manager.update(second);f.manager.rollback();
      expect(hashTree(path.join(f.home,'Applications/hanaagent.app'))).toBe(hashTree(first));
      expect(fs.statSync(path.join(f.home,'.hanaagent/history.txt')).mode&0o777).toBe(0o644);
      expect(fs.statSync(path.join(f.home,'.hanaagent/credentials.json')).mode&0o777).toBe(0o600);
    }finally{process.umask(previous);}
  });
  it('stores identical release labels in one archive without app bundles in the managed root',()=>{
    const f=fixture(),input=f.app('0.450.1');f.manager.install(input);
    f.manager.update(input,{releaseId:'mini-second'});
    const root=path.join(f.home,'zxdwhda/hanaagent');
    expect(fs.readdirSync(path.join(root,'archives')).filter(x=>x.endsWith('.tar.gz'))).toHaveLength(1);
    expect(fs.readdirSync(root,{recursive:true}).filter(x=>String(x).endsWith('.app'))).toEqual([]);
    expect(f.manager.rollback().current.version).toBe('0.450.1');
  });
  it('compacts legacy release and incoming app copies while running without changing data or history',()=>{
    const f=fixture(),input=f.app('0.450.1');const installed=f.manager.install(input,{dataSource:f.candidate()});
    const root=path.join(f.home,'zxdwhda/hanaagent'),folder=path.join(root,'releases',installed.current.releaseId);
    const manifest=JSON.parse(fs.readFileSync(path.join(folder,'release.json'),'utf8'));delete manifest.archiveSha256;
    fs.writeFileSync(path.join(folder,'release.json'),JSON.stringify(manifest));
    fs.cpSync(input,path.join(folder,'hanaagent.app'),{recursive:true});
    fs.rmSync(path.join(root,'archives'),{recursive:true});
    fs.mkdirSync(path.join(root,'incoming'));fs.cpSync(input,path.join(root,'incoming/delivery.app'),{recursive:true});
    const dataBefore=hashTree(path.join(f.home,'.hanaagent')),stateBefore=fs.readFileSync(path.join(root,'state.json'),'utf8');
    f.setProcesses([{pid:20,command:path.join(f.home,'Applications/hanaagent.app/Contents/MacOS/hanaagent')}]);
    f.manager.compact();
    expect(f.killed).toEqual([]);
    expect(hashTree(path.join(f.home,'.hanaagent'))).toBe(dataBefore);
    expect(fs.readFileSync(path.join(root,'state.json'),'utf8')).toBe(stateBefore);
    expect(fs.readdirSync(root,{recursive:true}).filter(x=>String(x).endsWith('.app'))).toEqual([]);
    expect(fs.existsSync(path.join(root,'incoming','archived-'+installed.current.sha256+'.json'))).toBe(true);
    expect(f.manager.compact().archives).toHaveLength(1);
  });
  it('accepts packed updates and rejects corrupted rollback archives before changing the app or data',()=>{
    const f=fixture();f.manager.install(f.app('0.450.1'),{dataSource:f.candidate()});
    const first=f.manager.status().current.sha256;
    const packed=f.manager.pack(f.app('0.450.2'),path.join(f.home,'delivery.tar.gz'));
    expect(f.manager.update(packed.output).current.version).toBe('0.450.2');
    const root=path.join(f.home,'zxdwhda/hanaagent');
    fs.appendFileSync(path.join(root,'archives',first+'.tar.gz'),'tampered');
    const before=hashTree(path.join(f.home,'.hanaagent'));
    expect(()=>f.manager.rollback()).toThrow(/checksum/);
    expect(f.manager.status().current.version).toBe('0.450.2');
    expect(hashTree(path.join(f.home,'.hanaagent'))).toBe(before);
  });
  it('finishes legacy cleanup after a migration already committed its archive manifest',()=>{
    const f=fixture(),input=f.app('0.450.1'),installed=f.manager.install(input);
    const legacy=path.join(f.home,'zxdwhda/hanaagent/releases',installed.current.releaseId,'hanaagent.app');
    fs.cpSync(input,legacy,{recursive:true});
    f.manager.compact();
    expect(fs.existsSync(legacy)).toBe(false);
    expect(f.manager.status().current.sha256).toBe(hashTree(input));
  });
  it('consumes successful managed incoming updates but retains external delivery files',()=>{
    const f=fixture();f.manager.install(f.app('0.450.1'));
    const incoming=path.join(f.home,'zxdwhda/hanaagent/incoming');fs.mkdirSync(incoming);
    const input=path.join(incoming,'new.app');fs.cpSync(f.app('0.450.2'),input,{recursive:true});
    f.manager.update(input);expect(fs.existsSync(input)).toBe(false);
    const external=f.app('0.450.3');f.manager.update(external);expect(fs.existsSync(external)).toBe(true);
  });
});
