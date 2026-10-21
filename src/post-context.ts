// The app a post came from ("Xitter for Web", named after the instance), after the time on the post's own
// page, as Twitter used to show it. The client still gets `source` in the post
// data but no longer draws it.

export const POST_CONTEXT_SCRIPT = String.raw`(function(){
	var cache={},loading={};
	function focal(){
		var m=location.pathname.match(/^\/[^/]+\/status\/(\d+)\/?$/);
		if(!m)return;
		var id=m[1];
		// the post page's time reads "11:21 PM · Oct 14, 2026"; a feed's reads "3m"
		var time=[].find.call(document.querySelectorAll('article[data-testid="tweet"] a[href$="/status/'+id+'"] time'),function(t){return t.textContent.indexOf("·")>=0});
		if(!time)return;
		var line=time.closest("a").parentElement;
		if(line.querySelector("[data-xitter-source]"))return;
		if(cache[id]===undefined){load(id);return;}
		if(!cache[id])return;
		var s=document.createElement("span");
		s.setAttribute("data-xitter-source","");
		s.textContent=" · "+cache[id];
		line.appendChild(s);
	}
	function load(id){
		if(loading[id])return;
		loading[id]=true;
		var csrf=(document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)||[])[1]||"";
		fetch("/i/api/graphql/xitter/XitterPostContext",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({variables:{ids:[id]}})})
			.then(function(r){return r.json()})
			.then(function(d){var p=d.data&&d.data.xitter_post_context[0];cache[id]=p?p.source:null;focal()})
			.catch(function(){cache[id]=null});
	}
	var timer;
	new MutationObserver(function(){if(!timer)timer=setTimeout(function(){timer=null;focal()},100)}).observe(document.documentElement,{childList:true,subtree:true});
})();`;
