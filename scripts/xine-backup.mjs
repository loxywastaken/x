import {spawnSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,renameSync} from 'node:fs';
const root=new URL('../.runtime/',import.meta.url).pathname;
mkdirSync(root,{recursive:true,mode:0o700});
const tmp=root+'xine.dump.tmp',fd=openSync(tmp,'w',0o600);
try{const r=spawnSync('docker',['exec','xine-db','pg_dump','-U','xine','-d','xine','-Fc'],{stdio:['ignore',fd,'inherit']});if(r.status!==0)throw Error('Backup failed; previous backup was retained.')}finally{closeSync(fd)}
renameSync(tmp,root+'xine.dump');
console.log('Database backup saved to ignored .runtime/xine.dump. Keep it private.');
