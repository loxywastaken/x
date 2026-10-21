import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
const bundled=new URL('../../.tools/xine/node_modules/.bin/bun',import.meta.url).pathname;
const bun=process.env.BUN_BIN||(existsSync(bundled)?bundled:'bun');
const child=spawn(bun,[...(process.argv.includes('--watch')?['--watch']:[]),'src/server.ts'],{cwd:new URL('../',import.meta.url),stdio:'inherit',env:{...process.env,DATABASE_URL:process.env.DATABASE_URL||'postgres://xine@127.0.0.1:54329/xine'}});
child.on('error',e=>{console.error('Xine needs Bun 1.4+. Install Bun or set BUN_BIN. '+e.message);process.exitCode=1});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',(code,signal)=>process.exit(code??(signal?1:0)));
