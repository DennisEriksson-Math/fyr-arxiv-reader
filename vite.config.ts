import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({plugins:[react()],resolve:{alias:{'@':fileURLToPath(new URL('.',import.meta.url))}},base:'/fyr-arxiv-reader/',server:{host:'127.0.0.1',watch:{usePolling:true}},build:{target:'es2022'}});
