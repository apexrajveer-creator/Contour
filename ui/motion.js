// Small, interruptible motion layer. UI actions commit immediately; motion never
// delays the engine or locks a control. Only opacity/transform run continuously.
(() => {
  'use strict';
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  const ease='cubic-bezier(.22,.8,.25,1)';
  const running=new Map();
  function cancel(el){running.get(el)?.cancel();running.delete(el);}
  function animate(el,frames,options={}){
    if(!el || (media.matches && !options.force) || typeof el.animate!=='function')return null;
    cancel(el);
    const a=el.animate(frames,{duration:220,easing:ease,...options});running.set(el,a);
    a.finished.then(()=>{if(running.get(el)===a)running.delete(el);},()=>{});
    return a;
  }
  function enter(el,delay=0){
    if(el?.getBoundingClientRect().height)animate(el,[{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'none'}],{duration:240,delay});
  }
  const layoutSelector='.stage,.pick,.results,.result,.result-actions,.go > *, .inspector > *, .delivery > *, .lane,.model-row,.sheet-foot,.mash-slot,.mash-result,.mash-controls,.mash-summary,.mash-go,.mash-stale';
  const pending=new Map();let frame=0;
  function capture(root){
    const map=new Map();root.querySelectorAll(layoutSelector).forEach(el=>{
      if(running.has(el))return;
      const r=el.getBoundingClientRect();if(r.width && r.height)map.set(el,r);
    });return map;
  }
  function layout(change,root=document.querySelector('main:not([hidden])')){
    if(media.matches || !root){change();return;}
    if(!pending.has(root))pending.set(root,capture(root));
    change();
    if(frame)return;
    frame=requestAnimationFrame(()=>{
      frame=0;const batches=[...pending];pending.clear();
      batches.forEach(([root,before])=>{
      root.querySelectorAll(layoutSelector).forEach(el=>{
        const r=el.getBoundingClientRect();if(!r.width || !r.height)return;
        const old=before.get(el);if(!old){enter(el);return;}
        const x=old.left-r.left,y=old.top-r.top;
        const size=el.matches('.stage')?` scale(${old.width/r.width},${old.height/r.height})`:'';
        if(Math.abs(x)+Math.abs(y)>.5 || (size && Math.abs(old.height-r.height)>.5)){
          const original=el.style.transformOrigin;el.style.transformOrigin='top left';
          const a=animate(el,[{transform:`translate(${x}px,${y}px)${size}`},{transform:'none'}],{duration:240});
          if(a)a.finished.then(()=>el.style.transformOrigin=original,()=>el.style.transformOrigin=original);
        }
      });
      });
    });
  }
  let modeCleanup=()=>{};
  function mode(from,to,change){
    modeCleanup();
    // Preferred: a View Transition. It crossfades a rendered image of the old view with the live new
    // one, so frosted-glass panels stay frosted throughout. (Fading the views' own opacity would cut
    // the panels off from the backdrop they blur, and they'd flash clear glass until the fade ended.)
    if(from!==to && from && to && typeof document.startViewTransition==='function'){
      try{document.startViewTransition(()=>change());return;}catch{/* fall through */}
    }
    // Without View Transitions: switch instantly rather than flash unfrosted panels.
    if(from && to && from!==to){change();return;}
    // A plain opacity crossfade runs even with reduced motion: a fade has no movement to avoid.
    if(from===to || !from || !to || !from.animate){change();return;}
    // Pin the outgoing real view so its canvases remain crisp during the overlap.
    const r=from.getBoundingClientRect(), saved=from.getAttribute('style'), wasInert=from.inert;
    const order=['simple','studio','mashup'], dir=Math.sign(order.indexOf(to.id)-order.indexOf(from.id)) || 1;
    const display=getComputedStyle(from).display;
    from.style.setProperty('display',display,'important');
    Object.assign(from.style,{position:'fixed',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',margin:'0',zIndex:'3',pointerEvents:'none'});
    from.inert=true;
    let done=false;
    const clean=()=>{
      if(done)return;done=true;cancel(from);cancel(to);
      if(saved===null)from.removeAttribute('style');else from.setAttribute('style',saved);
      from.inert=wasInert;modeCleanup=()=>{};
    };
    modeCleanup=clean;change();
    // True crossfade: both views overlap for the whole fade, with the same duration and curve.
    const fade={duration:280,easing:'cubic-bezier(.4,0,.2,1)',force:true};
    const out=animate(from,[{opacity:1},{opacity:0}],fade);
    animate(to,[{opacity:0},{opacity:1}],fade);
    if(out)out.finished.then(()=>{ // Leave the incoming animation running to its natural end.
      if(done)return;done=true;running.delete(from);
      if(saved===null)from.removeAttribute('style');else from.setAttribute('style',saved);
      from.inert=wasInert;modeCleanup=()=>{cancel(to);};
    },()=>{});else clean();
  }
  const visibility=new WeakMap();
  function show(el,on){
    const previous=visibility.get(el);if(previous?.on===on)return;
    if(!previous && el.hidden===!on)return;
    previous?.animation?.cancel();
    const state={on,animation:null};visibility.set(el,state);
    if(on){el.hidden=false;el.inert=false;el.removeAttribute('aria-hidden');}
    else {el.inert=true;el.setAttribute('aria-hidden','true');}
    const sheet=el.querySelector('.sheet');
    const frames=el.classList.contains('toast')?
      [{opacity:0,transform:'translate(-50%, 8px)'},{opacity:1,transform:'translate(-50%, 0)'}]:
      [{opacity:0,transform:sheet?'none':'translateY(4px)'},{opacity:1,transform:'none'}];
    const finish=()=>{if(visibility.get(el)===state){el.hidden=!on;if(!on){el.inert=false;el.removeAttribute('aria-hidden');}}};
    state.animation=animate(el,on?frames:[...frames].reverse(),{duration:on?210:140});
    if(sheet)animate(sheet,on?[{opacity:0,transform:'translateY(12px) scale(.985)'},{opacity:1,transform:'none'}]:[{opacity:1,transform:'none'},{opacity:0,transform:'translateY(6px) scale(.992)'}],{duration:on?280:140});
    if(state.animation)state.animation.finished.then(finish,()=>{});else finish();
  }
  function popup(el,on){
    return animate(el,on?[{opacity:0,transform:'translateY(-3px) scale(.98)'},{opacity:1,transform:'none'}]:[{opacity:1,transform:'none'},{opacity:0,transform:'translateY(-2px) scale(.985)'}],{duration:on?190:115});
  }
  window.ContourMotion={animate,enter,layout,mode,show,popup,cancel,active:()=>running.size,reduced:()=>media.matches};
  // One moving glass surface under each segmented control.
  document.querySelectorAll('.mode:not(.rubber),.seg:not(.rubber)').forEach(group=>{
    const indicator=document.createElement('i');indicator.className='selection-glass';indicator.setAttribute('aria-hidden','true');group.append(indicator);
    let ready=false;
    const sync=()=>{
      const b=group.querySelector('[aria-checked=true]');if(!b)return;
      indicator.style.width=b.offsetWidth+'px';indicator.style.height=b.offsetHeight+'px';indicator.style.transform=`translate(${b.offsetLeft}px,${b.offsetTop}px)`;
      if(!ready){indicator.style.transition='none';requestAnimationFrame(()=>{indicator.style.transition='';ready=true;});}
    };
    new MutationObserver(sync).observe(group,{subtree:true,attributes:true,attributeFilter:['aria-checked']});
    if(typeof ResizeObserver!=='undefined')new ResizeObserver(sync).observe(group);
    requestAnimationFrame(sync);
  });
  // Text changes ease into place; exclude clocks and continuously updated meters.
  const labels='#status,#now-name,#now-meta,#zoom-label,.hint,.select-trigger span';
  const textCache=new WeakMap(),lastChange=new WeakMap();
  document.querySelectorAll(labels).forEach(el=>textCache.set(el,el.textContent));
  const observer=new MutationObserver(records=>{
    const changed=new Set();
    for(const record of records){const node=record.target.nodeType===3?record.target.parentElement:record.target;const el=node?.closest?.(labels);if(el)changed.add(el);}
    changed.forEach(el=>{
      const text=el.textContent;if(textCache.get(el)===text)return;textCache.set(el,text);
      const now=performance.now();if(now-(lastChange.get(el)||-Infinity)<180)return;lastChange.set(el,now);
      if(el.getBoundingClientRect().width)animate(el,[{opacity:.4,translate:'0 2px'},{opacity:1,translate:'0 0'}],{duration:160});
    });
  });document.querySelectorAll(labels).forEach(el=>observer.observe(el,{subtree:true,characterData:true,childList:true}));
  // Disabled/pressed states ease via CSS; a tiny release response is shared by
  // mouse, touch, and keyboard clicks without a large decorative ripple.
  document.addEventListener('click',e=>{
    const button=e.target.closest('button');if(!button || button.disabled || button.closest('.mode,.seg') || button.classList.contains('select-trigger'))return;
    if(button.getBoundingClientRect().width)animate(button,[{scale:'.98'},{scale:'1'}],{duration:180});
  });
  media.addEventListener('change',()=>{if(media.matches){modeCleanup();running.forEach(a=>a.finish());}});
})();
