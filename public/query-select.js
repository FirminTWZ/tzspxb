export function enhanceQuerySelect(select) {
  const field=select.closest(".query-select-field");
  const label=field.querySelector("label");
  const control=document.createElement("div");
  const trigger=document.createElement("button");
  const value=document.createElement("span");
  const action=document.createElement("span");
  const list=document.createElement("ul");
  const error=document.createElement("small");
  const id=select.id;
  let options=[], activeIndex=-1, search="", lastKeyTime=0;

  control.className="query-select-control";
  trigger.className="query-select-trigger";
  trigger.id=id+"-trigger";
  trigger.type="button";
  trigger.setAttribute("role","combobox");
  trigger.setAttribute("aria-labelledby",label.id);
  trigger.setAttribute("aria-controls",id+"-options");
  trigger.setAttribute("aria-required","true");
  label.htmlFor=trigger.id;
  value.className="query-select-value";
  action.className="query-select-action";
  action.setAttribute("aria-hidden","true");
  list.className="query-select-list";
  list.id=id+"-options";
  list.setAttribute("role","listbox");
  list.setAttribute("aria-labelledby",label.id);
  error.className="query-select-error";
  error.id=id+"-error";
  error.hidden=true;
  trigger.setAttribute("aria-describedby",error.id);
  trigger.append(value,action);
  control.append(trigger,list);
  select.after(control,error);
  select.hidden=true;

  function close() {
    list.hidden=true;
    field.removeAttribute("data-opens-up");
    trigger.setAttribute("aria-expanded","false");
    trigger.removeAttribute("aria-activedescendant");
    action.textContent=trigger.disabled?"":select.value?"更改":"选择";
    search="";
  }

  function refresh() {
    options=Array.from(select.options).filter(option=>option.value&&!option.disabled);
    trigger.disabled=select.disabled||options.length===0;
    trigger.toggleAttribute("data-empty",!select.value);
    value.textContent=select.selectedOptions[0]?.textContent??"";
    error.hidden=true;
    trigger.removeAttribute("aria-invalid");
    close();
  }

  function highlight(index) {
    activeIndex=index;
    for (const item of list.children) item.toggleAttribute("data-active",item===list.children[index]);
    const active=list.children[index];
    trigger.setAttribute("aria-activedescendant",active.id);
    if (active.offsetTop<list.scrollTop) list.scrollTop=active.offsetTop;
    const below=active.offsetTop+active.offsetHeight-list.clientHeight;
    if (below>list.scrollTop) list.scrollTop=below;
  }

  function open(last=false) {
    if (trigger.disabled) return;
    const bounds=control.getBoundingClientRect();
    const availableBelow=window.innerHeight-bounds.bottom-10;
    const availableAbove=bounds.top-10;
    const opensUp=availableBelow<Math.min(options.length*42+8,220)&&availableAbove>availableBelow;
    field.toggleAttribute("data-opens-up",opensUp);
    list.style.setProperty("--query-list-height",Math.max(80,Math.min(272,opensUp?availableAbove:availableBelow))+"px");
    list.replaceChildren(...options.map((option,index)=>{
      const item=document.createElement("li");
      item.id=id+"-option-"+index;
      item.dataset.index=index;
      item.setAttribute("role","option");
      item.setAttribute("aria-selected",option.value===select.value);
      item.textContent=option.textContent;
      return item;
    }));
    list.hidden=false;
    trigger.setAttribute("aria-expanded","true");
    action.textContent="收起";
    const selected=options.findIndex(option=>option.value===select.value);
    highlight(selected>=0?selected:last?options.length-1:0);
  }

  function choose(index) {
    const next=options[index].value;
    if (next===select.value) return close();
    select.value=next;
    select.dispatchEvent(new Event("input",{bubbles:true}));
    select.dispatchEvent(new Event("change",{bubbles:true}));
  }

  trigger.addEventListener("click",()=>list.hidden?open():close());
  list.addEventListener("mousedown",event=>event.preventDefault());
  list.addEventListener("click",event=>{
    const item=event.target.closest("[role=option]");
    if (item) choose(Number(item.dataset.index));
  });
  document.addEventListener("pointerdown",event=>{ if (!field.contains(event.target)) close(); });
  trigger.addEventListener("blur",close);
  trigger.addEventListener("keydown",event=>{
    const key=event.key;
    if (key==="Escape" && !list.hidden) {
      event.preventDefault();
      close();
    } else if (key==="Enter" || key===" ") {
      event.preventDefault();
      if (list.hidden) open();
      else choose(activeIndex);
    } else if (key==="ArrowDown" || key==="ArrowUp" || key==="Home" || key==="End") {
      event.preventDefault();
      const wasOpen=!list.hidden;
      if (list.hidden) open(key==="ArrowUp"||key==="End");
      if (key==="Home") highlight(0);
      else if (key==="End") highlight(options.length-1);
      else if (wasOpen) {
        highlight(Math.max(0,Math.min(options.length-1,activeIndex+(key==="ArrowDown"?1:-1))));
      }
    } else if (key.length===1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (list.hidden) open();
      if (event.timeStamp-lastKeyTime>650) search="";
      lastKeyTime=event.timeStamp;
      search+=key.toLocaleLowerCase();
      const match=options.findIndex(option=>option.textContent.toLocaleLowerCase().startsWith(search));
      if (match>=0) highlight(match);
    }
  });
  select.addEventListener("change",refresh);
  select.addEventListener("invalid",event=>{
    event.preventDefault();
    error.textContent=trigger.disabled?value.textContent:"请选择"+label.textContent;
    error.hidden=false;
    trigger.setAttribute("aria-invalid","true");
    if (select.form.querySelector(":invalid")===select && !trigger.disabled) trigger.focus();
  });
  refresh();
  return refresh;
}
