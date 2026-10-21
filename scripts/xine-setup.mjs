// Cloud/local development setup. PostgreSQL is exposed only on loopback.
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
const root=new URL('../',import.meta.url).pathname;
const tools=resolve(root,'../.tools/xine');
const run=(cmd,args,options={})=>execFileSync(cmd,args,{cwd:root,stdio:'inherit',...options});
const output=(cmd,args)=>execFileSync(cmd,args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
mkdirSync(tools,{recursive:true});
const bun=process.env.BUN_BIN||resolve(tools,'node_modules/.bin/bun');
if(!existsSync(bun))run('npm',['install','--cache','/tmp/xine-npm-cache','--prefix',tools,'bun@1.4.3']);
run(bun,['install','--frozen-lockfile'],{env:{...process.env,BUN_INSTALL_CACHE_DIR:'/tmp/xine-bun-cache'}});
const exists=spawnSync('docker',['inspect','xine-db'],{stdio:'ignore'}).status===0;
if(exists){if(output('docker',['inspect','xine-db','--format','{{.State.Running}}'])!=='true')run('docker',['start','xine-db'])}
else{run('docker',['pull','postgres:18-bookworm']);run('docker',['run','-d','--name','xine-db','--restart','unless-stopped','-e','POSTGRES_USER=xine','-e','POSTGRES_DB=xine','-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1:54329:5432','-v','xine-postgres:/var/lib/postgresql','postgres:18-bookworm'])}
let ready=false;for(let i=0;i<60;i++){if(spawnSync('docker',['exec','xine-db','pg_isready','-U','xine','-d','xine'],{stdio:'ignore'}).status===0){ready=true;break}await new Promise(r=>setTimeout(r,500))}if(!ready)throw Error('PostgreSQL did not become ready. Inspect docker logs xine-db.');
const env={...process.env,DATABASE_URL:'postgres://xine@127.0.0.1:54329/xine'};
const count=output('docker',['exec','xine-db','psql','-U','xine','-d','xine','-tAc',"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='users'"]);
const backup=resolve(root,'.runtime/xine.dump');
if(count==='0'&&existsSync(backup)){const fd=openSync(backup,'r');const result=spawnSync('docker',['exec','-i','xine-db','pg_restore','-U','xine','-d','xine','--exit-on-error','--no-owner'],{stdio:[fd,'inherit','inherit']});closeSync(fd);if(result.status!==0)throw Error('Database restore failed; existing state was preserved for diagnosis.')}
run(bun,['scripts/xine-configure.ts'],{env});
console.log('Ready: PostgreSQL on loopback port 54329. Start Xine with npm start.');
