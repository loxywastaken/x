import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const read=p=>readFile(new URL(p,root),'utf8');
const data=async(p,mime)=>'data:'+mime+';base64,'+(await readFile(new URL(p,root))).toString('base64');
let css=await read('web/style.css'),app=await read('web/app.js');
for(const [file,mime] of [['dm-sans.ttf','font/ttf'],['manrope.ttf','font/ttf'],['forest.svg','image/svg+xml'],['architecture.svg','image/svg+xml']]){const url=await data('web/assets/'+file,mime);css=css.replaceAll('/assets/'+file,url)}
const local=await read('local/server.mjs');
const seed=local.slice(local.indexOf('const users='),local.indexOf('let state;'));
const adapter=`
${seed}
const storageKey='xine-standalone-v1';let demo;try{demo=JSON.parse(localStorage.getItem(storageKey))}catch{}if(!demo||!demo.users||!demo.posts)demo=seed;
const copy=v=>JSON.parse(JSON.stringify(v));
function saveDemo(){try{localStorage.setItem(storageKey,JSON.stringify(demo))}catch{}}
function demoSnapshot(url){const s=copy(demo);s.backend='standalone';s.csrf='offline';s.staff=false;s.trends=[];const q=(url.searchParams.get('q')||'').toLowerCase();if(q){s.searchResults=s.posts.filter(p=>(p.text+' '+s.users.find(u=>u.id===p.author).name).toLowerCase().includes(q)).map(p=>p.id);s.searchPeople=s.users.filter(u=>(u.name+' '+u.handle).toLowerCase().includes(q)).map(u=>u.id)}return s}
window.fetch=async(input,options={})=>{const url=new URL(String(input),'https://xine.offline'),path=url.pathname,b=JSON.parse(options.body||'{}');let out;try{
if(path==='/api/state')out=demoSnapshot(url);
else if(path.startsWith('/api/thread/')){const p=demo.posts.find(p=>p.id===path.split('/').pop());if(!p)throw Error('Post not found');out={post:p,author:demo.users.find(u=>u.id===p.author),replies:p.replies.map(r=>({...r,author:demo.users.find(u=>u.id===(r.authorId||'you'))}))}}
else{if(path==='/api/posts'){const text=String(b.text||'').trim();if(!text||text.length>280)throw Error('Write between 1 and 280 characters.');demo.posts.unshift({id:'local-'+Date.now()+'-'+Math.random().toString(36).slice(2,7),author:'you',text,likes:0,reposts:0,replies:[],tags:[],created:Date.now(),liked:false,saved:false})}
else if(path==='/api/profile'){const me=demo.users.find(u=>u.id==='you');me.name=String(b.name||'').trim().slice(0,50)||me.name;me.bio=String(b.bio||'').slice(0,160)}
else if(path==='/api/follow'){const u=demo.users.find(u=>u.id===b.id);if(!u)throw Error('Account not found');u.following=!u.following}
else if(path==='/api/logout'){}
else{const p=demo.posts.find(p=>p.id===b.id);if(!p)throw Error('Post not found');if(path==='/api/like'){p.liked=!p.liked;p.likes+=p.liked?1:-1}else if(path==='/api/bookmark')p.saved=!p.saved;else if(path==='/api/repost'){p.reposted=!p.reposted;p.reposts+=p.reposted?1:-1}else if(path==='/api/reply'){const text=String(b.text||'').trim();if(!text||text.length>280)throw Error('Write between 1 and 280 characters.');p.replies.push({text,created:Date.now(),authorId:'you'});p.replyCount=p.replies.length}else throw Error('This feature requires the Xine server.')}
saveDemo();if(b.context?.q)url.searchParams.set('q',b.context.q);out=demoSnapshot(url)}return new Response(JSON.stringify(out),{headers:{'content-type':'application/json'}})
}catch(e){return new Response(JSON.stringify({error:e.message}),{status:400,headers:{'content-type':'application/json'}})}};
`;
app=app.replace(/history\.replaceState\(null,'','\/'\+n\.toLowerCase\(\)\);/g,'').replaceAll("history.replaceState(null,'','/');",'').replaceAll("history.replaceState(null,'','/home');",'');
app=app.replace('Xine runs on the open-source Xitter backend. Your account, posts, and interactions are stored in this instance’s PostgreSQL database.','This standalone HTML is a local demo. Your changes stay in this browser when storage is available. Real accounts and shared posts require the Xine server.');
let html=await read('web/index.html');html=html.replace('href="/favicon.svg"','href="'+await data('web/favicon.svg','image/svg+xml')+'"');html=html.replace('<link rel="stylesheet" href="/style.css">','<style>'+css+'\n[data-logout],.account-links{display:none!important}.offline-banner{position:fixed;bottom:8px;left:50%;transform:translateX(-50%);z-index:8;background:#2d3d30;color:#fff;padding:7px 14px;border-radius:20px;font:10px system-ui;white-space:nowrap}@media(max-width:540px){.offline-banner{bottom:68px;font-size:8px}}</style>');
html=html.replace('<script type="module" src="/app.js"></script>','<div class="offline-banner">Standalone demo · Saved in this browser · Server required for real accounts</div><script type="module">'+(adapter+'\n'+app).replace(/<\/script/gi,'<\\/script')+'</script>');
const license=await read('LICENSE'),fontLicense=await read('web/assets/FONT-LICENSE.txt'),manropeLicense=await read('web/assets/MANROPE-LICENSE.txt');
html+='\n<!-- Xine standalone export. Based on Xitter: https://github.com/Xittered/xitter . AGPL-3.0-only.\n'+[license,fontLicense,manropeLicense].join('\n').replaceAll('--','—')+'\n-->\n';
await writeFile(new URL('xine.html',root),html);console.log('Exported xine.html: self-contained, with browser-local demo data and bundled assets.');
