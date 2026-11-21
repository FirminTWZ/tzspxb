const controls=new WeakMap();
const menu=document.createElement("ul");
menu.className="system-select-list";
menu.id="system-select-options";
menu.setAttribute("role","listbox");
menu.hidden=true;
const supportsPopover=typeof menu.showPopover==="function";

let active=null, nextId=0, positionFrame=0;

function closeMenu() {
  if (!active) return;
  const {trigger,action,select}=active;
  active=null;
  if (supportsPopover && menu.matches(":popover-open")) menu.hidePopover();
  menu.hidden=true;
  menu.remove();
  trigger.setAttribute("aria-expanded","false");
  trigger.removeAttribute("aria-controls");
  trigger.removeAttribute("aria-activedescendant");
  action.textContent=trigger.disabled?"":isPlaceholder(select)?"选择":"更改";
}

function isPlaceholder(select) {
  return select.selectedIndex<0 || (select.required && select.value==="");
}

function positionMenu() {
  if (!active) return;
  const bounds=active.trigger.getBoundingClientRect();
  const viewportHeight=document.documentElement.clientHeight;
  if (!bounds.width || bounds.bottom<0 || bounds.top>viewportHeight) return closeMenu();
  const bottomSpace=viewportHeight-bounds.bottom-8, topSpace=bounds.top-8;
  const up=bottomSpace<Math.min(active.options.length*44+8,240) && bottomSpace<topSpace;
  const available=Math.max(40,Math.min(272,up?topSpace:bottomSpace));
  menu.style.left=bounds.left+"px";
  menu.style.width=bounds.width+"px";
  menu.style.maxHeight=available+"px";
  menu.style.top=(up?bounds.top-menu.offsetHeight-4:bounds.bottom+4)+"px";
}

function highlight(index) {
  const option=menu.children[index];
  if (!active || !option) return;
  menu.children[active.index]?.removeAttribute("data-active");
  active.index=index;
  option.setAttribute("data-active","");
  active.trigger.setAttribute("aria-activedescendant",option.id);
  if (option.offsetTop<menu.scrollTop) menu.scrollTop=option.offsetTop;
  const below=option.offsetTop+option.offsetHeight-menu.clientHeight;
  if (below>menu.scrollTop) menu.scrollTop=below;
}

function openMenu(control,last=false) {
  const {select,trigger,action,label}=control;
  if (trigger.disabled) return;
  closeMenu();
  const options=Array.from(select.options).filter(option=>!option.matches(":disabled") && !(select.required && option.value===""));
  if (!options.length) return;
  active={...control,options,index:-1,search:"",lastKey:0};
  menu.setAttribute("aria-label",label);
  menu.replaceChildren(...options.map((option,index)=>{
    const item=document.createElement("li");
    item.id=menu.id+"-"+index;
    item.dataset.index=index;
    item.setAttribute("role","option");
    item.setAttribute("aria-selected",option.selected);
    item.textContent=option.label;
    return item;
  }));
  menu.hidden=false;
  (trigger.closest("dialog")||document.body).append(menu);
  if (supportsPopover) {
    menu.setAttribute("popover","manual");
    menu.showPopover();
  }
  trigger.setAttribute("aria-expanded","true");
  trigger.setAttribute("aria-controls",menu.id);
  action.textContent="收起";
  menu.scrollTop=0;
  positionMenu();
  const selected=options.findIndex(option=>option.selected);
  highlight(selected>=0?selected:last?options.length-1:0);
}

function choose(index) {
  if (!active || !active.options[index]) return;
  const {select,trigger,options}=active;
  const option=options[index];
  closeMenu();
  trigger.focus({preventScroll:true});
  if (select.selectedIndex===option.index) return;
  select.selectedIndex=option.index;
  select.dispatchEvent(new Event("input",{bubbles:true}));
  select.dispatchEvent(new Event("change",{bubbles:true}));
}

function handleKey(event, control) {
  const key=event.key, expanded=active?.trigger===control.trigger;
  if (key==="Tab") {
    if (expanded) closeMenu();
  } else if (key==="Escape") {
    if (expanded) { event.preventDefault(); event.stopPropagation(); closeMenu(); }
  } else if (key==="Enter" || key===" ") {
    event.preventDefault();
    if (expanded) choose(active.index);
    else openMenu(control);
  } else if (["ArrowDown","ArrowUp","Home","End"].includes(key)) {
    event.preventDefault();
    if (!expanded) openMenu(control,key==="ArrowUp"||key==="End");
    if (!active) return;
    const last=active.options.length-1;
    if (key==="Home" || key==="End") highlight(key==="Home"?0:last);
    else if (expanded) highlight(Math.max(0,Math.min(last,active.index+(key==="ArrowDown"?1:-1))));
  } else if (key.length===1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (!expanded) openMenu(control);
    if (!active) return;
    if (event.timeStamp-active.lastKey>650) active.search="";
    active.lastKey=event.timeStamp;
    active.search+=key.toLocaleLowerCase();
    const index=active.options.findIndex(option=>option.label.toLocaleLowerCase().startsWith(active.search));
    if (index>=0) highlight(index);
  }
}

