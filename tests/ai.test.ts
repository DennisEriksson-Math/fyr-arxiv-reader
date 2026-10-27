import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sanitizePapers,parseArray,validateAnalysis,analyzePapers} from '../lib/ai.ts';
import {defaultProfile} from '../lib/arxiv.ts';
const paper={id:'2610.12345v2',base_id:'2610.12345',title:'Hodge theory of curves',abstract:'A useful Hodge filtration.',authors:['Ada Lovelace'],published:'2026-10-20',updated:'2026-10-21',categories:['math.AG']};
test('AI inputs retain valid public IDs, bound strings and reject links/duplicates',()=>{
 const values=sanitizePapers([paper,{...paper,id:'2610.12345v3'},{...paper,id:'https://example.com'}]);
 assert.equal(values.length,1);assert.equal(values[0].base_id,'2610.12345');
});
test('AI output cannot invent IDs or exceed bounds',()=>{
 const values=parseArray('```json\n[{"id":"2610.12345v2","summary":"A"},{"id":"2610.12345v2"},{"id":"made-up"}]\n```');
 const validated=validateAnalysis(values,new Set([paper.id]),20);assert.equal(validated.length,1);assert.equal(validated[0].summary,'A');
});
test('failed AI preserves usable deterministic workflow with explicit warning',async()=>{
 const profile={...defaultProfile(),sharp:['Hodge theory']};
 const result=await analyzePapers(profile,[paper],20,async()=>{throw new Error('unavailable')});
 assert.deepEqual(result.papers,[]);assert.match(result.warning,/failed/i);
});
test('semantic scout cannot select excluded papers and uses only unmatched titles',async()=>{
 const profile={...defaultProfile(),sharp:['Hodge theory'],negative:['excluded']};
 const other={...paper,id:'2610.12346v1',base_id:'2610.12346',title:'Unexpected method',abstract:'A useful transferable method.'};
 const excluded={...other,id:'2610.12347',base_id:'2610.12347',title:'Excluded method'};
 let calls=0;
 const result=await analyzePapers(profile,[paper,other,excluded],20,async(_,input)=>{
  calls++;const data=JSON.parse(input);assert.ok(!input.includes('2610.12347'));
  if(data.candidates)return {text:JSON.stringify([{id:other.id,connection:'A method to inspect'},{id:excluded.id,connection:'bad'}]),input:100,output:30};
  return {text:JSON.stringify(data.papers.map((p:{id:string})=>({id:p.id,summary:'Abstract-based note',why:'Relevant method',priority:'medium'}))),input:100,output:30};
 });
 assert.equal(calls,2);assert.equal(result.semantic.length,1);assert.equal(result.papers.length,2);
});
