import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bridgeOrigin,modelName} from '../lib/model-connection.ts';
import {analyzeWithConnection,checkConnection} from '../lib/ai-browser.ts';
import {analyzePapers} from '../lib/ai.ts';
import {defaultProfile} from '../lib/arxiv.ts';
const paper={id:'2610.12345',base_id:'2610.12345',title:'Hodge theory',abstract:'We study Hodge theory.',authors:['Ada Lovelace'],published:'2026-10-20',updated:'2026-10-20',categories:['math.AG']};
const profile={...defaultProfile(),sharp:['Hodge theory'],sources:[{kind:'keyword' as const,value:'Hodge theory',documents:[{name:'private-manuscript.tex',excerpt:'A confidential unpublished source passage.'}]}]};
const connection={provider:'bridge' as const,key:'',model:'',bridgeUrl:'http://127.0.0.1:8790',bridgeToken:'test-session-token-abcdefghijkl'};

test('bridge credentials are restricted to exact loopback origins',()=>{
 assert.equal(bridgeOrigin('http://127.0.0.1:8790/'),'http://127.0.0.1:8790');
 assert.equal(bridgeOrigin('http://[::1]:8790'),'http://[::1]:8790');
 for(const value of ['https://example.com','http://localhost.example.com','http://127.0.0.2','http://localhost:8790/redirect','http://secret@localhost:8790','http://localhost:8790?to=remote','javascript:alert(1)'])assert.throws(()=>bridgeOrigin(value));
 assert.equal(modelName('mlx-community/Qwen-9B'),'mlx-community/Qwen-9B');
 assert.equal(modelName('local/model@q4+instruct'),'local/model@q4+instruct');
 assert.throws(()=>modelName('--tools'));
 assert.throws(()=>modelName('model\n--tools=bash'));
});

test('local file names and source excerpts never enter model input',async()=>{
 let calls=0;
 await analyzePapers(profile,[paper],20,async(instructions,input)=>{calls++;assert.doesNotMatch(input,/private-manuscript|confidential unpublished|"sources"/);assert.match(input,/Hodge theory/);return {text:JSON.stringify([{id:paper.id,summary:'A note',why:'Hodge theory matches your interest.'}]),input:1,output:1};});
 assert.equal(calls,1);
});

test('bridge analysis uses authenticated fixed endpoint and validated response',async()=>{
 const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;assert.equal(String(url),'http://127.0.0.1:8790/api/respond');assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer '+connection.bridgeToken);const body=JSON.parse(String(init?.body));assert.equal(body.maxTokens,12000);assert.equal(body.model,undefined);assert.doesNotMatch(body.input,/confidential unpublished|private-manuscript/);return new Response(JSON.stringify({text:JSON.stringify([{id:paper.id,summary:'Rendered $H^1(X)$.',why:'A direct Hodge-theory connection.'}]),input:20,output:40}),{status:200});};
 try{const result=await analyzeWithConnection({connection,profile,papers:[paper]});assert.equal(calls,1);assert.equal(result.papers.length,1);assert.equal(result.papers[0].id,paper.id);}finally{globalThis.fetch=old;}
});

test('connection check validates token without requesting inference',async()=>{
 const old=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{assert.equal(String(url),'http://127.0.0.1:8790/api/health');assert.equal(init?.method,undefined);return new Response(JSON.stringify({provider:'claude',model:'sonnet',authenticated:true}),{status:200});};
 try{assert.match(await checkConnection(connection),/Connected to claude/);globalThis.fetch=async()=>new Response(JSON.stringify({authenticated:false}),{status:200});await assert.rejects(checkConnection(connection),/token was not accepted/);}finally{globalThis.fetch=old;}
});
