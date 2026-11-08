import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHanakoHome } from "../shared/hana-runtime-paths.ts";
import { resolveCliHanaHome } from "../cli/local-server.ts";
import { defaultDevHanaHome } from "../scripts/dev-env.js";

const root = process.cwd();

function runIsolated(script: string) {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=commonjs", "--eval", script], {
    cwd: root,
    encoding: "utf8",
  }));
}

describe("independent locally managed distribution", () => {
  it("owns a distinct product identity and production/development data homes", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "hanaagent", version: "0.450.1", build: {
      appId: "com.zxdwhda.hanaagent", productName: "hanaagent",
    } });
    expect(resolveHanakoHome(undefined, "/tmp/independent-user")).toBe("/tmp/independent-user/.hanaagent");
    expect(resolveCliHanaHome({})).toBe(path.join(os.homedir(), ".hanaagent"));
    expect(defaultDevHanaHome()).toBe(path.join(os.homedir(), ".hanaagent-dev"));
  });

  it("blocks shared OTA checks, downloads and transports before network or filesystem work", () => {
    const result = runIsolated(`
      const core = require('./shared/artifact-core/ota-core.cjs');
      let calls = 0;
      const fetchOnce = async () => { calls++; throw new Error('unexpected network'); };
      (async () => {
        const opts = {homeDir:'/unused/home',keyset:[],currentShellVersion:'0.450.1',platformArch:'darwin-arm64',fetchOnce};
        const checked = await core.checkOnce(opts);
        const applied = await core.downloadAndApplyArtifacts(opts);
        const renderer = await core.downloadAndApplyRendererArtifact({...opts,serverProtocolVersion:1});
        let transportCode, manifestCode;
        try { await core.fetchWithRedirects('https://github.com/author/update', {fetchOnce}); } catch(e) { transportCode=e.code; }
        try { await core.fetchChannelManifest({...opts,channel:'stable'}); } catch(e) { manifestCode=e.code; }
        console.log(JSON.stringify({checked,applied,renderer,transportCode,manifestCode,calls}));
      })().catch(e => { console.error(e);process.exitCode=1; });
    `);
    expect(result.calls).toBe(0);
    for (const name of ["checked", "applied", "renderer"]) {
      expect(result[name]).toMatchObject({ ok: false, status: "local-managed", code: "local-managed" });
    }
    expect(result.transportCode).toBe("local-managed");
    expect(result.manifestCode).toBe("local-managed");
  });

  it("blocks shell automatic/manual checks, invite changes and installation without contacting any update feed", () => {
    const result = runIsolated(`
      const Module = require('node:module');
      const originalLoad = Module._load;
      const handlers = {};
      let remoteCalls=0, timers=0;
      const remote = () => { remoteCalls++;throw new Error('unexpected update side effect'); };
      global.fetch=remote;
      const updater = {setFeedURL:remote,checkForUpdates:remote,downloadUpdate:remote,quitAndInstall:remote,on:()=>{}};
      Module._load = function(id,...args) {
        if(id==='electron')return {app:{isPackaged:true,getVersion:()=>'0.450.1',getPath:()=>'/unused'},ipcMain:{handle:(name,handler)=>handlers[name]=handler},BrowserWindow:{getAllWindows:()=>[]}};
        if(id==='electron-updater')return {autoUpdater:updater};
        return originalLoad.call(this,id,...args);
      };
      global.setInterval=()=>{timers++;return {unref(){}}};
      (async()=>{
        const shell = require('./desktop/auto-updater.cjs');
        shell.initAutoUpdater(null,{hanakoHome:'/unused/home'});
        const automatic=await shell.checkForUpdatesAuto();
        const manual=await handlers['auto-update-check']();
        const invite=await handlers['invite:redeem'](null,'not-a-real-code');
        const activate=await handlers['invite:activate'](null,{feedUrl:'https://github.com/author/update'});
        const installed=await shell.installDownloadedUpdate();
        const history = require('./desktop/src/shared/update-digest-history.cjs').createUpdateDigestHistoryLoader({fetchImpl:remote,normalize:x=>x,readBundledEntries:()=>[{version:'0.450.1'}]});
        const digest=await history();
        console.log(JSON.stringify({automatic,manual,invite,activate,installed,digest,remoteCalls,timers}));
      })().catch(e=>{console.error(e);process.exitCode=1;});
    `);
    expect(result.remoteCalls).toBe(0);
    expect(result.timers).toBe(0);
    for (const name of ["automatic", "manual", "invite", "activate"]) {
      expect(result[name]).toMatchObject({ status: "local-managed", code: "local-managed" });
    }
    expect(result.installed).toBe(false);
    expect(result.digest).toMatchObject({ source: "bundled", status: "local-managed", entries: [{ version: "0.450.1" }] });
  });
});
