// Offline regressions for the 2026-10-10 audit. Runs compiled production paths.
// Run npm run compile first. Uses only synthetic credentials and mocked transports.
// Auth sync and telemetry are disabled; temporary solution files are cleaned up.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const repo = path.resolve(__dirname, '..');
const { performance } = require('perf_hooks');
const auditTempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'authy-code-audit-'));
const testDeadline = setTimeout(()=>{fs.rmSync(auditTempDir,{recursive:true,force:true});console.error('Audit regression timed out.');process.exit(1);},10000);
require(path.join(repo, 'src/test/support/register-vscode.js'));
const load = p => require(path.join(repo, 'out/src', p));
const { globalState } = load('globalState.js');
const realRequestJson = load('request/leetcode-http.js').requestJson;
const realFetchUserStatus = load('request/leetcode-api.js').fetchUserStatus;
const key = 'leetcode-auth-session-v1';
const identity = name => ({isSignedIn:true, isPremium:false, username:name, avatar:''});
const cookie = name => Object.entries({LEETCODE_SESSION:`fake-${name}`,csrftoken:`fake-${name}`})
  .map(([key,value])=>`${key}=${value}`).join('; ');
const signedIn = name => ({version:1,revision:10,state:'signed-in',intentionalSignOut:false,cookie:cookie(name),identity:identity(name)});
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise,resolve}; };
function storage(seed) {
  const values = new Map([[key, JSON.stringify(seed)]]);
  const listeners = [];
  return {
    values,
    get: async k => values.get(k),
    store: async (k,v) => {values.set(k,v); listeners.slice().forEach(f=>f({key:k}));},
    delete: async k => values.delete(k),
    onDidChange: f => {listeners.push(f);return {dispose(){}};},
    fire: () => listeners.slice().forEach(f=>f({key})),
  };
}
function context(secrets) {
  const values = new Map();
  return {secrets,subscriptions:[],globalState:{get:k=>values.get(k),update:async(k,v)=>values.set(k,v)},asAbsolutePath:p=>path.join(repo,p)};
}
async function authHydrationRaces() {
  const State = globalState.constructor;
  const s = storage(signedIn('a'));
  const g = new State();
  await g.initialize(context(s));
  const gate = deferred();
  let firstRead = true;
  s.get = async k => k === key && firstRead ? (firstRead=false, gate.promise) : s.values.get(k);
  s.fire();
  await g.setSignedOutSession(true);
  gate.resolve(JSON.stringify(signedIn('a')));
  await tick();
  assert.equal(g.getAuthSession().state, 'signed-out');
  assert.equal(JSON.parse(s.values.get(key)).state, 'signed-out');
  console.log('Stale hydration cannot undo durable sign-out.');

  const s2 = storage(signedIn('a'));
  const g2 = new State();
  await g2.initialize(context(s2));
  const writeGate = deferred();
  s2.store = async(k,v) => {s2.values.set(k,v);s2.fire();await writeGate.promise;};
  const write = g2.setSignedInSession(cookie('local'), identity('local'));
  await tick();
  s2.values.set(key,JSON.stringify({...signedIn('remote'),revision:99}));
  s2.fire();
  writeGate.resolve();
  await assert.rejects(write, /another window/);
  assert.equal(g2.getAuthSession().identity.username, 'remote');
  assert.equal(JSON.parse(s2.values.get(key)).identity.username, 'remote');
  console.log('Pending local stores reconcile sibling writes.');
}
async function catalogInvalidation() {
  const {ExplorerNodeManager} = load('explorer/explorerNodeManager.js');
  const {defaultProblem} = load('shared.js');
  const gate = deferred();
  const m = new ExplorerNodeManager(()=>gate.promise);
  const pending = m.refreshCache();
  m.invalidate();
  gate.resolve({kind:'success',problems:[{...defaultProblem,id:'1',name:'old account',titleSlug:'two-sum'}]});
  await pending;
  assert.equal(m.getNodeById('1'), undefined);
  console.log('Invalidated catalogs discard old completions.');
}
async function activationAuthEffects() {
  const vscode = require('vscode');
  const disposable = () => ({dispose(){}});
  global.__LC_TEST_CONFIG__ = {'authSync.enabled':false};
  vscode.commands = {executeCommand:async()=>undefined,registerCommand:disposable};
  Object.assign(vscode.window, {
    createTreeView:()=>({dispose(){},onDidChangeVisibility:disposable}),
    registerUriHandler:disposable,onDidChangeActiveTextEditor:disposable,
  });
  vscode.workspace.onDidSaveTextDocument = disposable;
  const s = storage({version:1,revision:1,state:'signed-out',intentionalSignOut:false});
  const {activate} = load('extension.js');
  await activate(context(s));
  const api = load('request/leetcode-api.js');
  api.fetchUserStatus = async c => identity(c.includes('fake-b')?'b':'a');
  const {leetCodeManager} = load('leetCodeManager.js');
  const {explorerNodeManager} = load('explorer/explorerNodeManager.js');
  const {leetCodeProfileProvider} = load('webview/leetCodeProfileProvider.js');
  const {defaultProblem} = load('shared.js');
  await leetCodeManager.updateSessionFromCookie(cookie('a'));
  explorerNodeManager.problemLoader = async()=>({kind:'success',problems:[{...defaultProblem,id:'1',name:'account-a catalog',titleSlug:'two-sum'}]});
  await explorerNodeManager.refreshCache();
  leetCodeProfileProvider.panel = {webview:{html:'account-a profile'}};
  await leetCodeManager.signOut();
  assert.notEqual(leetCodeProfileProvider.panel.webview.html,'account-a profile');
  assert.equal(explorerNodeManager.getNodeById('1'), undefined);
  const opened = [];
  const sections = [], completed = [];
  leetCodeProfileProvider.open = initial => opened.push(initial.username);
  for (const method of ['fetchProfileIdentity','fetchProfileStats','fetchProfileRecent','fetchProfileLanguages']) api[method] = async()=>{const gate=deferred(); sections.push(gate); return gate.promise;};
  for (const method of ['updateIdentity','updateStats','updateRecent','updateLanguages']) leetCodeProfileProvider[method] = ()=>completed.push(method);
  await leetCodeManager.updateSessionFromCookie(cookie('b'));
  assert.equal(explorerNodeManager.getNodeById('1'), undefined);
  assert.deepEqual(opened, ['b']);
  await leetCodeManager.updateSyncedBrowserData(cookie('b'),'rotated-agent');
  assert.deepEqual(opened, ['b','b']);
  sections.slice(4).forEach(g=>g.resolve({})); await tick();
  assert.equal(completed.length,4,'replacement profile sections must reach terminal state');
  sections.slice(0,4).forEach(g=>g.resolve({})); await tick();
  assert.equal(completed.length,4,'obsolete sections must not overwrite the replacement');
  console.log('Local auth transitions clear and replace profile sections.');
}
async function favoriteOwnership() {
  const http = load('request/leetcode-http.js');
  const api = load('request/leetcode-api.js');
  const gate = deferred();
  const calls = [];
  http.requestJson = async(config, ctx) => {
    calls.push({label:ctx.label,account:config.headers.Cookie.includes('fake-a')?'a':'b',list:config.data.variables.favoriteSlug});
    if (ctx.label === 'favorites lists') return gate.promise;
    return {data:{addQuestionToFavoriteV2:{ok:true}}};
  };
  await globalState.setSignedInSession(cookie('a'), identity('a'));
  const op = api.addFavoriteQuestion('two-sum');
  await globalState.setSignedInSession(cookie('b'), identity('b'));
  gate.resolve({data:{favoritesLists:{allFavorites:[{idHash:'list-a',name:'Favorite'}]}}});
  await assert.rejects(op, /cancelled/);
  assert.deepEqual(calls.map(c=>c.account),['a']);
  await globalState.setSignedInSession(cookie('a'),identity('a'));
  const mutationGate = deferred(); let mutationStarted = false;
  http.requestJson = async(config,ctx) => {
    if (ctx.label === 'favorites lists') return {data:{favoritesLists:{allFavorites:[{idHash:'list-a',name:'Favorite'}]}}};
    mutationStarted = true;
    assert.equal(config.headers.Cookie,cookie('a'));
    return mutationGate.promise;
  };
  const mutation = api.addFavoriteQuestion('two-sum');
  while(!mutationStarted) await tick();
  await globalState.setSignedInSession(cookie('b'),identity('b'));
  mutationGate.resolve({data:{addQuestionToFavoriteV2:{ok:true}}});
  await assert.rejects(mutation,/cancelled/);
  console.log('Favorite lookups and mutation completions retain one owner.');
}
async function judgeAfterAccountChange() {
  const http = load('request/leetcode-http.js');
  const {submitSolutionWithSyncedCookie} = load('request/submit-solution.js');
  const gate = deferred();
  let polling = false;
  let metadataRequests = 0;
  let metadataHasCancelToken = false;
  http.requestJson = realRequestJson;
  const axios = require(path.join(repo,'node_modules/axios/dist/node/axios.cjs'));
  const originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async config => {
    let data;
    if(/\/graphql\/?$/.test(config.url)) {
      metadataRequests++;
      metadataHasCancelToken = !!config.cancelToken;
      data = {data:{question:{questionId:'1',titleSlug:'two-sum'}}};
    }
    else if(config.url.endsWith('/submit/')) data = {submission_id:7};
    else {polling = true; data = await gate.promise;}
    return {data,status:200,statusText:'OK',headers:{},config};
  };
  const file = path.join(auditTempDir, 'solution.cpp');
  fs.writeFileSync(file,'// @lc app=leetcode id=1 lang=cpp\n// https://leetcode.com/problems/two-sum/\n// @lc code=start\nclass Solution {};\n// @lc code=end');
  await globalState.setSignedInSession(cookie('a'), identity('a'));
  const op = submitSolutionWithSyncedCookie(file,()=>false);
  while(!polling) await tick();
  await globalState.setSignedInSession(cookie('b'), identity('b'));
  gate.resolve({state:'SUCCESS',run_success:true,status_msg:'Accepted'});
  await assert.rejects(op, /cancelled/);
  console.log('Account rotation suppresses obsolete judge results.');
  const beforeCancelledOperation = metadataRequests;
  await assert.rejects(submitSolutionWithSyncedCookie(file,()=>true),/cancelled/);
  assert.equal(metadataRequests,beforeCancelledOperation);
  assert.equal(metadataHasCancelToken,true);
  console.log('Already-cancelled judge work sends no metadata request.');
  axios.defaults.adapter = originalAdapter;
  fs.unlinkSync(file);
}
async function judgeStageCancellation() {
  load('request/leetcode-http.js').requestJson = realRequestJson;
  const {submitSolutionWithSyncedCookie} = load('request/submit-solution.js');
  const {testSolutionWithSyncedCookie} = load('request/test-solution.js');
  const axios = require(path.join(repo,'node_modules/axios/dist/node/axios.cjs'));
  const originalAdapter = axios.defaults.adapter;
  const file = path.join(auditTempDir,'stages.cpp');
  fs.writeFileSync(file,'// @lc app=leetcode id=1 lang=cpp\n// https://leetcode.com/problems/two-sum/\n// @lc code=start\nclass Solution {};\n// @lc code=end');
  let cases = 0;
  try {
    for (const workflow of ['submit','test']) for (const stage of workflow === 'submit' ? ['metadata','enqueue','poll'] : ['metadata','enqueue','poll','expected']) {
      for (const change of ['cancel','account','endpoint']) {
        global.__LC_TEST_CONFIG__.endpoint = 'leetcode';
        await globalState.setSignedInSession(cookie('a'),identity('a'));
        const entered = deferred(); let cancelled = false; let requests = 0;
        axios.defaults.adapter = config => {
          requests++;
          const current = /\/graphql\/?$/.test(config.url) ? 'metadata' : /\/submit\/$|\/interpret_solution\/$/.test(config.url) ? 'enqueue' : /\/8\/check\/$/.test(config.url) ? 'expected' : 'poll';
          assert.equal(new URL(config.url).hostname,'leetcode.com');
          assert.equal(config.headers.Cookie,cookie('a'));
          if (current === stage) {
            entered.resolve();
            return new Promise((_resolve,reject)=>config.cancelToken.promise.then(reject));
          }
          const data = current === 'metadata' ? {data:{question:{questionId:'1',enableRunCode:true,exampleTestcases:'[1,2]',titleSlug:'two-sum'}}}
            : current === 'enqueue' ? {submission_id:7,interpret_id:'7',interpret_expected_id:'8'}
            : {state:'SUCCESS',run_success:true,status_msg:'Accepted'};
          return Promise.resolve({data,status:200,statusText:'OK',headers:{},config});
        };
        const operation = workflow === 'submit' ? submitSolutionWithSyncedCookie(file,()=>cancelled) : testSolutionWithSyncedCookie(file,undefined,()=>cancelled);
        await entered.promise;
        const before = requests;
        if (change === 'cancel') cancelled = true;
        else if (change === 'account') await globalState.setSignedOutSession(true);
        else global.__LC_TEST_CONFIG__.endpoint = 'leetcode-cn';
        await assert.rejects(operation,error=>error.name === 'OperationCancelledError');
        assert.equal(requests,before,'cancelled workflow must send no later-stage request');
        cases++;
      }
    }
  } finally {axios.defaults.adapter=originalAdapter;global.__LC_TEST_CONFIG__.endpoint='leetcode';}
  await globalState.setSignedInSession(cookie('a'),identity('a'));
  console.log(`Judge stage cancellation passed (${cases} interleavings).`);
}
async function malformedGraphql() {
  const http = load('request/leetcode-http.js');
  const api = load('request/leetcode-api.js');
  http.requestJson = async()=>({data:{}});
  await assert.rejects(api.listProblems(), /malformed/);
  const item = n => ({frontendQuestionId:String(n),questionId:String(n),titleSlug:`question-${n}`,title:`Question ${n}`,difficulty:'Easy',acRate:50});
  const pages = mode => async config => {
    if (config.method === 'GET') return {};
    const {categorySlug,skip} = config.data.variables;
    if (categorySlug !== 'algorithms' || mode === 'empty') return {data:{problemsetQuestionList:{total:0,questions:[]}}};
    const start = mode === 'repeated' ? 0 : skip;
    const count = skip === 0 ? 100 : mode === 'truncated' ? 20 : 50;
    return {data:{problemsetQuestionList:{total:mode === 'invalid-total' ? -1 : 150,questions:Array.from({length:count},(_,n)=>item(start+n))}}};
  };
  for (const mode of ['repeated','truncated','invalid-total']) {
    http.requestJson = pages(mode);
    await assert.rejects(api.listProblems(), /pagination|total/);
  }
  http.requestJson = pages('empty');
  assert.deepEqual(await api.listProblems(), []);
  http.requestJson = pages('valid');
  assert.equal((await api.listProblems()).length,150);
  console.log('Catalog schema, empty, repeated, and truncated page checks passed.');
}
async function browserCaptureAndResponse() {
  const values = {enabled:true,devMode:true,lastSyncAt:0};
  const cookieGate = deferred();
  let cookies = ()=>cookieGate.promise;
  const browser = {
    storage:{local:{get:async defaults=>({...defaults,...values}),set:async data=>Object.assign(values,data)}},
    cookies:{getAll:query=>cookies(query)},
    runtime:{onMessage:{addListener(){}}},
    webRequest:{onBeforeSendHeaders:{hasListener(){return false;},addListener(){}}},
  };
  let responseText = '<html>Unrelated service</html>';
  const sandbox = vm.createContext({browser,console,Promise,Map,Set,Date,TextEncoder,AbortController,crypto:require('crypto').webcrypto,setTimeout,clearTimeout,navigator:{userAgent:'audit'},fetch:async()=>({ok:true,status:200,text:async()=>responseText})});
  vm.runInContext(fs.readFileSync(path.join(repo,'browser-extension/background.js'),'utf8'),sandbox);
  const capture = vm.runInContext('captureDevPayloadNow()',sandbox);
  await tick();
  await vm.runInContext('saveSettings({enabled:true,devMode:false})',sandbox);
  assert.equal(values.devCapturedPayload,null);
  cookieGate.resolve([{name:'LEETCODE_SESSION',value:'audit-fake',domain:'.leetcode.com',path:'/'}]);
  await capture;
  assert.equal(values.devMode,false);
  assert.equal(values.devCapturedPayload,null);
  console.log('Disabled Developer mode discards pending capture.');
  cookies = async()=>[{name:'LEETCODE_SESSION',value:'audit-fake',domain:'.leetcode.com',path:'/'}];
  const sync = await vm.runInContext('syncNow("manual")',sandbox);
  assert.equal(sync.ok,false);
  assert.equal(values.lastSyncAt,0);
  for (const invalid of ['', 'null', '[]', '{}', '{"ok":false}', '{"ok":"true"}']) {
    responseText = invalid;
    const result = await vm.runInContext('syncNow("manual")',sandbox);
    assert.equal(result.ok,false,invalid);
    assert.equal(values.lastSyncAt,0,invalid);
  }
  responseText = '{"ok":true}';
  assert.equal((await vm.runInContext('syncNow("manual")',sandbox)).ok,true);
  assert(values.lastSyncAt>0);
  await vm.runInContext('saveSettings({enabled:true,devMode:true})',sandbox);
  const clearGate = deferred(); cookies = ()=>clearGate.promise;
  const pendingClear = vm.runInContext('captureDevPayloadNow()',sandbox);
  await tick(); await vm.runInContext('clearDevPayload()',sandbox);
  clearGate.resolve([{name:'LEETCODE_SESSION',value:'synthetic',domain:'.leetcode.com',path:'/'}]);
  assert.equal((await pendingClear).ok,false);
  assert.equal(values.devCapturedPayload,null);
  const autoGate = deferred(); cookies = ()=>autoGate.promise;
  const automatic = vm.runInContext('syncNow("manual")',sandbox);
  await tick(); await vm.runInContext('saveSettings({enabled:true,devMode:false})',sandbox);
  autoGate.resolve([{name:'LEETCODE_SESSION',value:'synthetic',domain:'.leetcode.com',path:'/'}]);
  await automatic; assert.equal(values.devCapturedPayload,null);
  await vm.runInContext('saveSettings({enabled:true,devMode:true})',sandbox);
  cookies = async()=>[{name:'LEETCODE_SESSION',value:'synthetic',domain:'.leetcode.com',path:'/'}];
  const validCapture = await vm.runInContext('captureDevPayloadNow()',sandbox);
  assert.equal(validCapture.ok,true);
  assert.equal(validCapture.capturedAt,values.devCapturedAt);
  assert.deepEqual(validCapture.payload,values.devCapturedPayload);
  console.log('Browser cleanup races and strict sync replies passed.');
}
async function markdownCost() {
  const {markdownEngine} = load('webview/markdownEngine.js');
  for(const n of [5000,10000,100000]) {
    const text = 'a@b.co\n'.repeat(n);
    const start = performance.now();
    markdownEngine.render(text,{});
    const elapsed = performance.now()-start;
    assert(elapsed < 3000,'soft-broken email paragraphs must render within the offline smoke budget');
    console.log(`MARKDOWN: ${Buffer.byteLength(text)} bytes rendered synchronously in ${Math.round(elapsed)} ms`);
  }
}
async function sqlMarkers() {
  const {generateSolutionFileContent} = load('utils/solutionFileGenerator.js');
  const {extractSolutionCode} = load('utils/solutionDocument.js');
  const content = generateSolutionFileContent({detail:{title:'SQL example',titleSlug:'sql-example',codeSnippets:[{langSlug:'mysql',code:'SELECT 1;'}]},language:'mysql',frontendId:'1',showDescriptionInComment:false,endpointBase:'https://leetcode.com'});
  const full = `${content}\nSELECT 'outside markers';`;
  assert.equal(extractSolutionCode(full).trim(),'SELECT 1;');
  console.log('Generated MySQL markers isolate the submitted body.');
}
async function authTransportBudget() {
  const http = load('request/leetcode-http.js');
  http.requestJson = realRequestJson;
  const axios = require(path.join(repo,'node_modules/axios/dist/node/axios.cjs'));
  const cp = require('child_process');
  const {EventEmitter} = require('events');
  const originalAdapter = axios.defaults.adapter;
  const originalExecFile = cp.execFile;
  let fallbackBudget = Infinity;
  axios.defaults.adapter = async config => {
    await new Promise(r=>setTimeout(r,25));
    return {data:'<title>Just a moment...</title>',status:503,statusText:'Unavailable',headers:{},config};
  };
  cp.execFile = (command,args,options,callback) => {
    const child = new EventEmitter();
    child.kill = ()=>true;
    child.stdin = {on(){},end(config){
      fallbackBudget = Number(config.split('\n').find(line=>line.startsWith('max-time ')).slice('max-time '.length))*1000;
      const line = config.split('\n').find(line=>line.startsWith('write-out '));
      const marker = JSON.parse(line.slice('write-out '.length)).replace('%{http_code}','');
      setTimeout(()=>callback(null,JSON.stringify({data:{userStatus:identity('a')}})+marker+'200',''),35);
    }};
    return child;
  };
  try {
    const start = performance.now();
    await assert.rejects(realFetchUserStatus(cookie('a'),'audit',{},50), /timed out/);
    const elapsed = performance.now()-start;
    assert(elapsed < 125);
    assert(fallbackBudget>0 && fallbackBudget<50,'curl receives only the remaining budget');
    console.log(`Auth deadline regression passed (${Math.round(elapsed)} ms).`);
  } finally {
    axios.defaults.adapter = originalAdapter;
    cp.execFile = originalExecFile;
  }
}
async function queuedSyncExpiry() {
  const {EventEmitter} = require('events');
  const {authSyncServer} = load('auth/authSyncServer.js');
  const server = new authSyncServer.constructor();
  const gate = deferred();
  server.readJsonBody = async()=>({cookie:cookie('a')});
  server.enqueueAuthUpdate = async work=>{await gate.promise; return work();};
  const req = new EventEmitter(); Object.assign(req,{method:'POST',url:'/auth/update',headers:{}});
  const res = new EventEmitter(); Object.assign(res,{headersSent:false,writableEnded:false,destroyed:false,setHeader(){},end(body){this.body=body;this.writableEnded=true;this.headersSent=true;}});
  const oldNow = Date.now, oldTimeout = global.setTimeout;
  let now = oldNow(); Date.now = ()=>now;
  global.setTimeout = (work,ms,...args)=>oldTimeout(()=>{now+=ms;work(...args);},ms>=30000?5:ms);
  const before = globalState.getAuthSession().revision;
  try {
    const request = server.handleRequest(req,res);
    await new Promise(resolve=>oldTimeout(resolve,15));
    assert.equal(res.statusCode,504); assert.equal(res.writableEnded,true);
    gate.resolve(); await request;
    assert.equal(globalState.getAuthSession().revision,before);
  } finally {Date.now=oldNow; global.setTimeout=oldTimeout;gate.resolve();}
  console.log('Queued auth-sync expiry ends the response and preserves the session.');
}
async function disconnectedValidation() {
  const axios = require(path.join(repo,'node_modules/axios/dist/node/axios.cjs'));
  const originalAdapter = axios.defaults.adapter;
  let disconnected = false;
  axios.defaults.adapter = config=>new Promise((_resolve,reject)=>config.cancelToken.promise.then(reject));
  try {
    const operation = realFetchUserStatus(cookie('a'),'audit',{},500,{deadlineAt:Date.now()+500,isCancelled:()=>disconnected});
    setTimeout(()=>disconnected=true,5);
    await assert.rejects(operation,/cancelled/);
  } finally {axios.defaults.adapter=originalAdapter;}
  console.log('Disconnected auth validation aborts its transport.');
}
(async()=>{
  await authHydrationRaces(); await catalogInvalidation(); await activationAuthEffects();
  await favoriteOwnership(); await judgeAfterAccountChange(); await malformedGraphql();
  await judgeStageCancellation();
  await browserCaptureAndResponse(); await markdownCost(); await sqlMarkers(); await authTransportBudget();
  await queuedSyncExpiry(); await disconnectedValidation();
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{clearTimeout(testDeadline);fs.rmSync(auditTempDir,{recursive:true,force:true});});

