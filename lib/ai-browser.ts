import {analyzePapers, sanitizePapers} from './ai';
import type {Profile,Paper} from './types';

/** The user's key is used directly with OpenAI, and is never persisted. */
export async function analyzeWithKey(options:{key:string;model:string;profile:Profile;papers:Paper[];shortlistSize?:number}){
  const key=options.key.trim();const model=options.model.trim()||'gpt-5-mini';
  if(key.length<20||key.length>512||/[\r\n]/.test(key))throw new Error('Enter a valid OpenAI API key.');
  if(!/^[a-zA-Z0-9._:\-]{1,100}$/.test(model))throw new Error('Enter a valid model name.');
  return analyzePapers(options.profile,sanitizePapers(options.papers),Math.max(5,Math.min(20,options.shortlistSize??20)),async(instructions,input,maxTokens)=>{
    const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,instructions,input,max_output_tokens:maxTokens,store:false}),signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw new Error(response.status===401?'The API key was rejected.':response.status===429?'Check API credit and rate limits.':'The provider could not complete this request.');
    const data=await response.json() as {output?:Array<{content?:Array<{type:string;text?:string}>}>;usage?:{input_tokens?:number;output_tokens?:number}};
    const text=(data.output??[]).flatMap(o=>o.content??[]).filter(c=>c.type==='output_text').map(c=>c.text??'').join('\n');
    if(!text)throw new Error('The model returned no readable result.');
    return {text,input:data.usage?.input_tokens??null,output:data.usage?.output_tokens??null};
  });
}
