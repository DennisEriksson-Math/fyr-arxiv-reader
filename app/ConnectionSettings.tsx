import {useEffect,useRef,useState} from 'react';
import {Check,LoaderCircle,Plug} from 'lucide-react';
import {checkConnection,type ModelConnection} from '../lib/ai-browser';

export default function ConnectionSettings({value,onChange}:{value:ModelConnection;onChange:(next:ModelConnection)=>void}){
 const [status,setStatus]=useState('');const [checking,setChecking]=useState(false);const generation=useRef(0);
 useEffect(()=>{generation.current++;setStatus('');setChecking(false)},[value]);
 const bridge=value.provider==='bridge';
 const update=(patch:Partial<ModelConnection>)=>onChange({...value,...patch});
 async function check(){const id=++generation.current;setChecking(true);setStatus('');try{const message=await checkConnection(value);if(id===generation.current)setStatus(message)}catch(error){if(id===generation.current)setStatus(error instanceof Error?error.message:'Connection failed.')}finally{if(id===generation.current)setChecking(false)}}
 return <div className="connection-settings">
  <label htmlFor="provider">Connect a model</label>
  <select id="provider" value={value.provider} onChange={e=>update({provider:e.target.value as ModelConnection['provider'],model:e.target.value==='openai'?'gpt-5-mini':'',paperLimit:e.target.value==='openai'?20:5})}><option value="openai">OpenAI API</option><option value="bridge">Local CLI / LLM bridge</option></select>
  {bridge?<><p className="panel-copy">Use Claude CLI or a model served by LM Studio / Ollama on your computer.</p><label htmlFor="bridge-url">Local bridge address</label><input id="bridge-url" value={value.bridgeUrl} onChange={e=>update({bridgeUrl:e.target.value})} placeholder="http://127.0.0.1:8790"/><label htmlFor="bridge-token">Bridge session token</label><input id="bridge-token" type="password" autoComplete="off" spellCheck={false} value={value.bridgeToken} onChange={e=>update({bridgeToken:e.target.value})} placeholder="Paste from the bridge terminal"/><details className="bridge-help"><summary>Start the local bridge</summary><p>From the app’s source folder, after <code>npm ci</code>:</p><code className="command">npm run local -- --provider claude</code><p>Or connect a running local model:</p><code className="command">npm run local -- --provider local-llm --model YOUR_MODEL</code><p>The terminal prints the local app address and a session token. Open that address if this hosted page cannot connect to localhost.</p><a href="https://github.com/DennisEriksson-Math/fyr-arxiv-reader#connect-a-cli-or-local-model" target="_blank" rel="noreferrer">Setup instructions</a></details></>:<><label htmlFor="api-key">Your OpenAI API key</label><input id="api-key" type="password" autoComplete="off" spellCheck={false} placeholder="sk-…" value={value.key} onChange={e=>update({key:e.target.value})}/></>}
  <label htmlFor="model">Model{bridge?' (optional override)':''}</label><input id="model" value={value.model} onChange={e=>update({model:e.target.value})} placeholder={bridge?'Use the bridge’s model':'gpt-5-mini'}/>
  <label htmlFor="ai-paper-limit">Papers to analyse</label><select id="ai-paper-limit" value={value.paperLimit??20} onChange={e=>update({paperLimit:Number(e.target.value)})}><option value={5}>5 papers · lighter run</option><option value={10}>10 papers</option><option value={20}>20 papers</option></select><p className="tooltip-note spaced">The full keyword feed stays available. Smaller runs suit local models.</p>
  <button className="btn btn-secondary connection-check" disabled={checking||!(bridge?value.bridgeToken.trim():value.key.trim())} onClick={check}>{checking?<LoaderCircle size={13} className="spin"/>:<Plug size={13}/>}Check connection</button>
  {status&&<p className="connection-status" role="status">{status.startsWith('Connected')||status.startsWith('API key')?<Check size={12}/>:null}{status}</p>}
  <p className="ai-notice">{bridge?'Sends your interests and public abstracts to the bridge. A CLI uses its configured provider; a local model uses its local server.':'Sends your interests and public abstracts to OpenAI and uses your API credit.'} Imported source passages stay in your browser. Credentials last only this tab.</p>
 </div>;
}