function refresh(control) {
  const {select,trigger,value,action,error}=control;
  if (active?.select===select) closeMenu();
  const options=Array.from(select.options);
  trigger.disabled=select.matches(":disabled") || !options.some(option=>!option.matches(":disabled") && (!select.required||option.value));
  trigger.setAttribute("aria-required",select.required?"true":"false");
  trigger.toggleAttribute("data-empty",isPlaceholder(select));
  value.textContent=select.selectedOptions[0]?.label??"请选择";
  action.textContent=trigger.disabled?"":isPlaceholder(select)?"选择":"更改";
  error.hidden=true;
  trigger.removeAttribute("aria-invalid");
}

function enhance(select) {
  const originalLabel=select.labels[0];
  const label=select.getAttribute("aria-label") || (originalLabel?
    Array.from(originalLabel.childNodes).filter(node=>node!==select).map(node=>node.textContent).join("").trim():"选择选项");
  const wrapper=document.createElement("span");
  const trigger=document.createElement("button");
  const value=document.createElement("span");
  const action=document.createElement("span");
  const error=document.createElement("small");
  const id=select.id||"system-select-"+(++nextId);
  wrapper.className="system-select-control";
  trigger.className="system-select-trigger";
  trigger.id=id+"-trigger";
  trigger.type="button";
  trigger.setAttribute("role","combobox");
  trigger.setAttribute("aria-label",label);
  trigger.setAttribute("aria-haspopup","listbox");
  trigger.setAttribute("aria-expanded","false");
  if (originalLabel) originalLabel.htmlFor=trigger.id;
  value.className="system-select-value";
  action.className="system-select-action";
  action.setAttribute("aria-hidden","true");
  error.className="system-select-error";
  error.id=id+"-error";
  trigger.setAttribute("aria-describedby",error.id);
  trigger.append(value,action);
  wrapper.append(trigger,error);
  select.after(wrapper);
  select.classList.add("system-select-source");
  select.hidden=true;
  const control={select,trigger,value,action,error,label};
  controls.set(select,control);
  trigger.addEventListener("click",()=>active?.trigger===trigger?closeMenu():openMenu(control));
  trigger.addEventListener("keydown",event=>handleKey(event,control));
  select.addEventListener("change",()=>refresh(control));
  select.addEventListener("invalid",event=>{
    event.preventDefault();
    error.textContent=trigger.disabled?value.textContent:"请选择"+label;
    error.hidden=false;
    trigger.setAttribute("aria-invalid","true");
    if (select.form?.querySelector(":invalid")===select && !trigger.disabled) trigger.focus();
  });
  return control;
}

export function refreshSelect(select) {
  const control=controls.get(select)??enhance(select);
  refresh(control);
  return control.trigger;
}

export function startCustomSelects() {
  document.querySelectorAll("select").forEach(refreshSelect);
  const observer=new MutationObserver(records=>{
    const changed=new Set();
    for (const record of records) {
      const target=record.target;
      const select=target instanceof Element?target.closest("select"):target.parentElement?.closest("select");
      if (select) changed.add(select);
      else if (record.type==="attributes" && target.matches("fieldset")) target.querySelectorAll("select").forEach(node=>changed.add(node));
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches("select")) changed.add(node);
        else node.querySelectorAll("select:not(.system-select-source)").forEach(child=>changed.add(child));
      }
    }
    for (const select of changed) if (select.isConnected) refreshSelect(select);
    if (active && !active.trigger.isConnected) closeMenu();
  });
  observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:["disabled","required","selected","label"]});
  document.addEventListener("reset",event=>queueMicrotask(()=>event.target.querySelectorAll("select").forEach(refreshSelect)));
  document.addEventListener("pointerdown",event=>{
    if (active && !active.trigger.contains(event.target) && !menu.contains(event.target)) closeMenu();
  });
  document.addEventListener("focusin",event=>{
    if (active && active.trigger!==event.target && !menu.contains(event.target)) closeMenu();
  });
  document.addEventListener("close",event=>{
    if (active && event.target.contains(active.trigger)) closeMenu();
  },true);
  menu.addEventListener("mousedown",event=>event.preventDefault());
  menu.addEventListener("click",event=>{
    const item=event.target.closest("[role=option]");
    if (item) choose(Number(item.dataset.index));
  });
  const reposition=event=>{
    if (!active || positionFrame || event.target===menu) return;
    positionFrame=requestAnimationFrame(()=>{ positionFrame=0; positionMenu(); });
  };
  window.addEventListener("scroll",reposition,true);
  window.addEventListener("resize",reposition);
}
