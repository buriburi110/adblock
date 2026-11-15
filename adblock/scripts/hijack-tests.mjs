import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Synthetic pages only: every request is fulfilled locally or aborted and DNS
// resolution is disabled. Never load a real advertising payload or user profile.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const readText = file => fs.readFileSync(path.join(root, file), "utf8");
const host = "hijack-fixture.example";
const frameHost = "hijack-frame.example";
const fixturePath = "/codex-hijack-fixture";
const fixtureUrl = `https://${host}${fixturePath}`;
const reasonCodes = new Set(["known-overlay", "ad-overlay", "ad-link", "ad-popup", "strict-popup"]);
let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

await test("Hijack protection keeps permissions unchanged and separates isolated control from MAIN popup interception", () => {
  const manifest = readJson("manifest.json");
  assert.deepEqual(manifest.permissions, ["activeTab", "declarativeNetRequest", "scripting", "storage"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://chzzk.naver.com/*", "https://vod.sooplive.com/*", "https://youtube.com/*",
    "https://www.youtube.com/*", "https://m.youtube.com/*", "https://music.youtube.com/*",
    "https://tv.youtube.com/*", "https://www.youtube-nocookie.com/*",
  ]);
  const isolated = manifest.content_scripts.find(entry => entry.js?.includes("hijack-guard.js"));
  const main = manifest.content_scripts.find(entry => entry.js?.includes("hijack-main.js"));
  assert.ok(isolated && main);
  assert.deepEqual(isolated.js, ["content.js", "hijack-patterns.js", "hijack-guard.js"]);
  assert.deepEqual(main.js, ["hijack-main.js"]);
  assert.ok(readText("hijack-main.js").startsWith(readText("hijack-patterns.js").trim()),
    "The MAIN bundle must contain the identical portable classifier");
  for (const entry of [isolated, main]) {
    assert.deepEqual(entry.matches, ["http://*/*", "https://*/*"]);
    assert.equal(entry.run_at, "document_start");
    assert.equal(entry.all_frames, true);
    assert.equal(entry.match_about_blank, true);
  }
  assert.equal(isolated.world ?? "ISOLATED", "ISOLATED");
  assert.equal(main.world, "MAIN");
  assert.doesNotMatch(readText("hijack-main.js"), /chrome\.(?:storage|cookies|tabs)|Location\.prototype/);
});

await test("Known overlay protection is reversible and independent of generic advertising CSS", () => {
  const css = readText("cosmetic.css");
  assert.match(css, /html\.lae-hijack-active\s+div\[data-cl-overlay\]/);
  assert.match(css, /data-lae-hijack-blocked/);
  assert.doesNotMatch(css, /html\.lae-active\s+div\[data-cl-overlay\]/);
});

await test("Portable pattern classification enforces host boundaries and popup-only path scope without argument coercion", () => {
  const context={URL};
  vm.runInNewContext(readText("hijack-patterns.js"),context,{filename:"hijack-patterns.js"});
  const classify=context.__laeHijackPatterns.classify;
  for(const destination of ["popads.net","popcash.net","popmyads.com","popunder.bid","popunderjs.com","propellerpops.com"]) {
    assert.equal(classify(`https://${destination}/click`,fixtureUrl).knownHost,true,destination);
    assert.equal(classify(`https://sub.${destination}/click`,fixtureUrl).knownHost,true,destination);
    assert.equal(classify(`https://${destination}.ordinary.example/click`,fixtureUrl).knownHost,false,destination);
    assert.equal(classify(`https://${destination}@ordinary.example/click`,fixtureUrl).knownHost,false,destination);
    assert.equal(classify(`https://${destination}/click`,`https://${destination}/`).knownHost,false,destination);
  }
  for(const pathname of ["/popunder/in/click/123","/popunder_test","/popupads.php","/links/popad/123"]) {
    const result=classify(`https://unlisted.example${pathname}`,fixtureUrl);
    assert.equal(result.popupPattern,true,pathname);
    assert.equal(result.knownHost,false,pathname);
  }
  for(const url of ["about:blank","javascript:alert(1)","mailto:help@example.test","data:text/plain,test","https://ordinary.example/?path=/popupads.php"]) {
    const result=classify(url,fixtureUrl);
    assert.equal(result.knownHost,false,url);assert.equal(result.popupPattern,false,url);
  }
  let coerced=false;
  classify({toString(){coerced=true;return "https://popads.net/";}},fixtureUrl);
  assert.equal(coerced,false);
});

