export type ModelConnection={provider:'openai'|'bridge';key:string;model:string;bridgeUrl:string;bridgeToken:string;paperLimit?:number};

export function defaultConnection():ModelConnection{
 const local=typeof window!=='undefined'&&['localhost','127.0.0.1','[::1]'].includes(window.location.hostname)&&window.location.port==='8790';
 return {provider:local?'bridge':'openai',key:'',model:local?'':'gpt-5-mini',bridgeUrl:local?window.location.origin:'http://127.0.0.1:8790',bridgeToken:'',paperLimit:local?5:20};
}

/** Credentials can only be sent to the intended loopback bridge. */
export function bridgeOrigin(raw:string):string{
 let url:URL;try{url=new URL(raw.trim())}catch{throw new Error('Enter a local bridge address, such as http://127.0.0.1:8790.');}
 if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('The bridge address must be a localhost address, with no path or credentials.');
 return url.origin;
}

export function modelName(value:string):string{
 const name=value.trim();
 if(name&&!/^[a-zA-Z0-9][a-zA-Z0-9._:/@+\-]{0,159}$/.test(name))throw new Error('Enter a valid model name.');
 return name;
}
