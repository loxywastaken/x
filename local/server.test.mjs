import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'xine-test-'));
const port=32347, base=`http://127.0.0.1:${port}`;
let server;
async function start(){server=spawn(process.execPath,[new URL('./server.mjs',import.meta.url).pathname],{env:{...process.env,PORT:String(port),XINE_DATA_DIR:dir},stdio:['ignore','pipe','inherit']});await new Promise((resolve,reject)=>{server.once('error',reject);server.stdout.once('data',resolve);server.once('exit',c=>reject(Error('Server exited '+c)))})}
async function stop(){const done=new Promise(r=>server.once('exit',r));server.kill();await done}
async function get(){return(await fetch(base+'/api/state')).json()}
async function post(path,body){return fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
test('local social workflow persists across restarts and rejects invalid posts',async()=>{try{await start();assert.equal((await fetch(base)).status,200);for(const asset of ['app.js','style.css','assets/dm-sans.ttf','assets/forest.svg'])assert.equal((await fetch(base+'/'+asset)).status,200);assert.equal((await post('posts',{text:' '})).status,400);assert.equal((await post('posts',{text:'a'.repeat(281)})).status,400);let s=await(await post('posts',{text:'A real test post 🌿'})).json();const p=s.posts[0];assert.equal(p.text,'A real test post 🌿');s=await(await post('like',{id:p.id})).json();assert.equal(s.posts[0].likes,1);s=await(await post('like',{id:p.id})).json();assert.equal(s.posts[0].likes,0);s=await(await post('bookmark',{id:p.id})).json();assert.equal(s.posts[0].saved,true);s=await(await post('repost',{id:p.id})).json();assert.equal(s.posts[0].reposts,1);s=await(await post('reply',{id:p.id,text:'A thoughtful reply'})).json();assert.equal(s.posts[0].replies[0].text,'A thoughtful reply');s=await(await post('follow',{id:'studio'})).json();assert.equal(s.users.find(u=>u.id==='studio').following,true);s=await(await post('profile',{name:'Test Person',bio:'Updated bio'})).json();assert.equal(s.users[0].name,'Test Person');assert.equal((await post('like',{id:'invalid'})).status,400);await stop();await start();s=await get();assert.equal(s.posts[0].text,'A real test post 🌿');assert.equal(s.posts[0].saved,true);assert.equal(s.posts[0].replies.length,1);assert.equal(s.users[0].bio,'Updated bio')}finally{if(server?.exitCode===null)await stop();await rm(dir,{recursive:true,force:true})}});