await test("Popup wrapper preserves native arguments, receiver, return value and errors outside known blocking cases", () => {
  let mode = "basic";
  const calls = [];
  const reasons = [];
  const nativeResult = {native:true};
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const window = {
    open(...args) { calls.push({receiver:this,args}); if(args[0] === "throw-native") throw new TypeError("native error"); return nativeResult; },
    addEventListener(type, listener) {listeners.set(type,listener);},
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const context = {
    window, URL, performance:{now:()=>100},
    HTMLAnchorElement: class {},
    CustomEvent: class {constructor(type,options) {this.type=type;this.detail=options.detail;}},
    document:{baseURI:fixtureUrl,documentElement:{getAttribute:()=>mode},dispatchEvent:event=>reasons.push(event.detail)},
  };
  vm.runInNewContext(readText("hijack-main.js"),context,{filename:"hijack-main.js"});
  const receiver={testReceiver:true};
  const args=["https://login.example/sign-in","login-window","width=500",false];
  assert.equal(window.open.apply(receiver,args),nativeResult);
  assert.equal(calls[0].receiver,receiver);
  assert.deepEqual(calls[0].args,args);
  assert.throws(()=>window.open("throw-native"),/native error/);
  for(const target of ["_self","_top","_parent"]) assert.equal(window.open("https://popads.net/click",target),nativeResult);
  assert.equal(window.open("about:blank"),nativeResult);
  assert.equal(window.open("mailto:help@example.test"),nativeResult);
  assert.equal(window.open("https://popads.net/click","_blank"),null);
  assert.equal(reasons.at(-1),"ad-popup");
  const targetObject={toString(){return "_self";}};
  assert.equal(window.open("https://popads.net/click",targetObject),nativeResult,
    "Unknown argument forms must be left to the native API without double coercion");
  mode="off";
  assert.equal(window.open("https://popads.net/click"),nativeResult);
  mode="strict";
  assert.equal(window.open("https://login.example/sign-in"),null);
  assert.equal(reasons.at(-1),"strict-popup");
  assert.equal(window.open(`https://${host}/local`),nativeResult);
  let hrefReads = 0;
  const anchor = new context.HTMLAnchorElement();
  anchor.hasAttribute = () => true;
  Object.defineProperty(anchor, "href", { get() { hrefReads++; return "https://login.example/sign-in"; } });
  const click = { isTrusted:true, button:0, composedPath:()=>[anchor] };
  mode = "basic";
  listeners.get("click")(click);
  assert.equal(hrefReads, 0, "Basic protection must not retain explicit link addresses");
  assert.equal(timers.size, 0);
  mode = "strict";
  listeners.get("click")(click);
  assert.equal(hrefReads, 1);
  assert.equal(window.open("https://login.example/sign-in"), nativeResult);
  assert.equal(window.open("https://login.example/sign-in"), null, "An explicit click is consumed once");
  listeners.get("click")(click);
  for (const timer of timers.values()) timer();
  timers.clear();
  assert.equal(window.open("https://login.example/sign-in"), null, "The expiry timer discards the comparison address");
  mode = "off";
  listeners.get("click")(click);
  assert.equal(hrefReads, 2, "Disabled protection must not inspect clicked addresses");
  assert.doesNotMatch(JSON.stringify(reasons),/https?:|popads|login\.example/);
});

const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Offline hijack fixture</title>
<style>
body { margin:16px; font:16px sans-serif; }
.stage { position:relative; width:600px; height:260px; margin:16px 0; }
.stage video { position:absolute; inset:0; width:600px; height:260px; background:#ddd; }
.cover { position:absolute; inset:0; width:600px; height:260px; z-index:1001; }
#markerPlay { position:absolute; inset:0; width:600px; height:260px; }
#normalControls > * { display:inline-block; margin:5px; padding:8px; }
dialog[open] { position:static; }
</style></head><body>
<section class="stage" id="markerStage"><button id="markerPlay">Synthetic play</button><div class="cover" id="marker" data-cl-overlay="" style="background:transparent"></div></section>
<section class="stage"><video id="coveredMedia"></video><a class="cover" id="hostCover" href="https://popads.net/click?secret=not-logged"><span>Inert known destination</span></a></section>
<section class="stage"><video></video><button class="cover" id="largeButton">Normal click-to-play</button></section>
<section class="stage"><video></video><a class="cover" id="legitimateCover" href="https://login.example/sign-in">Normal sign-in overlay</a></section>
<section id="normalControls">
<button id="popupButton">Synthetic popup</button>
<a id="explicitPopup" href="https://login.example/sign-in" target="_blank">Explicit login link</a>
<a id="plainKnown" href="https://popcash.net/click?secret=not-logged">Known popup destination link</a>
<a id="ordinaryLink" href="https://ordinary.example/page">Normal external link</a>
<div id="googleControl" class="ea0Lbe">Normal Google-style control</div>
<span id="markedSpan" data-cl-overlay="">Not a div</span>
<dialog id="normalDialog" data-cl-overlay="" open>Normal dialog</dialog>
</section>
<script>
window.fixture = {playClicks:0, overlayClicks:0, linkClicks:0, normalClicks:0, popupUrl:'about:blank', popupTarget:'_blank', popupResult:'', conversions:0};
window.fixture.marker = document.getElementById('marker');
window.fixture.markerStyle = window.fixture.marker.getAttribute('style');
document.getElementById('markerPlay').addEventListener('click',()=>window.fixture.playClicks++);
document.getElementById('marker').addEventListener('click',()=>window.fixture.overlayClicks++);
for (const id of ['hostCover','plainKnown']) document.getElementById(id).addEventListener('click',event=>{event.preventDefault();window.fixture.linkClicks++;});
for (const id of ['largeButton','legitimateCover','ordinaryLink']) document.getElementById(id).addEventListener('click',event=>{event.preventDefault();window.fixture.normalClicks++;});
document.getElementById('popupButton').addEventListener('click',()=>{
  const result=window.open(window.fixture.popupUrl,window.fixture.popupTarget);
  window.fixture.popupResult=result===null?'blocked':'opened';
  if(result && result!==window) result.close();
});
document.getElementById('explicitPopup').addEventListener('click',event=>{
  event.preventDefault(); const result=window.open(event.currentTarget.href,'_blank');
  window.fixture.popupResult=result===null?'blocked':'opened'; if(result) result.close();
});
</script></body></html>`;

async function chromeIntegration() {
  const { chromium } = require("playwright");
  const tempRoot = fs.realpathSync(os.tmpdir());
  const prefix = "light-adblock-hijack-check-";
  const profile = fs.mkdtempSync(path.join(tempRoot, prefix));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
      headless:false, viewport:{width:1000,height:1500},
      args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`,
        "--disable-background-networking","--host-resolver-rules=MAP * ~NOTFOUND",
        "--window-position=-32000,-32000","--window-size=1000,1500"],
      ignoreDefaultArgs:["--disable-extensions"],
    });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === fixturePath && route.request().resourceType() === "document") {
        await route.fulfill({status:200,contentType:"text/html",body:fixtureHtml});
      } else if (url.hostname === host && url.pathname === "/parent") {
        await route.fulfill({status:200,contentType:"text/html",body:`<!doctype html><iframe name="fixtureFrame" style="width:900px;height:1450px" src="https://${frameHost}${fixturePath}"></iframe>`});
      } else if (route.request().resourceType() === "document") {
        await route.fulfill({status:200,contentType:"text/html",body:"<!doctype html><title>Inert local destination</title>Offline destination"});
      } else await route.abort();
    });
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker",{timeout:15000});
    const pageErrors = [];
    context.on("page", target => target.on("pageerror",error=>pageErrors.push(String(error))));
    const initialTabs = await worker.evaluate(async()=> (await chrome.tabs.query({})).map(tab=>tab.id));
    const page = await context.newPage();
    const tabId = await worker.evaluate(async previous=>(await chrome.tabs.query({})).find(tab=>!previous.includes(tab.id))?.id,initialTabs);
    assert.ok(Number.isInteger(tabId),"Fixture tab must have a Chrome tab ID");
    const extensionId = new URL(worker.url()).hostname;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const settings = {enabled:true,disabledSites:[],hijackDisabledSites:[],hijackStrictSites:[]};
    const sync = async patch => {
      Object.assign(settings,patch);
      await worker.evaluate(async value=>{
        await chrome.storage.local.set(value);
        for(let attempt=0;attempt<100;attempt++) {
          const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
          const managed = enabled.filter(id=>["easylist","ads","soop","player_compat"].includes(id));
          const ready = value.enabled ? ["easylist","soop","player_compat"].every(id=>managed.includes(id)) : managed.length===0;
          if(ready) return;
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        throw new Error('Settings not synchronized');
      },settings);
    };
    let pageToken = "";
    const command = async type => {
      const message = {type,tabId,...(type === "hijack-status" ? {} : {expectedPageToken:pageToken})};
      const result = await popup.evaluate(async value=>chrome.runtime.sendMessage(value),message);
      if(result?.ok && typeof result.pageToken === "string") pageToken=result.pageToken;
      return result;
    };
    const mode = async (expected,target=page) => target.waitForFunction(value=>document.documentElement.getAttribute('data-lae-hijack-mode')===value,expected);
    const status = async () => {
      let result;
      for(let attempt=0;attempt<30;attempt++) {
        result=await command("hijack-status");
        if(result?.ok && typeof result.active === "boolean") return result;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw new Error(`No hijack status: ${JSON.stringify(result)}`);
    };
    const visit = async ()=>{await page.goto(fixtureUrl,{waitUntil:"load"});await mode(settings.enabled && !settings.disabledSites.includes(host) && !settings.hijackDisabledSites.includes(host) ? settings.hijackStrictSites.includes(host)?"strict":"basic":"off");};
    const open = async (url,target="_blank") => {
      await page.evaluate(({url,target})=>{window.fixture.popupUrl=url;window.fixture.popupTarget=target;window.fixture.popupResult='';},{url,target});
      await page.locator("#popupButton").click();
      return page.evaluate(()=>window.fixture.popupResult);
    };
    await sync({});
    await visit();

    await test("Chromium: known marker and known-destination media overlay are hidden, with normal controls preserved",async()=>{
      await page.waitForFunction(()=>getComputedStyle(document.getElementById('marker')).display==='none');
      await page.locator("#hostCover").scrollIntoViewIfNeeded();
      await page.waitForFunction(()=>document.getElementById('hostCover').hasAttribute('data-lae-hijack-blocked'));
      assert.equal(await page.locator("#hostCover").evaluate(node=>getComputedStyle(node).display),"none");
      for(const id of ["largeButton","legitimateCover","ordinaryLink","googleControl","markedSpan","normalDialog"]) {
        assert.notEqual(await page.locator(`#${id}`).evaluate(node=>getComputedStyle(node).display),"none",id);
      }
      await page.locator("#markerStage").scrollIntoViewIfNeeded();
      const box=await page.locator("#markerStage").boundingBox();
      await page.mouse.click(box.x+50,box.y+50);
      assert.deepEqual(await page.evaluate(()=>[window.fixture.playClicks,window.fixture.overlayClicks]),[1,0]);
      assert.equal(await page.evaluate(()=>window.fixture.marker===document.getElementById('marker') && window.fixture.marker.getAttribute('style')===window.fixture.markerStyle),true);
      await page.evaluate(()=>{
        const batch=document.createElement('div');batch.id='budgetFixture';
        for(let i=0;i<120;i++){const a=document.createElement('a');a.href='https://popads.net/budget';batch.appendChild(a);}
        document.body.appendChild(batch);
      });
      await page.waitForTimeout(250);
      assert.equal(await page.locator('#hostCover').evaluate(node=>node.hasAttribute('data-lae-hijack-blocked')),true,
        'New candidates cannot exhaust the budget before an existing cover is rechecked');
      await page.locator('#budgetFixture').evaluate(node=>node.remove());
    });

    await test("Chromium: late marker insertion is protected while ordinary and direct known-destination clicks are distinguished",async()=>{
      await page.evaluate(()=>{const node=document.createElement('div');node.id='lateMarker';node.setAttribute('data-cl-overlay','');document.body.appendChild(node);});
      await page.waitForFunction(()=>getComputedStyle(document.getElementById('lateMarker')).display==='none');
      await page.locator("#plainKnown").click();
      assert.equal(await page.evaluate(()=>window.fixture.linkClicks),0);
      await page.locator("#ordinaryLink").click();
      assert.equal(await page.evaluate(()=>window.fixture.normalClicks),1);
      await page.locator("#hostCover").evaluate(node=>node.href='https://login.example/changed');
      await page.waitForFunction(()=>!document.getElementById('hostCover').hasAttribute('data-lae-hijack-blocked'));
      assert.notEqual(await page.locator("#hostCover").evaluate(node=>getComputedStyle(node).display),"none");
    });

    await test("Chromium: late player insertion and removal re-evaluate an existing known-destination overlay",async()=>{
      await page.evaluate(()=>{
        const stage=document.createElement('section');
        stage.id='lateMediaStage';stage.className='stage';
        const anchor=document.createElement('a');
        anchor.id='lateMediaCover';anchor.className='cover';
        anchor.href='https://popads.net/click';anchor.textContent='Inert late-player cover';
        stage.appendChild(anchor);document.body.appendChild(stage);
      });
      await page.locator("#lateMediaStage").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      assert.equal(await page.locator("#lateMediaCover").evaluate(node=>node.hasAttribute('data-lae-hijack-blocked')),false,
        "A destination link alone must not be classified as a media overlay");
      await page.evaluate(()=>{
        const media=document.createElement('video');media.id='lateMedia';
        document.getElementById('lateMediaStage').prepend(media);
      });
      await page.waitForFunction(()=>document.getElementById('lateMediaCover').hasAttribute('data-lae-hijack-blocked'));
      assert.equal(await page.locator("#lateMediaCover").evaluate(node=>getComputedStyle(node).display),"none");
      await page.locator("#lateMedia").evaluate(node=>node.remove());
      await page.waitForFunction(()=>!document.getElementById('lateMediaCover').hasAttribute('data-lae-hijack-blocked'));
      assert.notEqual(await page.locator("#lateMediaCover").evaluate(node=>getComputedStyle(node).display),"none");
    });

    await test("Chromium: basic mode blocks known ad popups but preserves login, same-origin, about:blank and URL conversion semantics",async()=>{
      assert.equal(await open("https://popads.net/click?secret=never-report"),"blocked",JSON.stringify({pageErrors,state:await page.evaluate(()=>({mode:document.documentElement.getAttribute('data-lae-hijack-mode'),hasClassifier:!!globalThis.__laeHijackPatterns,base:document.baseURI,classification:globalThis.__laeHijackPatterns?.classify('https://popads.net/click',document.baseURI),openSource:String(window.open).slice(0,160)}))}));
      assert.equal(await open("https://unlisted.example/popunder/in/click/123"),"blocked");
      assert.equal(await open("https://login.example/sign-in"),"opened");
      assert.equal(await open(`https://${host}/local`),"opened");
      assert.equal(await open("about:blank"),"opened");
      const conversion=await page.evaluate(()=>{
        let calls=0;const result=window.open({toString(){calls++;return 'about:blank';}},'_blank');
        if(result) result.close();return calls;
      });
      assert.equal(conversion,1,"Arguments must not be coerced twice by the wrapper");
    });

    await test("Chromium: strict popup protection is opt-in and preserves explicitly clicked matching links",async()=>{
      await sync({hijackStrictSites:[host]});await mode("strict");
      assert.equal(await open("https://login.example/sign-in"),"blocked");
      assert.equal(await open("about:blank"),"opened");
      assert.equal(await open(`https://${host}/local`),"opened");
      await page.locator("#explicitPopup").click();
      assert.equal(await page.evaluate(()=>window.fixture.popupResult),"opened");
      await sync({hijackStrictSites:[]});await mode("basic");
      assert.equal(await open("https://login.example/sign-in"),"opened");
    });

    await test("Chromium: independent site protection OFF restores overlays and popup behavior without disabling advertising filtering",async()=>{
      await sync({hijackDisabledSites:[host]});await mode("off");
      assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('lae-active')),true);
      assert.notEqual(await page.locator("#marker").evaluate(node=>getComputedStyle(node).display),"none");
      assert.equal(await page.locator("#hostCover").evaluate(node=>node.hasAttribute('data-lae-hijack-blocked')),false);
      assert.equal(await open("https://popads.net/click"),"opened");
      await sync({hijackDisabledSites:[]});await mode("basic");
      await sync({disabledSites:[host]});await mode("off");
      await page.waitForFunction(()=>!document.documentElement.classList.contains('lae-active'));
      await sync({disabledSites:[],enabled:false});await mode("off");
      await sync({enabled:true});await mode("basic");
    });

    await test("Chromium: popup status exposes bounded reason/count data only; temporary document allowance restores on request and reload",async()=>{
      await open("https://popcash.net/click?token=never-report");
      const before=await status();
      assert.equal(before.active,true);assert.ok(before.blockedCount>0);assert.ok(before.canAllowOnce);
      for(const code of before.reasonCodes) assert.ok(reasonCodes.has(code),code);
      assert.doesNotMatch(JSON.stringify(before),/https?:|never-report|secret=|token=|Cookie|hijack-fixture\.example/);
      for(const key of ["blockedCount","overlayCount","popupCount","linkCount"]) assert.ok(Number.isInteger(before[key]) && before[key]>=0 && before[key]<=100000,key);
      assert.equal((await command("hijack-allow-once")).ok,true);await mode("off");
      assert.equal((await status()).temporarilyAllowed,true);
      assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('lae-active')),true);
      assert.equal(await open("https://popcash.net/click"),"opened");
      assert.equal((await command("hijack-restore")).ok,true);await mode("basic");
      assert.equal(await open("https://popcash.net/click"),"blocked");
      await command("hijack-allow-once");await mode("off");
      const oldPageToken=pageToken;
      await visit();assert.equal((await status()).temporarilyAllowed,false);
      const stale=await popup.evaluate(async message=>chrome.runtime.sendMessage(message),{type:"hijack-allow-once",tabId,expectedPageToken:oldPageToken});
      assert.equal(stale.ok,false,"A command for a previous document must not disable a new page");
      await mode("basic");
    });

    await test("Chromium: cross-origin frame reports join the tab and follow top-level settings and temporary allowance",async()=>{
      await page.goto(`https://${host}/parent`,{waitUntil:"load"});
      const frame=page.frame({name:"fixtureFrame"});assert.ok(frame);
      await mode("basic",frame);
      await frame.waitForFunction(()=>getComputedStyle(document.getElementById('marker')).display==='none');
      assert.ok((await status()).overlayCount>0);
      await sync({hijackDisabledSites:[host]});await mode("off",frame);
      await frame.waitForFunction(()=>getComputedStyle(document.getElementById('marker')).display!=='none');
      await sync({hijackDisabledSites:[]});await mode("basic",frame);
      await command("hijack-allow-once");await mode("off",frame);
      await command("hijack-restore");await mode("basic",frame);
    });

    await test("Chromium: feature stores only site preferences, never destination history or synthetic secrets",async()=>{
      const stored=await worker.evaluate(async()=>chrome.storage.local.get(null));
      assert.doesNotMatch(JSON.stringify(stored),/never-report|secret=|token=|popads\.net|popcash\.net/);
      await popup.goto(`chrome-extension://${extensionId}/popup/popup.html?not-the-popup`);
      const untrusted=await popup.evaluate(async id=>chrome.runtime.sendMessage({type:'hijack-allow-once',tabId:id}),tabId);
      assert.equal(untrusted?.ok,false,"Only the actual popup may grant a temporary allowance");
    });
  } finally {
    await context?.close();
    const resolved=path.resolve(profile);
    if(path.dirname(resolved)!==tempRoot || !path.basename(resolved).startsWith(prefix)) throw new Error("Refusing unexpected profile cleanup path");
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}

if(process.argv.includes("--chrome")) await chromeIntegration();
console.log(`Hijack checks complete: ${passed} groups passed${process.argv.includes("--chrome") ? " (offline Chromium integration)" : " (add --chrome for offline Chromium integration)"}`);
