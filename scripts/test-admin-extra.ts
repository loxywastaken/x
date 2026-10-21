import { createUser } from "../src/auth";
import { sql } from "../src/db";

const origin="http://localhost:3000",password="testpass123";
let checks=0;
const check=(ok:unknown,label:string)=>{if(!ok)throw new Error(label);checks++;};
async function session(username:string){
	const r=await fetch(origin+"/login",{method:"POST",body:new URLSearchParams({username,password}),redirect:"manual"});
	const cookies=r.headers.getSetCookie().map(c=>c.split(';')[0]);
	const headers={cookie:cookies.join('; '),'x-csrf-token':cookies.find(c=>c.startsWith('ct0='))!.slice(4),'content-type':'application/json'};
	return {headers,token:cookies.find(c=>c.startsWith('auth_token='))!.slice(11),
		admin:async(action:string,body:any={})=>{const r=await fetch(origin+'/admin/api/'+action,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};},
		gql:async(op:string,vars:any)=>await(await fetch(origin+'/i/api/graphql/q/'+op,{method:'POST',headers,body:JSON.stringify({variables:vars})})).json() as any,
	};
}
const created:string[]=[],names:string[]=[];let badge:string|undefined;
try{
	for(let i=0;i<3;i++){const name='ad'+Date.now().toString().slice(-9)+i;names.push(name);created.push(await createUser(name,name,password));}
	await sql`update users set role='moderator' where id=${created[1]}::bigint`;
	await sql`update users set role='support' where id=${created[2]}::bigint`;
	const admin=await session('pozo'),user=await session(names[0]),moderator=await session(names[1]),support=await session(names[2]);
	check((await user.admin('badges')).status===403,'staff only');
	check((await moderator.admin('createBadge',{name:'Not allowed',image:'AA=='})).status===403,'only admin creates badges');
	check((await admin.admin('createBadge',{name:'Bad SVG',image:Buffer.from('<svg/>').toString('base64')})).status===400,'SVG rejected');
	badge=(await admin.admin('createBadge',{name:'Test custom badge',image:Buffer.from(await Bun.file('public/favicon.png').arrayBuffer()).toString('base64')})).data.id;
	check(!!badge,'badge created');
	const second=(await admin.admin('createBadge',{name:'Second test badge',image:Buffer.from(await Bun.file('public/favicon.png').arrayBuffer()).toString('base64')})).data.id;
	check((await admin.admin('setBadges',{id:created[0],badgeIds:[badge,second]})).status===200,'badges assigned');
	const extra=await(await fetch(origin+'/i/api/xitter/badges?names='+names[0],{headers:user.headers})).json() as any;
	check(extra[names[0]]?.badges?.length===1&&extra[names[0]].badges[0].description==='Second test badge','second badge drawn after the first');
	await admin.admin('deleteBadge',{id:second});
	const profile=(await user.gql('UserByScreenName',{screen_name:names[0]})).data.user.result;
	check(profile.affiliates_highlighted_label.label.description==='Test custom badge','native badge description');
	check((await fetch(origin+'/public/badge-'+badge+'.png')).headers.get('content-type')==='image/png','public raster badge');
	check((await support.admin('addStaffNote',{id:created[0],body:'Private staff context'})).status===200,'support can add staff note');
	check((await support.admin('staffNotes',{id:created[0]})).data.notes.length===1,'staff note read');
	check((await support.admin('sendStaffMessage',{id:created[0],body:'no'})).status===403,'support cannot issue warnings');
	const message=(await moderator.admin('sendStaffMessage',{id:created[0],kind:'strike',body:'A test strike'})).data.id;
	check(!!message,'strike sent');
	const read=await(await fetch(origin+'/i/api/xitter/moderation',{headers:user.headers})).json() as any;
	check(read.messages[0].body==='A test strike','notice delivered privately');
	const timeline=await(await fetch(origin+'/i/api/graphql/q/NotificationsTimeline?variables='+encodeURIComponent(JSON.stringify({timeline_type:'All',count:40})),{headers:user.headers})).json() as any;
	const entries=timeline.data.viewer_v2.user_results.result.notification_timeline.timeline.instructions.find((i:any)=>i.type==='TimelineAddEntries').entries;
	const staffEntry=entries.find((e:any)=>e.entryId==='notification-staff-'+message)?.content.itemContent;
	check(staffEntry?.notification_icon==='shield_icon'&&staffEntry.rich_message.text.includes('A test strike'),'strike shown in notifications');
	check((await fetch(origin+'/account/notices',{headers:user.headers})).status===200,'notices page');
	const other=await(await fetch(origin+'/i/api/xitter/moderation',{headers:support.headers})).json() as any;
	check(other.messages.length===0,'notice not visible to another user');
	const mutate=async(body:any)=>{const r=await fetch(origin+'/i/api/xitter/moderation',{method:'POST',headers:user.headers,body:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};};
	check((await mutate({action:'read',id:message})).status===200,'notice acknowledged');
	const appeal=await mutate({action:'appeal',messageId:message,body:'Please review this strike'});
	check(appeal.status===200,'appeal submitted');
	check((await mutate({action:'appeal',body:'duplicate'})).status===400,'one open appeal per user');
	check((await moderator.admin('resolveAppeal',{id:appeal.data.id,status:'accepted',reply:'We reviewed it'})).status===200,'appeal resolved');
	check((await moderator.admin('revokeStrike',{id:message})).status===200,'strike revoked');
	const sessions=(await support.admin('userSessions',{id:created[0]})).data.sessions;
	check(sessions.length===1&&!JSON.stringify(sessions).includes(user.token),'session tokens never exposed');
	check((await moderator.admin('setTemporaryStatus',{id:created[0],status:'restricted',hours:1})).status===200,'temporary sanction applied');
	const blocked=await user.gql('CreateTweet',{tweet_text:'restricted check'});check(!!blocked.errors,'restriction enforced');
	await sql`update users set status_until=now()-interval '1 second' where id=${created[0]}::bigint`;
	await session(names[0]);const [standing]=await sql`select status,status_until from users where id=${created[0]}::bigint`;
	check(standing.status==='active'&&standing.status_until===null,'expired sanction automatically restored');
	const post=(await user.gql('CreateTweet',{tweet_text:'Moderation visibility check'})).data.create_tweet.tweet_results.result.rest_id;
	check((await moderator.admin('setPostVisibility',{id:post,hidden:true,sensitive:false})).status===200,'post hidden');
	const hidden=await user.gql('TweetResultByRestId',{tweetId:post});check(!JSON.stringify(hidden).includes('Moderation visibility check'),'hidden text inaccessible');
	check((await moderator.admin('setPostVisibility',{id:post,hidden:false,sensitive:true})).status===200,'post restored and sensitive');
	const visible=await user.gql('TweetResultByRestId',{tweetId:post});check(JSON.stringify(visible).includes('"possibly_sensitive":true'),'native sensitivity flag');
	const forbidden=await moderator.admin('setTemporaryStatus',{id:(await admin.gql('UserByScreenName',{screen_name:'pozo'})).data.user.result.rest_id,status:'restricted',hours:1});check(forbidden.status===403,'staff hierarchy enforced');
	check((await support.admin('revokeSession',{sessionId:sessions[0].id})).status===200,'single session revoked');
	check((await fetch(origin+'/i/api/xitter/moderation',{headers:user.headers})).status===401,'revoked session rejected');
	const {operations}=(await admin.admin('operations')).data;
	try{
		check((await admin.admin('saveOperations',{...operations,maintenance:true,message:'Test maintenance'})).status===200,'maintenance on');
		const waiting=await fetch(origin+'/home',{headers:moderator.headers});
		check(waiting.status===200,'staff keep working during maintenance');
		const other=await session(names[2]);await sql`update users set role=null where id=${created[2]}::bigint`;
		const blockedPage=await fetch(origin+'/home',{headers:other.headers});
		check(blockedPage.status===503&&(await blockedPage.text()).includes('Test maintenance'),'members see the maintenance page');
	}finally{await admin.admin('saveOperations',{...operations,maintenance:false});}
	await admin.admin('deleteBadge',{id:badge});badge=undefined;
	const left=await sql`select 1 from user_badges where user_id=${created[0]}::bigint`;check(left.length===0,'deleting badge clears assignment');
	console.log(`all ${checks} expanded admin checks passed`);
}finally{
	if(badge)await sql`delete from custom_badges where id=${badge}::bigint`;
	for(const id of created)await sql`delete from users where id=${id}::bigint`;
	await sql.close();
}
