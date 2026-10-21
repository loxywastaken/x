// The original Xine client, backed by Xitter's accounts, sessions, visibility
// checks, moderation and mutations. No demo records or shared viewer state.
import {getViewer, sessionCookies, clearedCookies, startSession, logout, type Viewer, type User} from './auth';
import {passwordStep} from './password-sign-in';
import {answerChallenge} from './two-factor';
import {signUp, checkSignup, SignupError} from './invites';
import {sendSignupCode, checkSignupCode} from './email-address';
import {mailEnabled} from './mail';
import {sql} from './db';
import {PUBLIC_ORIGIN} from './config';
import {settings} from './settings';
import {requestIp, recordSignIn} from './login-history';
import {hit, limitApi, RateLimitError} from './ratelimit';
import {boundedBody, BodyTooLarge} from './api-input';
import {callOperation} from './graphql';
import {feed, bookmarkedPosts, postsByIds, getPost, replies, PostError} from './posts';
import {userById, usersByIds, suggestedUsers, followList, setFollow} from './users';
import {searchPosts, searchUsers, cachedTrends} from './search';
import {pushItems} from './notifications';
import {restRoute} from './rest';
import {isId} from './ids';
import {mediaUrl} from './media';
import type {PostRow} from './model';
const WEB = new URL('../web/',import.meta.url).pathname;
const json=(body:unknown,status=200,headers:HeadersInit={})=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff',...Object.fromEntries(new Headers(headers))}});
class XineError extends Error{constructor(message:string,public status=400){super(message)}}
const fail=(message:string,status=400)=>json({error:message},status);
const string=(v:unknown,max=1000)=>typeof v==='string'?v.slice(0,max):'';
async function body(req:Request){if(!req.headers.get('content-type')?.startsWith('application/json'))throw new XineError('Send JSON.',415);const bytes=await boundedBody(req,16_384);let b;try{b=JSON.parse(new TextDecoder().decode(bytes))}catch{throw new XineError('Invalid JSON.')}if(!b||typeof b!=='object'||Array.isArray(b))throw new XineError('Invalid JSON.');return b;}
function sameSite(req:Request){const site=req.headers.get('sec-fetch-site');if(site&&site!=='same-origin'&&site!=='none')return false;const origin=req.headers.get('origin');return !origin||origin===new URL(req.url).origin||origin===PUBLIC_ORIGIN;}
async function signed(session:{token:string;csrf:string;userId:string},req:Request){await recordSignIn(req,session);const headers=new Headers({'content-type':'application/json','cache-control':'no-store'});for(const cookie of sessionCookies(session))headers.append('set-cookie',cookie);return new Response(JSON.stringify({ok:true}),{headers});}
function shapeUser(u:User,v:Viewer){const id=u.id===v.id?'you':String(u.id);return{id,name:u.name,handle:u.screen_name,initials:(u.name||u.screen_name).split(/\s+/).map(s=>s[0]).join('').slice(0,2).toUpperCase(),color:['#c8d5a5','#e9bcad','#b8c9d6','#d5d1c3','#c6d4bb'][Number(BigInt(u.id)%5n)],bio:u.bio||'',following:!!u.stats?.followedByViewer,requested:!!u.stats?.requestedByViewer,followers:Number(u.stats?.followers||0),followingCount:Number(u.stats?.following||0),verified:!!u.verified_type,avatar:u.avatar_url||null,protected:!!u.protected};}
function shapePost(p:PostRow,v:Viewer){return{id:String(p.id),author:p.author.id===v.id?'you':String(p.author.id),text:p.text,created:new Date(p.created_at).getTime(),likes:Number(p.like_count),reposts:Number(p.repost_count),replyCount:Number(p.reply_count),liked:!!p.liked,reposted:!!p.reposted,saved:!!p.bookmarked,replies:[],tags:[...p.text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map(m=>m[1].toLowerCase()),media:(p.media||[]).map(m=>({id:m.id,url:new URL(mediaUrl(m.id,m.mime)).pathname,kind:m.kind,alt:m.alt_text||''}))};}
async function snapshot(v:Viewer,url:URL){
 const query=(url.searchParams.get('q')||'').trim().slice(0,200),profile=url.searchParams.get('profile');
 if(profile&&profile!=='you'&&!isId(profile))throw new XineError('Account not found.',404);
 const [me,suggestions,following,bookmarks,items,notices,trends]=await Promise.all([userById(v.id,v.id),suggestedUsers(v.id,30),followList(v.id,v.id,'following',200),bookmarkedPosts(v.id,200),feed({viewerId:v.id,authors:{all:true},replies:false,kinds:'both',limit:100}),pushItems(v.id,0),cachedTrends(7,4)]);
 const all=new Map<string,PostRow>();for(const p of [...items.map(i=>i.post),...bookmarks])all.set(String(p.id),p);
 let results:string[]|undefined,people:User[]=[];
 if(query){const ids=await searchPosts(query,{viewerId:v.id,top:false,limit:100});const found=await postsByIds(v.id,ids);results=ids.map(String);for(const p of found.values())all.set(String(p.id),p);const userIds=await searchUsers(v.id,query,50);people=[...(await usersByIds(v.id,userIds)).values()];}
 let selected:User|undefined;
 if(profile&&profile!=='you'&&isId(profile)){selected=await userById(v.id,profile);if(!selected||selected.status==='suspended')throw new XineError('Account not found.',404)}
 if(profile){const own=await feed({viewerId:v.id,authors:{user:profile==='you'?v.id:profile},replies:false,kinds:'posts',limit:100});for(const i of own)all.set(String(i.post.id),i.post)}
 const users=new Map<string,User>();if(me)users.set(String(me.id),me);for(const u of [...suggestions,...following,...people,...(selected?[selected]:[]),...[...all.values()].map(p=>p.author)])users.set(String(u.id),u);
 return{users:[...users.values()].map(u=>shapeUser(u,v)),posts:[...all.values()].sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()).map(p=>shapePost(p,v)),notifications:notices,trends,searchResults:results,searchPeople:people.map(u=>String(u.id)),csrf:v.csrf,backend:'xitter',staff:!!v.role};
}
async function auth(req:Request,path:string){if(req.method!=='POST')return fail('Method not allowed.',405);if(!sameSite(req))return fail('This request came from another site.',403);if(!hit('auth',requestIp(req)||'unknown').ok)return fail('Too many attempts. Please try again in 15 minutes.',429);const b=await body(req);
 if(path==='/api/auth/login'){const out=await passwordStep(string(b.username,64),string(b.password,1025));if('error'in out)return fail(out.error,401);if('challenge'in out)return json({challenge:out.challenge,kind:'totp'});return signed(out.session,req)}
 if(path==='/api/auth/verify'){const token=string(b.challenge,50);if(!/^[0-9a-f-]{36}$/i.test(token))return fail('Invalid verification session.');if(b.kind==='totp'){const out=await answerChallenge(token,string(b.code,100));return out.session?signed(out.session,req):fail(out.error||'This sign-in expired. Please start again.',401)}
 const [pending]=await sql`select pending,code from signup_sessions where token=${token}::uuid and pending is not null and created_at>now()-interval '15 minutes'`;
 if(!pending)return fail('This sign-up expired. Please start again.');const checked=await checkSignupCode(token,string(b.code,20));if(checked!=='ok')return fail(checked==='wrong'?'That code is incorrect.':'That code expired. Start again.');const p=pending.pending;const id=await signUp({...p,code:pending.code,emailVerified:true,ip:requestIp(req)});await sql`delete from signup_sessions where token=${token}::uuid`;return signed(await startSession(id),req);}
 if(path==='/api/auth/signup'){if((await getViewer(req)))return fail('Sign out before creating another account.');const f={screenName:string(b.username,100),name:string(b.name,100),password:string(b.password,1025),email:string(b.email,300),code:string(b.invite,100),ip:requestIp(req),source:'Xine web'};
 if(mailEnabled()){if(!hit('mail',requestIp(req)||'unknown').ok)return fail('Too many emails requested. Try again later.',429);const checked=await checkSignup(f);const token=crypto.randomUUID();const pending={...checked,passwordHash:await Bun.password.hash(f.password),source:f.source,ip:f.ip};await sql`insert into signup_sessions(token,username,code,pending) values(${token}::uuid,${checked.screenName},${f.code},${JSON.stringify(pending)}::text::jsonb)`;try{await sendSignupCode(token,checked.email)}catch{await sql`delete from signup_sessions where token=${token}::uuid`;return fail('The verification email could not be sent. Please try again later.',503)}return json({challenge:token,kind:'email'});}
 const id=await signUp(f);return signed(await startSession(id),req);}
 return fail('Not found.',404);
}
export async function xineRoute(req:Request):Promise<Response|undefined>{
 const url=new URL(req.url),path=url.pathname;
 const isApi=path==='/api/state'||path.startsWith('/api/auth/')||path.startsWith('/api/thread/')||['posts','like','repost','bookmark','reply','follow','profile','logout'].some(p=>path==='/api/'+p);
 if(isApi){try{
 if(path.startsWith('/api/auth/'))return await auth(req,path);
 const v=await getViewer(req);if(!v)return json({error:'Sign in to continue.',signupMode:settings().signup_mode,mailEnabled:mailEnabled()},401);
 const limited=limitApi(v,req.method,path,undefined,url);if(limited)return limited;
 if(path==='/api/state'&&req.method==='GET')return json(await snapshot(v,url));
 if(path.startsWith('/api/thread/')&&req.method==='GET'){const id=path.split('/').pop()!;if(!isId(id))return fail('Post not found.',404);const p=await getPost(v.id,id);if(!p)return fail('Post not found.',404);const list=await replies(v.id,id);return json({post:shapePost(p,v),author:shapeUser(p.author,v),replies:list.map(r=>({id:r.id,text:r.text,created:new Date(r.created_at).getTime(),author:shapeUser(r.author,v)}))});}
 if(req.method!=='POST')return fail('Method not allowed.',405);
 if(!sameSite(req)||req.headers.get('x-csrf-token')!==v.csrf)return fail('Invalid request. Refresh and try again.',403);
 const b=await body(req);
 if(path==='/api/logout'){await logout(v.token);const headers=new Headers({'content-type':'application/json','cache-control':'no-store'});for(const c of clearedCookies())headers.append('set-cookie',c);return new Response(JSON.stringify({ok:true}),{headers});}
 if(v.status==='restricted'&&(path==='/api/posts'||path==='/api/reply'))return fail("Your account can't post right now.",403);
 const bucket=(path==='/api/posts'||path==='/api/reply')?'post':['/api/like','/api/repost','/api/bookmark','/api/follow'].includes(path)?'engage':null;
 if(bucket&&!v.role&&!hit(bucket,v.id).ok)return fail('Too many requests. Try again later.',429);
 if(path==='/api/posts'||path==='/api/reply'){const text=string(b.text,5000).trim();if(!text||text.length>280)return fail('Posts must contain 1–280 characters.');const vars:any={tweet_text:text,media:{media_entities:[],possibly_sensitive:false}};if(path==='/api/reply'){if(!isId(b.id)||!(await getPost(v.id,b.id)))return fail('Post not found.',404);vars.reply={in_reply_to_tweet_id:b.id}}await callOperation('CreateTweet',v,vars);}
 else if(path==='/api/follow'){if(!isId(b.id))return fail('Account not found.',404);const target=await userById(v.id,b.id);if(!target||target.status==='suspended'||target.id===v.id)return fail('Account not found.',404);await setFollow(v.id,target.id,!(target.stats?.followedByViewer||target.stats?.requestedByViewer));}
 else if(path==='/api/profile'){const form=new URLSearchParams({name:string(b.name,100),description:string(b.bio,300)});const out=await restRoute('POST','/1.1/account/update_profile.json',v,new Request(req.url,{method:'POST',body:form}));if(out&&!out.ok){const data:any=await out.json();return fail(data.errors?.[0]?.message||'Profile could not be updated.',out.status)}}
 else if(['/api/like','/api/repost','/api/bookmark'].includes(path)){if(!isId(b.id))return fail('Post not found.',404);const p=await getPost(v.id,b.id);if(!p)return fail('Post not found.',404);const operation=path==='/api/like'?(p.liked?'UnfavoriteTweet':'FavoriteTweet'):path==='/api/bookmark'?(p.bookmarked?'DeleteBookmark':'CreateBookmark'):(p.reposted?'DeleteRetweet':'CreateRetweet');await callOperation(operation,v,{tweet_id:p.id,source_tweet_id:p.id});}
 else return fail('Not found.',404);
 if(b.context&&typeof b.context==='object'){if(typeof b.context.q==='string')url.searchParams.set('q',b.context.q.slice(0,200));if(b.context.profile==='you'||isId(b.context.profile))url.searchParams.set('profile',b.context.profile)}
 return json(await snapshot(v,url));
 }catch(e){if(e instanceof BodyTooLarge)return fail('Request is too large.',413);if(e instanceof SignupError||e instanceof PostError)return fail(e.message);if(e instanceof RateLimitError)return fail('Too many requests. Try again later.',429);if(e instanceof XineError)return fail(e.message,e.status);if((e as any)?.code==='23505')return fail('That username or email is already in use.');console.error('Xine request failed:',e);return fail('Something went wrong. Please try again.',500);}}
 const files:Record<string,string>={'/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};
 const asset=files[path]||(/^\/assets\/[\w.-]+$/.test(path)?path.slice(1):undefined);
 const page=['/','/home','/explore','/notifications','/bookmarks','/connect','/profile','/login','/signup'].includes(path)||/^\/post\/\d{1,19}$/.test(path);
 if((asset||page)&&(req.method==='GET'||req.method==='HEAD')){const file=Bun.file(WEB+(asset||'index.html'));if(!(await file.exists()))return new Response('Not found',{status:404});return new Response(req.method==='HEAD'?null:file,{headers:{'content-type':asset?.endsWith('.js')?'text/javascript; charset=utf-8':asset?.endsWith('.css')?'text/css; charset=utf-8':file.type,'cache-control':'no-cache','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"}});}
}
