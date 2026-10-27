import {analyzePapers,sanitizePapers} from './ai.ts';
import {bridgeOrigin,modelName,type ModelConnection} from './model-connection.ts';
import type {Profile,Paper} from './types';
export {defaultConnection,type ModelConnection} from './model-connection.ts';

function key(value:string,bridge=false){
 const clean=value.trim();
 if(clean.length<(bridge?16:20)||clean.length>512||/[\r\n]/.test(clean))throw new Error(bridge?'Paste the session token printed by your local bridge.':'Enter a valid OpenAI API key.');
 return clean;
}
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function failure(response:Response,bridge=false){
 return new Error(response.status===401?(bridge?'The bridge token was rejected. Copy the current token from its terminal.':'The API key was rejected.'):response.status===429?'The provider is busy or rate-limited. Try again shortly.':bridge?'The local bridge could not complete this request. Check its terminal.':'The provider could not complete this request. Check your model and API credit.');
}

export async function checkConnection(connection:ModelConnection):Promise<string>{
 const bridge=connection.provider==='bridge';
 const secret=key(bridge?connection.bridgeToken:connection.key,bridge);
 const url=bridge?bridgeOrigin(connection.bridgeUrl)+'/api/health':'https://api.openai.com/v1/models/'+encodeURIComponent(modelName(connection.model)||'gpt-5-mini');
 let response:Response;
 try{response=await fetch(url,{headers:{Authorization:`Bearer ${secret}`},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)})}catch{throw new Error(bridge?'Could not reach the local bridge. Start it and open the local URL printed in its terminal if your browser blocks this connection.':'Could not reach OpenAI. Check your internet connection.');}
 if(!response.ok)throw failure(response,bridge);
 const data=object(await response.json());
 if(bridge&&data.authenticated!==true)throw new Error('Bridge reached, but the session token was not accepted.');
 return bridge?`Connected to ${String(data.provider||'local bridge')}${data.model?` · ${String(data.model)}`:''}.`:'API key and model are available.';
}

/** Model requests contain interests and public abstracts; imported source passages stay local. */
export async function analyzeWithConnection(options:{connection:ModelConnection;profile:Profile;papers:Paper[];shortlistSize?:number}){
 const {connection}=options;const bridge=connection.provider==='bridge';
 const secret=key(bridge?connection.bridgeToken:connection.key,bridge);
 const model=modelName(connection.model)||(bridge?'':'gpt-5-mini');
 const base=bridge?bridgeOrigin(connection.bridgeUrl):'';
 return analyzePapers(options.profile,sanitizePapers(options.papers),Math.max(5,Math.min(20,options.shortlistSize??20)),async(instructions,input,maxTokens)=>{
  const body=bridge?{instructions,input,maxTokens,...(model?{model}:{})}:{model,instructions,input,max_output_tokens:maxTokens,store:false};
  let response:Response;
  try{response=await fetch(bridge?base+'/api/respond':'https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit',redirect:'error',signal:AbortSignal.timeout(bridge?315000:120000)})}catch{throw new Error(bridge?'Could not reach the local bridge. Check its terminal and try the local app address.':'The model request could not finish. Check the connection and try again.');}
  if(!response.ok)throw failure(response,bridge);
  const data=object(await response.json());
  if(bridge){if(typeof data.text!=='string'||!data.text.trim())throw new Error('The local model returned no readable result.');return {text:data.text,input:typeof data.input==='number'?data.input:null,output:typeof data.output==='number'?data.output:null};}
  const output=Array.isArray(data.output)?data.output:[];
  const text=output.flatMap(o=>Array.isArray(object(o).content)?object(o).content as unknown[]:[]).map(object).filter(c=>c.type==='output_text').map(c=>typeof c.text==='string'?c.text:'').join('\n');
  if(!text)throw new Error('The model returned no readable result.');
  const usage=object(data.usage);
  return {text,input:typeof usage.input_tokens==='number'?usage.input_tokens:null,output:typeof usage.output_tokens==='number'?usage.output_tokens:null};
 });
}
