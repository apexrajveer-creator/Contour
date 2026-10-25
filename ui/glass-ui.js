// Shared glass dropdowns and native window chrome.
(() => {
  'use strict';
  const dropdowns=[];
  const closeAll=()=>dropdowns.forEach(d=>d.close());
  document.querySelectorAll('select').forEach(select=>{
    const wrap=document.createElement('div'); wrap.className='glass-select';
    const button=document.createElement('button'); button.type='button';button.className='select-trigger';
    button.id=select.id+'-trigger';button.setAttribute('role','combobox');button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
    const label=document.querySelector(`label[for="${select.id}"]`);
    if(label){label.htmlFor=button.id;label.id=select.id+'-label';button.setAttribute('aria-labelledby',label.id+' '+button.id+'-value');}
    const value=document.createElement('span');value.id=button.id+'-value';
    button.append(value);button.insertAdjacentHTML('beforeend','<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>');
    const list=document.createElement('div');list.className='select-menu';list.id=select.id+'-list';list.setAttribute('role','listbox');list.hidden=true;
    list.setAttribute('aria-label',label?.textContent || select.id);button.setAttribute('aria-controls',list.id);
    select.before(wrap);wrap.append(select,button);select.hidden=true;select.tabIndex=-1;select.setAttribute('aria-hidden','true');document.body.append(list);
    let signature='',active=0,search='',searchTimer,opened=false,popupAnimation=null;
    const options=()=>Array.from(select.options);
    const enabled=()=>options().map((o,i)=>!o.disabled?i:-1).filter(i=>i>=0);
    const position=()=>{
      const r=button.getBoundingClientRect(), desired=Math.min(260,list.scrollHeight+12), below=innerHeight-r.bottom-12, above=r.top-12;
      const up=below<desired && above>below;
      list.style.width=Math.max(r.width,190)+'px'; list.style.left=Math.max(8,Math.min(r.left,innerWidth-Math.max(r.width,190)-8))+'px';
      list.style.maxHeight=Math.max(40,Math.min(260,up?above:below))+'px';
      list.style.top=up?'auto':r.bottom+6+'px';list.style.bottom=up?innerHeight-r.top+6+'px':'auto';
      list.style.transformOrigin=up?'bottom center':'top center';
    };
    const highlight=()=>{
      [...list.children].forEach((row,i)=>row.classList.toggle('active',i===active));
      if(list.children[active]){button.setAttribute('aria-activedescendant',list.children[active].id);list.children[active].scrollIntoView({block:'nearest'});}
    };
    const close=()=>{
      if(!opened)return;opened=false;
      button.setAttribute('aria-expanded','false');button.removeAttribute('aria-activedescendant');list.inert=true;
      popupAnimation?.cancel();popupAnimation=window.ContourMotion?.popup(list,false);
      const finish=()=>{if(!opened){list.hidden=true;list.inert=false;}};
      if(popupAnimation)popupAnimation.finished.then(finish,()=>{});else finish();
    };
    const sync=()=>{
      const next=JSON.stringify([select.disabled,select.value,options().map(o=>[o.value,o.textContent,o.disabled])]);
      if(next===signature)return;signature=next;
      value.textContent=select.selectedOptions[0]?.textContent || 'No processors available';
      button.disabled=select.disabled || !enabled().length;
      list.replaceChildren(...options().map((o,i)=>{
        const row=document.createElement('div');row.className='select-option';row.id=select.id+'-option-'+i;row.setAttribute('role','option');row.setAttribute('aria-selected',String(o.selected));row.setAttribute('aria-disabled',String(o.disabled));row.textContent=o.textContent;
        row.addEventListener('pointerdown',e=>e.preventDefault());
        row.addEventListener('click',()=>{if(!o.disabled){select.selectedIndex=i;select.dispatchEvent(new Event('change',{bubbles:true}));sync();close();button.focus();}});
        return row;
      }));
      if(button.disabled)close();else if(opened){position();highlight();}
    };
    const open=()=>{if(button.disabled)return;closeAll();popupAnimation?.cancel();sync();active=select.selectedIndex>=0?select.selectedIndex:enabled()[0];opened=true;list.hidden=false;list.inert=false;button.focus({preventScroll:true});button.setAttribute('aria-expanded','true');position();highlight();popupAnimation=window.ContourMotion?.popup(list,true);};
    button.onclick=()=>opened?close():open();
    button.addEventListener('keydown',e=>{
      if(e.key==='Tab'){close();return;}
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();return;}
      const movement=['ArrowDown','ArrowUp','Home','End'].includes(e.key);
      if(movement || e.key==='Enter' || e.key===' '){
        e.preventDefault();e.stopPropagation();if(!opened){open();return;}
        if(e.key==='Enter' || e.key===' '){list.children[active]?.click();return;}
        const indices=enabled(),index=indices.indexOf(active);
        active=e.key==='Home'?indices[0]:e.key==='End'?indices.at(-1):indices[(index+(e.key==='ArrowDown'?1:-1)+indices.length)%indices.length];highlight();
      }else if(e.key.length===1 && !e.ctrlKey && !e.metaKey){
        e.stopPropagation();if(!opened)open();search+=e.key.toLowerCase();clearTimeout(searchTimer);searchTimer=setTimeout(()=>search='',650);
        const found=options().findIndex(o=>!o.disabled && o.textContent.toLowerCase().startsWith(search));if(found>=0){active=found;highlight();}
      }
    });
    select.addEventListener('change',sync);
    new MutationObserver(sync).observe(select,{childList:true,subtree:true,attributes:true});
    dropdowns.push({close,sync,list,button});sync();
  });
  // Preference restoration sets native values programmatically after app_info resolves.
  window.addEventListener('load',()=>dropdowns.forEach(d=>d.sync()));
  document.addEventListener('pointerdown',e=>{if(!e.target.closest('.glass-select,.select-menu'))closeAll();});
  document.addEventListener('focusin',e=>{if(!e.target.closest('.glass-select,.select-menu'))closeAll();});
  document.addEventListener('scroll',e=>{if(!e.target.closest?.('.select-menu'))closeAll();},true);
  window.addEventListener('resize',closeAll);window.addEventListener('blur',closeAll);
  const modal=document.getElementById('models-modal');new MutationObserver(closeAll).observe(modal,{attributes:true,attributeFilter:['hidden']});
  // app.js calls this after asynchronous preference restoration.
  window.closeGlassSelects=closeAll;
  window.syncGlassSelects=()=>dropdowns.forEach(d=>d.sync());
  const api=window.__TAURI__?.window;
  const controls=document.querySelectorAll('.window-btn');
  if(!api){controls.forEach(b=>{b.disabled=true;b.title='Available in the desktop app';});return;}
  const win=api.getCurrentWindow(),max=document.getElementById('window-maximize');
  async function updateMax(){try{const maximized=await win.isMaximized();max.setAttribute('aria-label',maximized?'Restore':'Maximize');max.title=maximized?'Restore':'Maximize';max.innerHTML=maximized?'<svg viewBox="0 0 16 16"><path d="M5.5 5.5v-2h7v7h-2"/><rect x="3.5" y="5.5" width="7" height="7" rx=".6"/></svg>':'<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>';}catch(e){console.warn(e);}}
  const run=async fn=>{try{await fn();}catch(e){console.error('Window control failed',e);const toast=document.getElementById('toast');toast.textContent='Window action unavailable. '+String(e);toast.hidden=false;}};
  document.getElementById('window-minimize').onclick=()=>run(()=>win.minimize());
  max.onclick=()=>run(async()=>{await win.toggleMaximize();await updateMax();});
  // Close for real once the user has confirmed: destroy the window directly (a second close request
  // would just come back through the handler below). If that is refused for any reason, exit the app
  // from the native side, so Contour can never be left stuck open.
  const closeNow=async()=>{
    window.__contourClosing=true;
    try{await win.destroy();}
    catch(e){console.warn('destroy failed, exiting',e);await window.__TAURI__.core.invoke('exit_app');}
  };
  const requestClose=async()=>{if(window.__contourClosing)return;if(await window.contourCanClose?.() !== false)await closeNow();};
  document.getElementById('window-close').onclick=()=>run(requestClose);
  document.querySelector('.bar').addEventListener('mousedown',e=>{
    if(e.button!==0 || e.target.closest('button,input,select,.bar-right'))return;
    e.preventDefault();
    run(async()=>{if(e.detail===2){await win.toggleMaximize();await updateMax();}else await win.startDragging();});
  });
  // Alt+F4, the taskbar's Close, or the OS asking: always handle it ourselves (prevent, confirm, close).
  win.onCloseRequested?.(async e=>{e.preventDefault();await requestClose();}).catch(console.warn);
  win.onResized(updateMax).catch(console.warn);updateMax();
})();
