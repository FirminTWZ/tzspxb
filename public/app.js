import { attendanceOptions, attendanceStatuses, legacyAttendancePolicy } from "./attendance-policy.js";

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let data=null, editingStudent=null, accountsData=null, dashboardVersion=0;
const completionStyle=document.createElement("style");completionStyle.textContent=".completion-box{margin:22px 0 4px;padding:18px 20px;background:#faf7f7;border:1px solid #eadcdf;border-radius:12px}.completion-summary{display:flex;align-items:center;justify-content:space-between;gap:18px;font-size:.95rem}.required-earned{color:var(--muted);text-align:right}.required-earned strong{color:var(--ink);font-size:1.05rem}.completion-requirement{margin-top:15px;padding-top:14px;border-top:1px solid #eadcdf;color:var(--red);font-size:1rem;letter-spacing:.01em}@media(max-width:520px){.completion-box{padding:16px}.completion-summary{align-items:flex-start;flex-direction:column;gap:10px}.required-earned{text-align:left}.completion-requirement{line-height:1.8}}";document.head.append(completionStyle);
$(".admin-tabs").insertAdjacentHTML("beforeend",'<button class="tab-btn" data-tab="cohorts">培训班/团校管理</button>');
$("#dashboard").insertAdjacentHTML("beforeend",'<section class="panel tab-panel hidden" id="tab-cohorts"><div class="panel-head"><div><h2>培训班/团校管理</h2><p>新增培训班/团校，或修改现有名称。</p></div></div><form id="cohort-form" class="cohort-form"><input type="hidden" name="id"><label>培训班/团校名称<input name="name" maxlength="100" required placeholder="例如：北京大学2026级团支书培训班"></label><button class="primary">保存名称</button><button class="ghost hidden" type="button" id="cohort-cancel">取消编辑</button></form><div id="cohort-list" class="cohort-list"></div></section>');
$("#stat-grid").insertAdjacentHTML("afterend",'<div id="hypothetical-stat-grid" class="stat-grid" aria-label="假定必修课程已完成时的结业率"></div>');
$(".admin-tabs").insertAdjacentHTML("beforeend",'<button class="tab-btn hidden" id="accounts-tab-btn" data-tab="accounts">账号与权限</button>');
let cohortList=[];
const registrationForm=$("#registration-form");
function showAuthMessage(message, error=false) {
  const status=$("#auth-message");
  status.textContent=message;
  status.classList.toggle("hidden",!message);
  status.classList.toggle("auth-error",error);
}

function switchAuth(mode) {
  $("#login-form").classList.toggle("hidden",mode!=="login");
  registrationForm.classList.toggle("hidden",mode!=="register");
  $$("[data-auth]").forEach(button=>button.setAttribute("aria-pressed",button.dataset.auth===mode));
  showAuthMessage("");
  if (mode==="register") updateRegistrationScope().catch(error=>showAuthMessage(error.message,true));
}

async function loadGroupOptions(form, selected="") {
  const cohortId=form.elements.cohortId.value;
  const groupSelect=form.elements.groupName;
  groupSelect.replaceChildren(new Option(cohortId?"正在加载小组…":"请先选择培训班/团校",""));
  if (!cohortId) return;
  const {groups=[]}=await request(`/api/meta?cohortId=${encodeURIComponent(cohortId)}`);
  if (form.elements.cohortId.value!==cohortId) return;
  groupSelect.replaceChildren(
    new Option(groups.length?"请选择负责小组":"该培训班/团校暂无小组",""),
    ...groups.map(group=>new Option(group,group))
  );
  if (groups.includes(selected)) groupSelect.value=selected;
}

async function updateRegistrationScope() {
  const isLiaison=registrationForm.elements.role.value==="liaison";
  const scope=$("#registration-org-scope");
  scope.classList.toggle("hidden",isLiaison);
  scope.disabled=isLiaison;
  $$(".registration-scope").forEach(label=>label.classList.toggle("hidden",!isLiaison));
  for (const name of ["cohortId","groupName"]) registrationForm.elements[name].disabled=!isLiaison;
  if (isLiaison) await loadGroupOptions(registrationForm, registrationForm.elements.groupName.value);
}

$$("[data-auth]").forEach(button=>button.onclick=()=>switchAuth(button.dataset.auth));
registrationForm.elements.role.onchange=registrationForm.elements.cohortId.onchange=()=>{
  updateRegistrationScope().catch(error=>showAuthMessage(error.message,true));
};
registrationForm.onsubmit=async event=>{
  event.preventDefault();
  const submit=event.submitter;
  const fields=accountFormFields(registrationForm);
  submit.disabled=true;
  showAuthMessage("");
  try {
    await request("/api/admin/register",{method:"POST",body:JSON.stringify(fields)});
    registrationForm.reset();
    $("#login-form").elements.username.value=fields.username.trim();
    const firstCohort=fields.cohortId??fields.cohortIds?.[0];
    if (firstCohort) $("#admin-cohort").value=String(firstCohort);
    switchAuth("login");
    showAuthMessage("注册申请已提交。审批通过后可登录。");
  } catch(error) {
    showAuthMessage(error.message,true);
  } finally {
    submit.disabled=false;
  }
};
async function request(path,options={}){const res=await fetch(path,{headers:{"Content-Type":"application/json",...(options.headers||{})},...options});const out=await res.json().catch(()=>({}));if(!res.ok){const e=new Error(out.error||"操作失败");e.status=res.status;throw e}return out}
function esc(v){const d=document.createElement("div");d.textContent=String(v??"");return d.innerHTML}function toast(v){const e=$("#toast");e.textContent=v;e.classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove("show"),2800)}
const typeName=v=>v==="undergraduate"?"本科生":"硕博生",statusName=v=>v==="attended"?"现场出勤":v==="makeup"?"完成补修":v==="special"?"特殊课程":"未参加",categoryName=v=>v==="required"?"必修课程":"选修课程";
function setCohortOptions(select, cohorts, prompt, autoSelect=false) {
  const previous=select.value;
  select.replaceChildren(new Option(prompt,""), ...cohorts.map(cohort=>new Option(cohort.name,cohort.id)));
  if (cohorts.some(cohort=>String(cohort.id)===previous)) select.value=previous;
  else if (autoSelect) select.value=String(cohorts[0]?.id??"");
}

function selectedCohortIds(container) {
  return [...container.querySelectorAll('input[name="cohortIds"]:checked')].map(input=>Number(input.value));
}

function setScopeChoices(container, cohorts, selected=selectedCohortIds(container)) {
  const checked=new Set(selected);
  container.replaceChildren(...cohorts.map(cohort=>{
    const label=document.createElement("label"), checkbox=document.createElement("input");
    checkbox.type="checkbox";
    checkbox.name="cohortIds";
    checkbox.value=cohort.id;
    checkbox.checked=checked.has(cohort.id);
    label.append(checkbox,cohort.name);
    return label;
  }));
  if (!cohorts.length) container.textContent="暂无可选的培训班/团校。";
}

function accountFormFields(form) {
  const formData=new FormData(form), fields=Object.fromEntries(formData);
  if (fields.role==="org") fields.cohortIds=formData.getAll("cohortIds").map(Number);
  return fields;
}

async function loadMeta() {
  try {
    const {cohorts}=await request("/api/meta");
    cohortList=cohorts;
    for (const id of ["#query-cohort","#admin-cohort","#registration-cohort"]) {
      setCohortOptions($(id),cohortList,"请选择培训班/团校",true);
    }
    setScopeChoices($("#registration-org-scope .cohort-choices"),cohortList);
    await loadDepartments();
    renderCohorts();
    if (!$("#registration-form").classList.contains("hidden")) await updateRegistrationScope();
  } catch (error) {
    toast("培训班/团校信息暂时无法加载");
  }
}
function switchView() {
  const view=location.hash==="#admin"?"admin":"query";
  document.documentElement.dataset.view=view;
  $$(".nav-btn").forEach(link=> {
    if (link.dataset.view===view) link.setAttribute("aria-current","page");
    else link.removeAttribute("aria-current");
  });
  if (view==="admin") loadDashboard();
  else loadMeta();
}
window.addEventListener("hashchange",switchView);

$("#query-form").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,out=$("#query-result");form.classList.add("loading");try{const formData=new FormData(form),studentType=formData.get("studentType"),r=await request("/api/query",{method:"POST",body:JSON.stringify(Object.fromEntries(formData))}),totalNeed=r.thresholds[studentType];out.innerHTML=`<div class="result-top"><div><h2>${esc(r.name)}</h2><div class="result-identity"><span>${esc(r.department)}</span></div></div><div class="credit">${r.totalCredits}<small> 学分</small></div></div><div class="completion-box"><div class="completion-summary"><span>结业状态　<strong class="status ${r.completed?'pass':'pending'}">${r.withdrawn?'已退出／休学':r.completed?'已结业':'暂未结业'}</strong></span><span class="required-earned">已修必修课学分　<strong>${r.requiredCredits} 分</strong></span></div><div class="completion-requirement"><strong>结业要求：结业学分 ${totalNeed} 分　必修学分 ${r.thresholds.required} 分</strong></div></div><div class="course-history"><h3>课程出勤记录（${r.courses.length} 门）</h3>${r.courses.length?r.courses.map(c=>`<div class="history-item"><div><strong>${esc(c.name)}</strong><small>${categoryName(c.category)} · ${statusName(c.status)}</small></div><span class="history-credit">${c.credits} 学分</span></div>`).join(""):'<p class="muted">暂未记录出勤课程</p>'}</div><p class="privacy-note">本页仅展示姓名、院系、结业状态、学分与本人课程出勤记录。</p>`}catch(err){out.innerHTML=`<div class="error-box">${esc(err.message)}</div>`}finally{out.classList.remove("hidden");form.classList.remove("loading")}};

$("#login-form").onsubmit=async event=>{
  event.preventDefault();
  const form=event.currentTarget;
  const submit=form.querySelector("button[type=submit],button.primary");
  submit.disabled=true;
  showAuthMessage("");
  try {
    const result=await request("/api/admin/login",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    dashboardVersion++;
    data=result.dashboard;
    $("#admin-login").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    $(".tab-btn[data-tab='students']").click();
    render();
    form.elements.password.value="";
    toast("登录成功");
  } catch (error) {
    showAuthMessage(error.message,true);
  } finally {
    submit.disabled=false;
  }
};
async function loadDashboard() {
  const version=++dashboardVersion;
  try {
    const result=await request("/api/admin/dashboard");
    if (version!==dashboardVersion) return;
    data=result;
    $("#admin-login").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    render();
  } catch(error) {
    if (version!==dashboardVersion) return;
    if (error.status===401) showSignedOut();
    else toast(error.message);
  }
}
function card(label,s,status="结业"){return`<div class="stat-card"><span class="label">${label}</span><div class="metric"><strong>${s.rate}%</strong><small>${s.passed}/${s.count} 人${status}<br>平均 ${s.average} 学分</small></div></div>`}
function render(){const s=data.stats;$(".dash-head p").textContent=`${data.cohort?.name||"培训班/团校管理"} · ${data.user.roleName}`;$("#stat-grid").innerHTML=card("总体结业率（满足必修）",s.total)+card("本科生结业率（满足必修）",s.undergraduate)+card("硕博生结业率（满足必修）",s.graduate);$("#settings-form").elements.undergraduate.value=data.thresholds.undergraduate;$("#settings-form").elements.graduate.value=data.thresholds.graduate;$("#settings-form").elements.required.value=data.thresholds.required;$("#accounts-tab-btn").classList.toggle("hidden",!data.user.canManageAccounts);$$('#tab-courses,#tab-settings,#tab-cohorts').forEach(x=>x.classList.toggle('role-hidden',!data.user.canEdit));$$('.tab-btn[data-tab="courses"],.tab-btn[data-tab="settings"],.tab-btn[data-tab="cohorts"]').forEach(x=>x.classList.toggle('hidden',!data.user.canEdit));$$('#new-student-btn,#template-download,#export-download,.file-btn').forEach(x=>x.classList.toggle('hidden',!data.user.canEdit));$("#type-chart").innerHTML=`<div class="chart-row"><div class="chart-label"><span>本科生</span><strong>${s.undergraduate.count} 人</strong></div><div class="chart-bar"><i style="width:${s.undergraduate.count*100/Math.max(s.total.count,1)}%"></i></div></div><div class="chart-row"><div class="chart-label"><span>硕博生</span><strong>${s.graduate.count} 人</strong></div><div class="chart-bar"><i style="width:${s.graduate.count*100/Math.max(s.total.count,1)}%"></i></div></div><p class="muted">另有 ${s.withdrawn} 人已退出／休学，未计入以上人数。</p>`;renderStudents();renderCourses();renderCohorts()}
function renderStudents(){const q=$("#student-search").value.trim().toLowerCase(),show=$("#show-withdrawn").checked;const rows=data.records.filter(r=>(show||!r.withdrawn)&&(!q||[r.name,r.department,r.groupName,r.groupContact].some(x=>String(x).toLowerCase().includes(q))));$("#student-count").textContent=`显示 ${rows.length} / ${data.records.length} 人`;$("#students-body").innerHTML=rows.length?rows.map(r=>`<tr class="${r.withdrawn?'withdrawn-row':''}"><td><strong>${esc(r.name)}</strong></td><td>${esc(r.department)}</td><td>${esc(r.groupName||'—')}</td><td>${typeName(r.studentType)}</td><td><strong>${r.totalCredits}</strong></td><td>${r.requiredCredits}</td><td>${r.courseCount}</td><td><span class="status ${r.withdrawn?'pending':'pass'}">${r.withdrawn?'已退出／休学':'在班'}</span></td><td><span class="status ${r.completed?'pass':'pending'}">${r.completed?'已结业':'未结业'}</span></td><td class="row-actions"><button class="small-btn primary-link" data-attendance="${r.id}">课程记录</button>${data.user.canEdit?`<button class="small-btn" data-edit-student="${r.id}">编辑</button>`:''}</td></tr>`).join(""):'<tr><td colspan="10" class="empty-cell">暂无匹配学员</td></tr>'}
function renderCourses(){$("#courses-body").innerHTML=data.courses.length?data.courses.filter(c=>c.active).map(c=>`<tr><td>${c.sortOrder}</td><td><strong>${esc(c.name)}</strong></td><td><span class="course-type ${c.category}">${categoryName(c.category)}</span></td><td>${c.credits}</td><td class="row-actions"><button class="small-btn primary-link" data-course-roster="${c.id}">登记出勤</button><button class="small-btn" data-edit-course="${c.id}">编辑</button><button class="delete-btn" data-delete-course="${c.id}">停用</button></td></tr>`).join(""):'<tr><td colspan="5" class="empty-cell">暂无课程</td></tr>'}
$$(".tab-btn").forEach(b=>b.onclick=()=>{$$(".tab-btn").forEach(x=>x.classList.toggle("active",x===b));$$(".tab-panel").forEach(x=>x.classList.add("hidden"));$(`#tab-${b.dataset.tab}`).classList.remove("hidden");if(b.dataset.tab==="accounts")loadAccounts()});
function renderCohorts() {
  const box=$("#cohort-list"), form=$("#cohort-form");
  if (!box) return;
  const org=data?.user.role==="org";
  const allowed=new Set(data?.user.cohortIds??[]);
  const cohorts=org?cohortList.filter(cohort=>allowed.has(cohort.id)):cohortList;
  $("#tab-cohorts .panel-head p").textContent=org
    ?"可修改已授权的培训班/团校名称。"
    :"新增培训班/团校，或修改现有名称。";
  form.classList.toggle("hidden",org && !form.elements.id.value);
  box.innerHTML=cohorts.map(cohort=>`<div class="cohort-item"><div>
    <strong>${esc(cohort.name)}</strong>${data?.cohort?.id===cohort.id?'<small>当前管理</small>':""}
    </div><button class="small-btn" data-edit-cohort="${cohort.id}">修改名称</button></div>`
  ).join("");
}
$("#cohort-list").onclick=e=>{const id=Number(e.target.dataset.editCohort);if(!id)return;const c=cohortList.find(x=>x.id===id),f=$("#cohort-form");f.classList.remove("hidden");f.elements.id.value=c.id;f.elements.name.value=c.name;$("#cohort-cancel").classList.remove("hidden");f.elements.name.focus()};
$("#cohort-cancel").onclick=()=>{$("#cohort-form").reset();$("#cohort-form").elements.id.value="";$("#cohort-cancel").classList.add("hidden");renderCohorts()};
$("#cohort-form").onsubmit=async e=>{e.preventDefault();try{await request("/api/admin/cohorts",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});e.currentTarget.reset();$("#cohort-cancel").classList.add("hidden");await loadMeta();if(data?.cohort)await loadDashboard();toast("培训班/团校已保存")}catch(err){toast(err.message)}};
$("#student-search").oninput=renderStudents;$("#show-withdrawn").onchange=renderStudents;
function showSignedOut() {
  dashboardVersion++;
  data=null;
  accountsData=null;
  selectedLiaisonIds.clear();
  permissionForm.reset();
  $("#liaison-permissions").open=false;
  $("#account-list").replaceChildren();
  $("#registration-list").replaceChildren();
  $("#registration-count").textContent="";
  resetAccountEditor();
  for (const dialog of $$("dialog[open]")) dialog.close();
  $("#dashboard").classList.add("hidden");
  $("#admin-login").classList.remove("hidden");
}
$("#logout-btn").onclick=async()=>{
  try {
    await request("/api/admin/logout",{method:"POST",body:"{}"});
    showSignedOut();
  } catch(error) {
    toast(error.message);
  }
};

function openStudent(r=null){editingStudent=r;const f=$("#student-form");f.reset();if(r)for(const [k,v]of Object.entries(r)){if(f.elements[k]){if(f.elements[k].type==="checkbox")f.elements[k].checked=!!v;else f.elements[k].value=v??""}}$("#student-dialog").showModal()}
$("#new-student-btn").onclick=()=>openStudent();$("#students-body").onclick=async e=>{const edit=e.target.dataset.editStudent,att=e.target.dataset.attendance;if(edit)openStudent(data.records.find(r=>r.id===Number(edit)));if(att)openAttendance(Number(att))};
$("#student-form").onsubmit=async e=>{e.preventDefault();if(e.submitter?.value==="cancel")return $("#student-dialog").close();const o=Object.fromEntries(new FormData(e.currentTarget));o.withdrawn=e.currentTarget.elements.withdrawn.checked;if(editingStudent)o.id=editingStudent.id;try{await request("/api/admin/students",{method:"POST",body:JSON.stringify(o)});$("#student-dialog").close();await loadDashboard();await loadMeta();toast("学员信息已保存")}catch(err){toast(err.message)}};

function openCourse(c=null){const f=$("#course-form");f.reset();f.elements.sortOrder.value=c?.sortOrder??data.courses.length+1;if(c)for(const[k,v]of Object.entries(c))if(f.elements[k])f.elements[k].value=v??"";$("#course-dialog").showModal()}
$("#new-course-btn").onclick=()=>openCourse();$("#courses-body").onclick=async e=>{const edit=e.target.dataset.editCourse,del=e.target.dataset.deleteCourse,roster=e.target.dataset.courseRoster;if(edit)openCourse(data.courses.find(c=>c.id===Number(edit)));if(roster)openCourseRoster(Number(roster));if(del&&confirm("停用后，该课程不再计入任何学员总学分。确定继续吗？")){await request(`/api/admin/courses/${del}`,{method:"DELETE"});await loadDashboard();toast("课程已停用")}};
$("#course-form").onsubmit=async e=>{e.preventDefault();if(e.submitter?.value==="cancel")return $("#course-dialog").close();try{await request("/api/admin/courses",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});$("#course-dialog").close();await loadDashboard();toast("课程已保存")}catch(err){toast(err.message)}};
function availableAttendanceStatuses(policy, category, status, withdrawn) {
  const allowed=attendanceOptions(policy,category,status,withdrawn);
  return [status,...allowed.filter(value=>value!==status)];
}

function attendanceSelect(choices, status, name) {
  return `<select aria-label="${esc(name)}" ${choices.length===1?"disabled":""}>${choices.map(value=>
    `<option value="${value}" ${value===status?"selected":""}>${statusName(value)}${value==="special"?"（8学分）":""}</option>`
  ).join("")}</select>`;
}

function earnedCredits(status, credits, override=null) {
  return status==="special"?(override??8):status?(override??credits):0;
}

function changedAttendanceRows(container, idField) {
  return [...container.querySelectorAll(".attendance-row")].map(row=>({
    [idField]:Number(row.dataset[idField]),
    expectedStatus:row.dataset.originalStatus,
    status:row.querySelector("select").value
  })).filter(item=>item.status!==item.expectedStatus);
}

async function saveAttendanceChanges(event, path, payload, dialog, success) {
  const button=event.currentTarget.querySelector("[type=submit]");
  if (!payload.items.length) {
    toast("没有需要保存的出勤修改");
    return;
  }
  button.disabled=true;
  try {
    await request(path,{method:"POST",body:JSON.stringify(payload)});
    dialog.close();
    await loadDashboard();
    toast(success);
  } catch(error) {
    toast(error.message);
  } finally {
    button.disabled=false;
  }
}

async function openAttendance(id) {
  try {
    const record=await request("/api/admin/students/"+id);
    const form=$("#attendance-form"), policy=record.attendancePolicy;
    form.elements.studentId.value=id;
    $("#attendance-title").textContent=record.student.name+"的课程记录";
    $("#attendance-policy-description").textContent=policyDescription(policy);
    let editable=false;
    $("#attendance-list").innerHTML=record.attendance.map(course=>{
      const status=course.status??"";
      const choices=availableAttendanceStatuses(policy,course.category,status,record.student.withdrawn);
      if (choices.length>1) editable=true;
      return `<div class="attendance-row" data-course-id="${course.courseId}" data-original-status="${status}"
          data-credits="${course.credits}" data-credit-override="${course.creditOverride??""}">
        <div><strong>${esc(course.name)}</strong><small>${categoryName(course.category)} · 标准 ${course.credits} 学分</small></div>
        ${attendanceSelect(choices,status,course.name+"的出勤状态")}
        <strong>${earnedCredits(status,course.credits,course.creditOverride)} 分</strong>
      </div>`;
    }).join("");
    form.querySelector("[type=submit]").classList.toggle("hidden",!editable);
    $("#attendance-dialog").showModal();
  } catch(error) {
    toast(error.message);
  }
}

function updateAttendanceCredits(event) {
  if (event.target.tagName!=="SELECT") return;
  const row=event.target.closest(".attendance-row"), status=event.target.value;
  const override=status===row.dataset.originalStatus&&row.dataset.creditOverride!==""?Number(row.dataset.creditOverride):null;
  row.querySelector(":scope>strong").textContent=earnedCredits(status,Number(row.dataset.credits),override)+" 分";
}
$("#attendance-list").onchange=updateAttendanceCredits;
$("#attendance-form").onsubmit=event=>{
  event.preventDefault();
  const studentId=Number(event.currentTarget.elements.studentId.value);
  const items=changedAttendanceRows($("#attendance-list"),"courseId");
  return saveAttendanceChanges(event,"/api/admin/attendance",{studentId,items},$("#attendance-dialog"),"课程记录已保存");
};


$("#settings-form").onsubmit=async e=>{e.preventDefault();try{await request("/api/admin/settings",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});await loadDashboard();toast("结业标准已更新")}catch(err){toast(err.message)}};

const roleName=v=>v==="super"?"校团委组织部":v==="org"?"校团委组织部骨干":"小组联络员";
function toggleAccountScope() {
  const form=$("#account-form"), isLiaison=form.elements.role.value==="liaison";
  const scope=$("#account-org-scope"), isOrg=form.elements.role.value==="org";
  scope.classList.toggle("hidden",!isOrg);
  scope.disabled=!isOrg;
  $$(".account-scope").forEach(label=>label.classList.toggle("hidden",!isLiaison));
  for (const name of ["cohortId","groupName"]) {
    form.elements[name].disabled=!isLiaison;
    form.elements[name].required=isLiaison;
  }
}

function accountScope(account) {
  if (account.role==="liaison") return `${esc(account.cohortName||"培训班/团校已移除")} · ${esc(account.groupName)}`;
  if (account.role==="org") return (account.cohorts??[]).map(cohort=>esc(cohort.name)).join("、") || "尚未授权";
  return "全部培训班/团校";
}

const permissionForm=$("#liaison-permission-form");
const selectedLiaisonIds=new Set();

function policyDescription(policy) {
  if (policy.mode==="manager") return "可登记现场出勤、完成补修、未参加或特殊课程。";
  if (policy.mode==="readonly") return "仅查看本组出勤。";
  if (policy.mode==="legacy") return "仅可为本组未参加必修课的学员登记完成补修。";
  const courses=policy.scope==="all"?"必修和选修课":"必修课";
  return courses+"可登记为"+policy.statuses.map(statusName).join("、")+"。";
}

function setPolicyFields(policy) {
  permissionForm.elements.mode.value=policy?.mode??"inherit";
  permissionForm.elements.scope.value=policy?.scope??"required";
  permissionForm.querySelectorAll("[name=statuses]").forEach(input=>{
    input.checked=policy?.statuses?.includes(input.value)??false;
  });
  updatePermissionForm();
}

function updatePermissionForm() {
  const {target,cohortId,mode}=permissionForm.elements;
  const byCohort=target.value==="cohort";
  $("#liaison-policy-cohort-field").classList.toggle("hidden",!byCohort);
  cohortId.required=byCohort;
  mode.querySelector('[value="inherit"]').disabled=byCohort;
  $("#liaison-custom-policy").classList.toggle("hidden",mode.value!=="custom");
  const paragraph=$("#liaison-policy-summary");
  if (byCohort) {
    const cohort=accountsData?.cohorts.find(item=>String(item.id)===cohortId.value);
    paragraph.textContent=cohort
      ? "当前整班设置："+policyDescription(cohort.attendancePolicy??legacyAttendancePolicy)+" 保存后覆盖该班所有联络员的单独设置，也适用于今后新增的联络员。"
      : "请选择要统一设置出勤权限的培训班/团校。";
  } else {
    paragraph.textContent="已选 "+selectedLiaisonIds.size+" 个联络员账号，可在下方列表勾选。";
  }
  permissionForm.querySelector("[type=submit]").disabled=byCohort?!cohortId.value:!selectedLiaisonIds.size;
  $("#liaison-selection-count").textContent="已选 "+selectedLiaisonIds.size+" 个联络员";
  $("#edit-selected-liaisons").disabled=!selectedLiaisonIds.size;
}

function loadCohortPolicyFields() {
  const cohort=accountsData?.cohorts.find(item=>String(item.id)===permissionForm.elements.cohortId.value);
  setPolicyFields(cohort?.attendancePolicy??legacyAttendancePolicy);
}
permissionForm.elements.target.onchange=()=>{
  if (permissionForm.elements.target.value==="cohort") loadCohortPolicyFields();
  else setPolicyFields(null);
};
permissionForm.elements.cohortId.onchange=loadCohortPolicyFields;
permissionForm.elements.mode.onchange=updatePermissionForm;
updatePermissionForm();

function editSelectedPolicy() {
  permissionForm.elements.target.value="accounts";
  const selected=accountsData?.accounts.find(account=>selectedLiaisonIds.has(account.id));
  setPolicyFields(selectedLiaisonIds.size===1?selected?.attendancePolicy:null);
  const editor=$("#liaison-permissions");
  editor.open=true;
  editor.scrollIntoView({block:"nearest"});
  permissionForm.elements.mode.focus({preventScroll:true});
}

$("#select-visible-liaisons").onclick=()=>{
  $$("#account-list [data-select-liaison]").forEach(input=>selectedLiaisonIds.add(Number(input.value)));
  renderAccounts();
};
$("#clear-liaison-selection").onclick=()=>{
  selectedLiaisonIds.clear();
  renderAccounts();
};
$("#edit-selected-liaisons").onclick=editSelectedPolicy;
$("#account-list").onchange=event=>{
  const input=event.target.closest("[data-select-liaison]");
  if (!input) return;
  const id=Number(input.value);
  if (input.checked) selectedLiaisonIds.add(id);
  else selectedLiaisonIds.delete(id);
  updatePermissionForm();
};

permissionForm.onsubmit=async event=>{
  event.preventDefault();
  const fields=new FormData(permissionForm), mode=fields.get("mode"), byCohort=fields.get("target")==="cohort";
  const policy=mode==="inherit"?null:mode==="custom"
    ?{mode,scope:fields.get("scope"),statuses:fields.getAll("statuses")}:{mode};
  if (mode==="custom" && !policy.statuses.length) return toast("请至少勾选一种允许更改的出勤状态");
  const cohort=accountsData?.cohorts.find(item=>String(item.id)===fields.get("cohortId"));
  if (byCohort && (!cohort || !confirm("确定统一设置「"+cohort.name+"」所有联络员的出勤权限？原有单独设置将由整班设置取代。"))) return;
  const accountIds=[...selectedLiaisonIds];
  if (!byCohort && !accountIds.length) return toast("请先选择联络员账号");
  const payload={attendancePolicy:policy,...(byCohort?{cohortId:cohort.id}:{accountIds})};
  const submit=event.submitter;
  submit.disabled=true;
  try {
    const result=await request("/api/admin/liaison-attendance",{method:"PATCH",body:JSON.stringify(payload)});
    selectedLiaisonIds.clear();
    await loadAccounts();
    toast(byCohort
      ?"整班权限已保存，适用于现有 "+result.updated+" 个联络员及以后新增的账号"
      :"已更新 "+result.updated+" 个小组联络员的出勤权限");
  } catch (error) {
    toast(error.message);
  } finally {
    updatePermissionForm();
  }
};

async function loadAccounts() {
  const accountId=data?.user.id;
  const [accounts,registrations]=await Promise.allSettled([
    request("/api/admin/accounts"), request("/api/admin/registrations")
  ]);
  if (!data?.user?.canManageAccounts || data.user.id!==accountId) return;
  if (accounts.status==="fulfilled") {
    accountsData=accounts.value;
    const liaisonIds=new Set(accountsData.accounts.filter(account=>account.role==="liaison"&&account.active).map(account=>account.id));
    for (const id of selectedLiaisonIds) if (!liaisonIds.has(id)) selectedLiaisonIds.delete(id);
    setCohortOptions(permissionForm.elements.cohortId,accountsData.cohorts,"请选择培训班/团校");
    setCohortOptions($("#account-cohort"),accountsData.cohorts,"请选择培训班/团校",true);
    setScopeChoices($("#account-org-scope .cohort-choices"),accountsData.cohorts);
    const cohortFilter=$("#account-cohort-filter"), previous=cohortFilter.value;
    setCohortOptions(cohortFilter,accountsData.cohorts,"不限培训班/团校");
    cohortFilter.add(new Option("全部培训班/团校权限","global"));
    if (previous==="global") cohortFilter.value=previous;
    renderAccounts();
    if (permissionForm.elements.target.value==="cohort") loadCohortPolicyFields();
  } else {
    $("#account-result-count").textContent=accounts.reason.message;
  }
  if (registrations.status==="fulfilled") renderRegistrations(registrations.value.registrations);
  else {
    $("#registration-count").textContent="";
    $("#registration-list").textContent=registrations.reason.message;
  }
}

function renderAccounts() {
  if (!accountsData) return;
  const search=$("#account-search").value.trim().toLowerCase();
  const role=$("#account-role-filter").value, cohort=$("#account-cohort-filter").value;
  const rows=accountsData.accounts.filter(account=>{
    const matchesCohort=!cohort || (cohort==="global"
      ? account.role==="super"
      : account.role==="org"
        ? (account.cohorts??[]).some(item=>String(item.id)===cohort)
        : String(account.cohortId)===cohort);
    return account.username.toLowerCase().includes(search) && (!role || account.role===role) && matchesCohort;
  });
  $("#account-result-count").textContent=`显示 ${rows.length} / ${accountsData.accounts.length} 个账号`;
  $("#account-list").innerHTML=rows.map(account=>{
    const mayDelete=account.id!==data.user.id && account.role!=="super";
    const liaison=account.role==="liaison";
    const policy=account.attendancePolicy??accountsData.cohorts.find(cohort=>cohort.id===account.cohortId)?.attendancePolicy??legacyAttendancePolicy;
    const name=liaison&&account.active
      ? '<label class="inline-check"><input type="checkbox" data-select-liaison value="'+account.id+'" '+(selectedLiaisonIds.has(account.id)?"checked":"")+'><strong>'+esc(account.username)+'</strong></label>'
      : '<strong>'+esc(account.username)+'</strong>';
    const summary=liaison?'<small class="account-policy-label">'+(account.attendancePolicy?"单独设置 · ":"沿用班级 · ")+esc(policyDescription(policy))+'</small>':"";
    const policyButton=liaison&&account.active?'<button class="small-btn" data-edit-policy="'+account.id+'">出勤权限</button>':"";
    return `<div class="account-item">
      ${name}<span>${roleName(account.role)}</span><span>${accountScope(account)}${summary}</span>
      <div class="account-actions"><button class="small-btn" data-edit-account="${account.id}">编辑／改密</button>
      ${policyButton}
      ${mayDelete?`<button class="delete-btn" data-delete-account="${account.id}">删除</button>`:""}</div>
    </div>`;
  }).join("") || '<p class="muted">没有符合条件的账号。</p>';
  updatePermissionForm();
}

function renderRegistrations(registrations) {
  $("#registration-count").textContent=registrations.length?`（${registrations.length}）`:"";
  $("#registration-list").innerHTML=registrations.map(application=>`<div class="account-item" data-registration="${application.id}">
    <strong>${esc(application.username)}</strong><span>${roleName(application.role)}</span><div>
      ${accountScope(application)}
      ${application.role==="org"?`<details class="registration-org-grants" ${application.cohorts?.length?"":"open"}>
        <summary>调整审批范围</summary><div class="cohort-choices"></div></details>`:""}
    </div>
    <div class="account-actions"><button class="small-btn primary-link" data-review="approve">通过</button>
    <button class="delete-btn" data-review="reject">驳回</button></div>
  </div>`).join("") || '<p class="muted">暂无待审批申请。</p>';
  for (const application of registrations) {
    if (application.role!=="org") continue;
    const choices=$(`[data-registration="${application.id}"] .cohort-choices`);
    setScopeChoices(choices,accountsData?.cohorts??cohortList,(application.cohorts??[]).map(cohort=>cohort.id));
  }
}

$("#registration-list").onclick=async event=>{
  const button=event.target.closest("[data-review]");
  if (!button) return;
  const decision=button.dataset.review, row=button.closest("[data-registration]");
  const choices=row.querySelector(".cohort-choices");
  const fields={decision};
  if (decision==="approve" && choices) {
    fields.cohortIds=selectedCohortIds(choices);
    if (!fields.cohortIds.length) {
      choices.closest("details").open=true;
      toast("请至少选择一个授权的培训班/团校");
      return;
    }
  }
  if (!confirm(`确定${decision==="approve"?"通过":"驳回"}账号「${row.querySelector("strong").textContent}」的注册申请？`)) return;
  const buttons=row.querySelectorAll("button");
  buttons.forEach(item=>item.disabled=true);
  try {
    await request(`/api/admin/registrations/${row.dataset.registration}`,{method:"POST",body:JSON.stringify(fields)});
    await loadAccounts();
    toast(decision==="approve"?"已通过，账号可以登录":"已驳回申请");
  } catch(error) {
    toast(error.message);
    buttons.forEach(item=>item.disabled=false);
    if (error.status===404) await loadAccounts();
  }
};

$("#account-search").oninput=renderAccounts;
$("#account-role-filter").onchange=$("#account-cohort-filter").onchange=renderAccounts;
const accountForm=$("#account-form");
$("#account-cohort").onchange=()=>loadGroupOptions(accountForm).catch(error=>toast(error.message));
$("#account-role").onchange=()=>{
  toggleAccountScope();
  if (accountForm.elements.role.value==="liaison") $("#account-cohort").onchange();
};

function resetAccountEditor() {
  accountForm.reset();
  accountForm.elements.id.value="";
  accountForm.elements.role.querySelector('[value="super"]').disabled=true;
  $("#account-editor-title").textContent="新增账号";
  $("#account-org-help").textContent="至少选一项，可多选。";
  setScopeChoices($("#account-org-scope .cohort-choices"),accountsData?.cohorts??[],[]);
  toggleAccountScope();
  $("#account-editor").open=false;
}
$("#account-cancel").onclick=resetAccountEditor;
resetAccountEditor();

$("#account-list").onclick=async event=>{
  const policy=Number(event.target.dataset.editPolicy);
  if (policy) {
    selectedLiaisonIds.clear();
    selectedLiaisonIds.add(policy);
    renderAccounts();
    editSelectedPolicy();
    return;
  }
  const edit=Number(event.target.dataset.editAccount), remove=Number(event.target.dataset.deleteAccount);
  try {
    if (edit) {
      const account=accountsData.accounts.find(item=>item.id===edit);
      if (!account) return toast("账号列表已更新，请重新选择");
      accountForm.reset();
      accountForm.elements.id.value=account.id;
      accountForm.elements.username.value=account.username;
      accountForm.elements.role.querySelector('[value="super"]').disabled=account.role!=="super";
      accountForm.elements.role.value=account.role;
      accountForm.elements.cohortId.value=account.cohortId??"";
      $("#account-org-help").textContent=account.role==="org"?"勾选新增授权，取消勾选撤销授权。清空会撤销全部授权。":"至少选一项，可多选。";
      setScopeChoices($("#account-org-scope .cohort-choices"),accountsData.cohorts,(account.cohorts??[]).map(cohort=>cohort.id));
      toggleAccountScope();
      $("#account-editor-title").textContent=`编辑账号 ${account.username}`;
      $("#account-editor").open=true;
      $("#account-editor").scrollIntoView({block:"nearest"});
      if (account.role==="liaison") await loadGroupOptions(accountForm,account.groupName);
      accountForm.elements.username.focus({preventScroll:true});
    } else if (remove && confirm("确定删除这个后台账号吗？")) {
      await request(`/api/admin/accounts/${remove}`,{method:"DELETE"});
      await loadAccounts();
      toast("账号已删除");
    }
  } catch(error) {
    toast(error.message);
  }
};

accountForm.onsubmit=async event=>{
  event.preventDefault();
  const submit=event.submitter, fields=accountFormFields(accountForm);
  submit.disabled=true;
  try {
    await request("/api/admin/accounts",{method:"POST",body:JSON.stringify(fields)});
    resetAccountEditor();
    await loadAccounts();
    toast("账号与权限已保存");
  } catch(error) {
    toast(error.message);
  } finally {
    submit.disabled=false;
  }
};

function canonicalName(i,h){const fixed=["1031破冰","1115开班仪式＋第一次实务技能培训","第二次实务技能培训","0517第三次实务技能培训"];return fixed[i]||String(h||"").replace(/（[^）]*学分[^）]*）/g,"").trim()}
function courseCredits(i){if(i===0)return 4;if(i===1)return 5;if(i===2)return 2;if(i===3)return 3;return i<=13?2:3}
function parseWorkbook(wb){const sheets=wb.SheetNames.filter(n=>/本科|硕博/.test(n));if(!sheets.length)throw new Error("未找到本科组或硕博组工作表");let courses=[],students=[],attendance=[];for(const sn of sheets){const ws=wb.Sheets[sn],rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:null,raw:true}),headers=rows[0]||[];let end=9;while(end<headers.length&&headers[end]!=null&&String(headers[end]).trim())end++;const type=/本科/.test(sn)?"undergraduate":"graduate";if(!courses.length||end-9>courses.length)courses=Array.from({length:end-9},(_,i)=>({courseKey:`course_${String(i+1).padStart(2,"0")}`,name:canonicalName(i,headers[9+i]),category:i<=3?"required":"elective",credits:courseCredits(i),sortOrder:i+1,sourceHeader:String(headers[9+i]||"")}));let group="",contact="";for(let r=1;r<rows.length;r++){const row=rows[r];group=row[0]??group;contact=row[2]??contact;let name=String(row[3]??"").trim();if(!name)continue;const tail=row.slice(end).filter(v=>v!==null&&v!=="").map(String).join(" "),withdrawn=/休学|退出|退班/.test(name+" "+tail),withdrawalNote=(name.match(/[（(](休学|退出|退班)[）)]/)?.[1]||tail.match(/休学|退出|退班/)?.[0]||"");name=name.replace(/[（(](休学|退出|退班)[）)]/g,"").trim();let sourceTotal=null;for(let c=row.length-1;c>=end;c--)if(typeof row[c]==="number"&&Number.isFinite(row[c])){sourceTotal=row[c];break}const importKey=`${sn}:${r+1}`;students.push({importKey,name,department:String(row[5]??"").trim(),studentType:type,groupName:String(group??"").trim(),groupContact:String(contact??"").trim(),politicalStatus:String(row[4]??"").trim(),leagueBranch:String(row[6]??"").trim(),phone:String(row[7]??"").trim(),email:String(row[8]??"").trim(),withdrawn,withdrawalNote,sourceTotal,note:tail});for(let i=0;i<end-9;i++){const v=row[9+i];if(v==null||v==="")continue;const n=Number(v),status=Math.abs(n-1)<.01?"attended":Math.abs(n-2)<.01?"makeup":"special";attendance.push({studentKey:importKey,courseKey:`course_${String(i+1).padStart(2,"0")}`,status,sourceMark:String(v)})}}}return{students,courses,attendance}}
$("#full-excel-input").onchange=async e=>{const file=e.target.files[0];e.target.value="";if(!file)return;try{const wb=XLSX.read(await file.arrayBuffer(),{type:"array"}),payload=parseWorkbook(wb);if(!confirm(`将导入 ${payload.students.length} 名学员、${payload.courses.length} 门课程和 ${payload.attendance.length} 条出勤记录。继续吗？`))return;const r=await request("/api/admin/import-full",{method:"POST",body:JSON.stringify(payload)});await loadDashboard();await loadMeta();toast(`已导入 ${r.students} 名学员和 ${r.attendance} 条出勤记录`)}catch(err){toast(err.message)}};

if(document.modelContext?.registerTool) {
  Promise.resolve().then(()=>document.modelContext.registerTool({
    name:"query_training_record",
    title:"查询课程与学分",
    description:"根据培训班/团校、姓名、院系、所属小组和学员类型查询本人的总学分及课程出勤。",
    inputSchema:{
      type:"object",
      properties:{
        cohortId:{type:"integer",minimum:1},name:{type:"string"},department:{type:"string"},
        groupName:{type:"string"},studentType:{type:"string",enum:["undergraduate","graduate"]}
      },
      required:["cohortId","name","department","groupName","studentType"],
      additionalProperties:false
    },
    annotations:{readOnlyHint:true,untrustedContentHint:true},
    execute:fields=>request("/api/query",{method:"POST",body:JSON.stringify(fields)})
  })).catch(()=>{});
}
function summarizeCreditEligibility(rows, thresholds) {
  const passed=rows.filter(row=>row.totalCredits>=thresholds[row.studentType]).length;
  const count=rows.length;
  return {
    count,
    passed,
    rate: count?Math.round(passed*1000/count)/10:0,
    average: count?Math.round(rows.reduce((sum,row)=>sum+row.totalCredits,0)*10/count)/10:0
  };
}

function creditOnlyStats() {
  const active=data.records.filter(row=>!row.withdrawn);
  const summarize=rows=>summarizeCreditEligibility(rows,data.thresholds);
  return {
    total:summarize(active),
    undergraduate:summarize(active.filter(row=>row.studentType==="undergraduate")),
    graduate:summarize(active.filter(row=>row.studentType==="graduate"))
  };
}

function renderCompletionCharts(creditOnly) {
  if (!data) return;
  const onlyCredits=$("#completion-mode").value==="credits";
  const stats=onlyCredits?(creditOnly??creditOnlyStats()):data.stats;
  const passedLabel=onlyCredits?"总学分达标":"已结业";
  const remainingLabel=onlyCredits?"总学分未达标":"未结业";
  const rateLabel=onlyCredits?"总学分达标率":"结业率";
  const {total}=stats;
  const scope=[data.cohort?.name,data.user.role==="liaison"?data.user.groupName:null].filter(Boolean);
  $("#completion-scope").textContent=scope.join(" · ");
  $("#completion-note").textContent=`纳入统计 ${total.count} 人，退出或休学的 ${data.stats.withdrawn} 人未计入。`;
  const output=$("#completion-charts");
  if (!total.count) {
    output.innerHTML='<p class="muted">当前范围暂无可统计学员。</p>';
    return;
  }

  const share=group=>group.passed*100/group.count;
  const rows=[["本科生",stats.undergraduate],["硕博生",stats.graduate]].map(([label,group])=>{
    if (!group.count) return `<div class="completion-bar-label"><span>${label}</span><span class="muted">暂无学员</span></div>`;
    return `<div>
      <div class="completion-bar-label"><span>${label}</span><strong>${group.rate}%（${group.passed}/${group.count} 人）</strong></div>
      <div class="completion-track" aria-hidden="true" style="--share:${share(group)}%"><span></span></div>
    </div>`;
  }).join("");

  output.innerHTML=`
    <figure class="completion-figure">
      <figcaption>整体比例</figcaption>
      <div class="completion-pie" aria-hidden="true" style="--share:${share(total)}%"></div>
      <strong class="completion-pie-rate">${total.rate}% ${rateLabel}</strong>
      <ul class="completion-legend">
        <li><span class="completion-swatch" aria-hidden="true"></span>${passedLabel}<strong>${total.passed} 人</strong></li>
        <li><span class="completion-swatch remaining" aria-hidden="true"></span>${remainingLabel}<strong>${total.count-total.passed} 人</strong></li>
      </ul>
    </figure>
    <figure class="completion-figure">
      <figcaption>按学员类型比较${rateLabel}</figcaption>
      <div class="completion-bars">${rows}</div>
      <div class="completion-axis" aria-hidden="true"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
    </figure>`;
}

function renderCompletionOverview() {
  const stats=creditOnlyStats();
  $("#hypothetical-stat-grid").innerHTML=
    card("总体结业率（假定必修完成）",stats.total,"总学分达标")+
    card("本科生结业率（假定必修完成）",stats.undergraduate,"总学分达标")+
    card("硕博生结业率（假定必修完成）",stats.graduate,"总学分达标");
  renderCompletionCharts(stats);
  renderDepartmentCompletion();
  renderCompletionGaps();
}

function renderDepartmentCompletion() {
  if (!data) return;
  const creditOnly=$("#completion-mode").value==="credits";
  const departments=new Map();
  for (const record of data.records) {
    if (record.withdrawn) continue;
    const name=record.department?.trim() || "未填写院系";
    if (!departments.has(name)) departments.set(name,{name,count:0,passed:0});
    const entry=departments.get(name);
    entry.count++;
    if (creditOnly ? record.totalCredits>=data.thresholds[record.studentType] : record.completed) entry.passed++;
  }
  const picker=$("#completion-department");
  const previous=picker.value;
  const byName=(a,b)=>a.name.localeCompare(b.name,"zh-CN");
  const entries=[...departments.values()].sort(byName);
  picker.replaceChildren(new Option("全部院系",""),...entries.map(entry=>new Option(entry.name,entry.name)));
  if (departments.has(previous)) picker.value=previous;

  const sort=$("#completion-department-sort").value;
  const visible=picker.value?[departments.get(picker.value)]:entries;
  if (sort==="rate") visible.sort((a,b)=>b.passed/b.count-a.passed/a.count || b.count-a.count || byName(a,b));
  if (sort==="count") visible.sort((a,b)=>b.count-a.count || byName(a,b));
  const name=creditOnly?"总学分达标率":"正式结业率";
  $("#department-completion-chart").innerHTML=visible.length?`
    <p class="muted department-chart-caption">显示 ${visible.length} 个院系 · ${name}</p>
    <ul class="department-completion-bars">${visible.map(entry=>{
      const percent=100*entry.passed/entry.count;
      return `<li>
        <div class="completion-bar-label"><span>${esc(entry.name)}</span><strong>${Math.round(percent*10)/10}%（${entry.passed}/${entry.count} 人）</strong></div>
        <div class="completion-track" aria-hidden="true" style="--share:${percent}%"><span></span></div>
      </li>`;
    }).join("")}</ul>`:'<p class="muted">当前范围暂无可统计院系。</p>';
}

const completionGapFilters={
  requiredShort:{label:"总学分达标，必修不足",matches:row=>row.progress.totalEnoughRequiredShort},
  requiredOnly:{label:"仅补齐剩余必修即可结业",matches:row=>row.progress.canGraduateWithRequiredOnly},
  noneStudied:{label:"未修任何课程",matches:row=>row.progress.studiedCourses===0},
  one:{label:"最少再修 1 门",matches:row=>row.progress.minimumCourses===1},
  two:{label:"最少再修 2 门",matches:row=>row.progress.minimumCourses===2},
  threePlus:{label:"最少再修 3 门及以上",matches:row=>row.progress.minimumCourses>=3},
  impossible:{label:"修完现有课程仍不足",matches:row=>row.progress.minimumCourses===null},
  incomplete:{label:"全部未结业",matches:row=>!row.completed}
};

function renderCompletionGaps() {
  if (!data) return;
  const active=data.records.filter(row=>!row.withdrawn);
  const summary=$("#completion-gap-summary"), distribution=$("#completion-distribution");
  const picker=$("#completion-roster-filter"), roster=$("#completion-roster-body");
  const countLabel=$("#completion-roster-count");
  if (active.some(row=>!row.progress)) {
    picker.disabled=true;
    countLabel.textContent="待服务器更新并重启后，可查看课程差距和名单。";
    summary.replaceChildren();
    distribution.replaceChildren();
    roster.replaceChildren();
    return;
  }
  picker.disabled=!active.length;
  const incomplete=active.filter(row=>!row.completed).length;
  const selected=picker.value;
  const countFor=key=>active.filter(completionGapFilters[key].matches).length;
  const shortcut=key=>`data-gap-filter="${key}" aria-pressed="${selected===key}"`;
  summary.innerHTML=["requiredShort","requiredOnly","noneStudied"].map(key=>`
    <button type="button" class="completion-gap-tile" ${shortcut(key)}>
      <span>${completionGapFilters[key].label}</span>
      <strong>${countFor(key)} <small>人</small></strong>
    </button>`).join("");
  distribution.innerHTML=incomplete?`
    <p class="muted">共 ${incomplete} 人未结业。点击条形图查看名单。</p>
    <div class="completion-bars">${["one","two","threePlus","impossible"].map(key=>{
      const count=countFor(key);
      return `<button type="button" class="completion-distribution-row" ${shortcut(key)}>
        <span class="completion-bar-label"><span>${completionGapFilters[key].label}</span><strong>${count} 人</strong></span>
        <span class="completion-track" aria-hidden="true" style="--share:${100*count/incomplete}%"><span></span></span>
      </button>`;
    }).join("")}</div>`:`<p class="muted">${active.length?"当前范围内的学员均已结业。":"当前范围暂无可统计学员。"}</p>`;
  renderCompletionRoster(active);
}

function renderCompletionRoster(active) {
  const key=$("#completion-roster-filter").value;
  const filter=completionGapFilters[key];
  const rows=active.filter(filter.matches).sort((a,b)=>
    (a.progress.minimumCourses??Infinity)-(b.progress.minimumCourses??Infinity) ||
    a.department.localeCompare(b.department,"zh-CN") || a.name.localeCompare(b.name,"zh-CN"));
  $("#completion-roster-count").textContent=`${filter.label} · ${rows.length} 人`;
  $("#completion-roster-body").innerHTML=rows.length?rows.map(row=>{
    const minimum=row.progress.minimumCourses;
    return `<tr>
      <td><strong>${esc(row.name)}</strong><small>${esc(row.department||"未填写院系")} · ${esc(row.groupName||"未分组")}</small></td>
      <td>${row.totalCredits} / ${data.thresholds[row.studentType]}</td>
      <td>${row.requiredCredits} / ${data.thresholds.required}</td>
      <td>${row.progress.remainingRequired} 门</td>
      <td>${minimum===null?"现有课程不足":minimum===0?"已结业":minimum+" 门"}</td>
    </tr>`;
  }).join(""):'<tr><td colspan="5" class="muted">本项暂无学员。</td></tr>';
}

$("#completion-mode").onchange=()=>{
  renderCompletionCharts();
  renderDepartmentCompletion();
};
$("#completion-department").onchange=$("#completion-department-sort").onchange=renderDepartmentCompletion;
$("#completion-roster-filter").onchange=renderCompletionGaps;
$("#completion-gaps").onclick=event=>{
  const trigger=event.target.closest("[data-gap-filter]");
  if (!trigger) return;
  const key=trigger.dataset.gapFilter;
  $("#completion-roster-filter").value=key;
  renderCompletionGaps();
  // Restore keyboard focus after the chart buttons have been replaced.
  $(`[data-gap-filter="${key}"]`)?.focus({preventScroll:true});
};
$$("[data-completion-view]").forEach(button=>{
  button.onclick=()=>{
    const view=button.dataset.completionView;
    $$("[data-completion-view]").forEach(item=>{
      item.setAttribute("aria-pressed",String(item===button));
      $(`#completion-${item.dataset.completionView}`).classList.toggle("hidden",item!==button);
    });
    $("#completion-mode-control").classList.toggle("hidden",view==="gaps");
  };
});

// 2026 interface and workflow enhancements
const featureStyle=document.createElement("style");featureStyle.textContent=".bulk-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0}.bulk-tools button{padding:8px 12px}.roster-check{width:20px!important;height:20px;margin:0!important}.guide-content{display:grid;gap:16px}.guide-step{padding:18px;border:1px solid var(--line);border-radius:12px;background:#fafafa}.guide-step h3{margin:0 0 8px;color:var(--red)}.guide-step p,.guide-step li{color:var(--muted)}.guide-credit{margin-top:24px;padding-top:16px;border-top:1px solid var(--line);font-size:.78rem;color:var(--muted);line-height:1.7}.role-hint{margin:0 0 14px;padding:12px 14px;border-radius:10px;background:#f7f1e8;color:#6d4918}.row-actions{white-space:nowrap}@media(max-width:700px){.bulk-tools>*{flex:1}.guide-step{padding:15px}}";document.head.append(featureStyle);

const rosterStyle=document.createElement("style");rosterStyle.textContent=".attendance-row:has(.roster-check){grid-template-columns:auto minmax(180px,1fr) minmax(150px,220px) 70px}.account-scope select{width:100%}@media(max-width:700px){.attendance-row:has(.roster-check){grid-template-columns:auto 1fr}.attendance-row:has(.roster-check)>select,.attendance-row:has(.roster-check)>strong{grid-column:2}}";document.head.append(rosterStyle);

const checkInHeaders={
  name:new Set(["姓名","学员姓名","学生姓名","参与者姓名","参与人姓名","签到姓名","真实姓名"]),
  department:new Set(["院系","学院","所属院系","院系名称"]),
  groupName:new Set(["小组","所属小组","组别","所属组别"])
};

function checkInEntriesFromGrid(values) {
  const rows=values.map(row=>Array.from(row,value=>String(value??"").trim())).filter(row=>row.some(Boolean));
  let header=-1, columns;
  for (let index=0;index<Math.min(rows.length,12);index++) {
    const cells=rows[index].map(cell=>cell.replace(/\s/g,""));
    const matched=Object.fromEntries(Object.entries(checkInHeaders).map(([key,options])=>
      [key,cells.findIndex(cell=>options.has(cell))]));
    if (matched.name>=0) {
      header=index;
      columns=matched;
      break;
    }
  }
  if (header===-1) {
    if (rows.some(row=>row.filter(Boolean).length>1)) throw new Error("多列名单需要「姓名」表头，可另加「院系」「小组」列。");
    return rows.map(row=>({name:row.find(Boolean)}));
  }
  return rows.slice(header+1).filter(row=>row[columns.name]).map(row=>({
    name:row[columns.name],
    department:row[columns.department]||"",
    groupName:row[columns.groupName]||""
  }));
}

function checkInEntriesFromText(text) {
  if (text.includes("\t")) return checkInEntriesFromGrid(text.split(/\r\n?|\n/).map(line=>line.split("\t")));
  return text.split(/[\r\n,，、;；]+/u).map(name=>name.trim())
    .filter(name=>name && !checkInHeaders.name.has(name)).map(name=>({name}));
}

function decodeCheckInText(buffer) {
  const bytes=new Uint8Array(buffer);
  if (bytes[0]===0xff && bytes[1]===0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0]===0xfe && bytes[1]===0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

async function readCheckInEntries(form) {
  const names=form.elements.names.value.trim(), file=form.elements.file.files[0];
  if (names && file) throw new Error("请任选一种方式，粘贴名单或上传文件。");
  if (!file) return checkInEntriesFromText(names);
  if (file.size>2_000_000) throw new Error("文件不能超过 2 MB。");
  const extension=file.name.split(".").at(-1).toLowerCase();
  if (!["xlsx","xls","csv","txt"].includes(extension)) throw new Error("请选择 Excel、CSV 或 TXT 文件。");
  const buffer=await file.arrayBuffer();
  if (extension==="txt") return checkInEntriesFromText(decodeCheckInText(buffer));
  let sheet;
  try {
    const csv=extension==="csv";
    const book=XLSX.read(csv?decodeCheckInText(buffer):buffer,{
      type:csv?"string":"array",raw:true,sheets:0,sheetRows:3013
    });
    sheet=book.Sheets[book.SheetNames[0]];
  } catch {
    throw new Error("无法读取名单文件，请检查文件格式和首张工作表。");
  }
  if (!sheet) throw new Error("首张工作表没有可读取的名单。");
  if (sheet["!fullref"] && XLSX.utils.decode_range(sheet["!fullref"]).e.r>=3013) {
    throw new Error("首张工作表行数超过上限，请将名单拆成多个文件后分别签到。");
  }
  const rows=XLSX.utils.sheet_to_json(sheet,{header:1,raw:false,blankrows:false});
  return checkInEntriesFromGrid(rows);
}

function showCheckInPlan(target, plan) {
  target.innerHTML=`
  <div class="check-in-counts"><strong>可签到 ${plan.ready.length} 人</strong><span>跳过 ${plan.skipped.length} 项</span></div>
  ${plan.ready.length?`<details open><summary>待签到名单</summary><ul class="check-in-results">${plan.ready.map(student=>
    `<li><strong>${esc(student.name)}</strong><span>${esc([student.department,student.groupName].filter(Boolean).join(" · "))}</span></li>`).join("")}</ul></details>`:""}
  ${plan.skipped.length?`<details open><summary>跳过明细</summary><ul class="check-in-results">${plan.skipped.map(row=>
    `<li><strong>${esc([row.name,row.department,row.groupName].filter(Boolean).join(" · "))}</strong><span>${esc(row.reason)}</span></li>`).join("")}</ul></details>`:""}`;
  target.hidden=false;
}

function bindCheckIn(courseId, roster, rosterDialog) {
  $("#roster-check-in").onclick=()=>{
    const form=$("#check-in-form"), dialog=$("#check-in-dialog");
    const prepare=$("#check-in-prepare"), commit=$("#check-in-confirm"), cancel=$("#check-in-cancel");
    const preview=$("#check-in-preview"), message=$("#check-in-message");
    const endpoint=`/api/admin/courses/${courseId}/check-in`;
    const current=new Map(roster.students.map(student=>[student.id,student.status||""]));
    let entries, plan, busy=false;
    const tell=(text,error=false)=>{
      message.textContent=text;
      message.classList.toggle("error",error);
    };
    const resetPreview=()=>{
      entries=plan=null;
      preview.hidden=commit.hidden=true;
      preview.replaceChildren();
      tell("");
    };
    const setBusy=working=>{
      busy=working;
      for (const control of [prepare,commit,cancel,form.elements.names,form.elements.file]) control.disabled=working;
      form.setAttribute("aria-busy",String(working));
    };
    form.reset();
    resetPreview();
    setBusy(false);
    $("#check-in-course").textContent=`${roster.course.name} · 登记现场出勤`;
    dialog.oncancel=event=>{if(busy)event.preventDefault()};
    form.elements.names.oninput=form.elements.file.onchange=resetPreview;
    cancel.onclick=()=>dialog.close();
    form.onsubmit=async event=>{
      event.preventDefault();
      resetPreview();
      setBusy(true);
      tell("正在匹配名单…");
      try {
        entries=await readCheckInEntries(form);
        if (!entries.length || entries.length>3000) throw new Error("请提供 1 至 3000 条姓名记录。");
        plan=await request(endpoint,{method:"POST",body:JSON.stringify({action:"preview",entries})});
        showCheckInPlan(preview,plan);
        commit.hidden=!plan.ready.length;
        tell(plan.ready.length?"核对名单后确认签到。名单外学员及已有记录保留。":"没有可新增的签到记录。");
      } catch (error) {
        tell(error.message,true);
      } finally {
        setBusy(false);
      }
    };
    commit.onclick=async()=>{
      if (busy || !plan?.ready.length) return;
      const unsaved=$$("#course-roster-list .attendance-row").some(row=>
        row.querySelector("select").value!==current.get(Number(row.dataset.student)));
      if (unsaved && !confirm("原出勤窗口有未保存的手动修改。签到完成后将刷新名单，放弃这些手动修改。继续签到吗？")) return;
      setBusy(true);
      tell("正在登记签到…");
      try {
        const result=await request(endpoint,{method:"POST",body:JSON.stringify({
          action:"commit",entries,expectedIds:plan.ready.map(student=>student.id)
        })});
        dialog.close();
        rosterDialog.close();
        await loadDashboard();
        toast(`已签到 ${result.signed} 人，跳过 ${result.skipped} 项`);
      } catch (error) {
        if (error.status===409) resetPreview();
        tell(error.message,true);
      } finally {
        setBusy(false);
      }
    };
    dialog.showModal();
  };
}
async function loadDepartments(){const id=$("#query-cohort").value,department=$("#department-select"),group=$("#group-select"),oldDepartment=department.value,oldGroup=group.value;if(!id){department.innerHTML='<option value="">请先选择培训班/团校</option>';group.innerHTML='<option value="">请先选择培训班/团校</option>';return}const m=await request(`/api/meta?cohortId=${encodeURIComponent(id)}`);if($("#query-cohort").value!==id)return;department.innerHTML='<option value="">请选择院系</option>'+m.departments.map(x=>`<option>${esc(x)}</option>`).join("");group.innerHTML='<option value="">请选择所属小组</option>'+(m.groups||[]).map(x=>`<option>${esc(x)}</option>`).join("");if(m.departments.includes(oldDepartment))department.value=oldDepartment;if((m.groups||[]).includes(oldGroup))group.value=oldGroup}
$("#query-cohort").onchange=()=>loadDepartments().catch(err=>toast(err.message));

$$("dialog button[value='cancel']").forEach(button=>{button.type="button";button.onclick=()=>button.closest("dialog").close()});

const renderStudentsEnhancedBase=renderStudents;renderStudents=function(){const result=renderStudentsEnhancedBase();if(data?.user?.canEdit)$$("#students-body tr").forEach(row=>{const anchor=row.querySelector("[data-attendance]");if(anchor&&!row.querySelector("[data-delete-student]"))anchor.parentElement.insertAdjacentHTML("beforeend",`<button class="delete-btn" data-delete-student="${anchor.dataset.attendance}">删除</button>`)});return result};
$("#students-body").onclick=async e=>{const edit=e.target.dataset.editStudent,attendance=e.target.dataset.attendance,remove=e.target.dataset.deleteStudent;if(edit)openStudent(data.records.find(r=>r.id===Number(edit)));if(attendance)openAttendance(Number(attendance));if(remove&&confirm("删除学员会同时删除其全部课程出勤记录，且无法撤销。确定继续吗？")){try{await request(`/api/admin/students/${remove}`,{method:"DELETE"});await loadDashboard();await loadMeta();toast("学员已删除")}catch(err){toast(err.message)}}};

$("#cohort-form").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;try{await request("/api/admin/cohorts",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(form)))});form.reset();form.elements.id.value="";$("#cohort-cancel").classList.add("hidden");await loadMeta();renderCohorts();toast("培训班/团校已保存并立即生效")}catch(err){toast(err.message)}};

const renderCoursesBase=renderCourses;
renderCourses=function(){
  if (data.user.role!=="liaison") return renderCoursesBase();
  const courses=data.courses.filter(course=>course.active);
  const action=data.user.attendancePolicy.mode==="readonly"?"查看本组出勤":"本组出勤";
  $("#courses-body").innerHTML=courses.map(course=>`<tr>
    <td>${course.sortOrder}</td><td><strong>${esc(course.name)}</strong></td>
    <td><span class="course-type ${course.category}">${categoryName(course.category)}</span></td><td>${course.credits}</td>
    <td class="row-actions"><button class="small-btn primary-link" data-course-roster="${course.id}">${action}</button></td>
  </tr>`).join("") || '<tr><td colspan="5" class="empty-cell">暂无课程</td></tr>';
};
$("#courses-body").onclick=async e=>{const edit=e.target.dataset.editCourse,remove=e.target.dataset.deleteCourse,roster=e.target.dataset.courseRoster;if(edit)openCourse(data.courses.find(c=>c.id===Number(edit)));if(roster)openCourseRoster(Number(roster));if(remove&&confirm("停用后，该课程不再计入任何学员总学分。确定继续吗？")){await request(`/api/admin/courses/${remove}`,{method:"DELETE"});await loadDashboard();toast("课程已停用")}};

async function openCourseRoster(id) {
  try {
    const path="/api/admin/courses/"+id+"/attendance";
    const roster=await request(path), {course,students,attendancePolicy:policy}=roster;
    const manager=policy.mode==="manager";
    let dialog=$("#course-roster-dialog");
    if (!dialog) {
      dialog=document.createElement("dialog");
      dialog.id="course-roster-dialog";
      dialog.className="wide-dialog";
      document.body.append(dialog);
    }
    const batchLabels={attended:"批量现场出勤",makeup:"批量完成补修","":"批量设为未参加"};
    const batchChoices=manager?attendanceStatuses:attendanceStatuses.filter(status=>students.some(student=>
      (student.status??"")!==status &&
      attendanceOptions(policy,course.category,student.status??"",student.withdrawn).includes(status)
    ));
    const editable=batchChoices.length>0;
    dialog.innerHTML=`<form method="dialog" id="course-roster-form">
      <div class="dialog-head"><div><h2>${esc(course.name)} · ${editable?"出勤登记":"查看出勤"}</h2>
      <p>${esc(policyDescription(policy))}</p></div><button class="icon-btn" type="button" id="roster-close" aria-label="关闭">×</button></div>
      <input id="roster-search" placeholder="搜索姓名、院系或小组" aria-label="搜索姓名、院系或小组">
      ${editable?`<div class="bulk-tools">
        <button type="button" class="ghost" id="select-all-roster">一键全选</button>
        <button type="button" class="ghost" id="clear-roster-selection">取消选择</button>
        ${batchChoices.map(status=>`<button type="button" class="secondary" data-batch-status="${status}">${batchLabels[status]}</button>`).join("")}
        ${manager?'<button type="button" class="primary" id="roster-check-in">名单签到</button>':""}
      </div>`:""}
      <div class="attendance-list" id="course-roster-list">${students.map(student=>{
        const status=student.status??"";
        const choices=availableAttendanceStatuses(policy,course.category,status,student.withdrawn);
        return `<div class="attendance-row ${student.withdrawn?"withdrawn-row":""}" data-student-id="${student.id}"
            data-student="${student.id}" data-original-status="${status}" data-credits="${course.credits}"
            data-credit-override="${student.creditOverride??""}" data-search="${esc((student.name+" "+student.department+" "+student.groupName).toLowerCase())}">
          <input class="roster-check" type="checkbox" ${choices.length===1?"disabled":""} aria-label="选择${esc(student.name)}">
          <div><strong>${esc(student.name)}</strong><small>${esc(student.department)} · ${esc(student.groupName||"未分组")}${student.withdrawn?" · 已退出／休学":""}</small></div>
          ${attendanceSelect(choices,status,student.name+"的出勤状态")}
          <strong>${earnedCredits(status,course.credits,student.creditOverride)} 分</strong>
        </div>`;
      }).join("") || '<p class="muted">当前范围内暂无学员。</p>'}</div>
      <div class="dialog-actions"><button class="ghost" type="button" id="roster-cancel">${editable?"取消":"关闭"}</button>
      ${editable?'<button class="primary" type="submit">保存出勤记录</button>':""}</div></form>`;
    dialog.showModal();
    if (manager) bindCheckIn(id,roster,dialog);
    $("#roster-close").onclick=$("#roster-cancel").onclick=()=>dialog.close();
    const list=$("#course-roster-list");
    $("#roster-search").oninput=event=>{
      const query=event.target.value.trim().toLowerCase();
      for (const row of list.querySelectorAll(".attendance-row")) {
        const visible=row.dataset.search.includes(query);
        row.classList.toggle("hidden",!visible);
        if (!visible) row.querySelector(".roster-check").checked=false;
      }
    };
    if (!editable) return;
    $("#select-all-roster").onclick=()=>{
      list.querySelectorAll(".attendance-row:not(.hidden) .roster-check:not(:disabled)").forEach(input=>input.checked=true);
    };
    $("#clear-roster-selection").onclick=()=>list.querySelectorAll(".roster-check").forEach(input=>input.checked=false);
    dialog.querySelectorAll("[data-batch-status]").forEach(button=>button.onclick=()=>{
      const status=button.dataset.batchStatus;
      list.querySelectorAll(".roster-check:checked").forEach(input=>{
        const select=input.closest(".attendance-row").querySelector("select");
        if (!Array.from(select.options).some(option=>option.value===status)) return;
        select.value=status;
        select.dispatchEvent(new Event("change",{bubbles:true}));
      });
    });
    list.onchange=updateAttendanceCredits;
    $("#course-roster-form").onsubmit=event=>{
      event.preventDefault();
      if (!editable) return;
      const items=changedAttendanceRows(list,"studentId");
      return saveAttendanceChanges(event,path,{items},dialog,"课程出勤已保存");
    };
  } catch(error) {
    toast(error.message);
  }
}



$(".admin-tabs").insertAdjacentHTML("beforeend",'<button class="tab-btn" id="guide-tab-btn" data-tab="guide">系统操作指南</button>');
$("#dashboard").insertAdjacentHTML("beforeend",'<section class="panel tab-panel hidden" id="tab-guide"><div class="panel-head"><div><h2>系统操作指南</h2><p id="guide-role-name"></p></div></div><div id="guide-content" class="guide-content"></div></section>');
$("#guide-tab-btn").onclick=()=>{$$(".tab-btn").forEach(x=>x.classList.toggle("active",x===$("#guide-tab-btn")));$$(".tab-panel").forEach(x=>x.classList.add("hidden"));$("#tab-guide").classList.remove("hidden");renderGuide()};
function renderGuide(){if(!data)return;const role=data.user.role,common=`<div class="guide-step"><h3>查看统计与学员记录</h3><p>登录时选择培训班/团校。首页统计不包含退出或休学学员；进入“学员与学分”，可搜索姓名、院系或组别，点击“课程记录”查看逐门课程情况。</p></div>`,superGuide=`<div class="guide-step"><h3>学员、课程与数据</h3><p>可新增、编辑或删除学员；在课程管理中新增课程、调整课程类别和学分，并通过勾选学员后批量登记现场出勤、补修或未参加。完整 Excel 可下载范例、导入和导出。</p></div><div class="guide-step"><h3>培训班/团校、结业与账号权限</h3><p>在“培训班/团校管理”中新建或修改培训班/团校；在“结业设置”配置本科、硕博总学分及必修学分门槛；在“账号与权限”审批注册申请，创建组织部骨干并勾选其授权的培训班/团校，或创建指定班级和小组的联络员账号，并可修改密码或删除普通账号。在“小组联络员出勤权限”中，可给单个或多个联络员设置出勤权限，也可统一设置一个培训班/团校的所有联络员。</p></div>`,orgGuide=`<div class="guide-step"><h3>数据维护</h3><p>可新增、编辑或删除学员，维护课程和批量登记出勤，使用 Excel 导入、导出，设置结业标准并修改已授权的培训班/团校名称。登录时请选择获授权的培训班/团校。</p></div>`,liaisonGuide=`<div class="guide-step"><h3>本组学员与出勤</h3><p>在“课程管理”或学员的“课程记录”中查看本组出勤。页面会显示当前账号可登记的课程和状态。只读课程、已退出学员和特殊课程的记录由管理员处理。</p><p>${esc(policyDescription(data.user.attendancePolicy))}</p></div>`;$("#guide-role-name").textContent=`当前权限：${data.user.roleName}`;$("#guide-content").innerHTML=common+(role==='super'?superGuide:role==='org'?orgGuide:liaisonGuide)+`<p class="guide-credit">本系统由北京大学历史学系2024级本科生张桐玮基于vibe-coding搭建，北京大学信息科学学院2024级本科生唐天睿提供重要技术支持；服务器依托北京大学学生Linux俱乐部开发并维护的PKU clab云主机，在此一并致谢。如对本系统存在疑问，可通过邮箱联系：<a href="mailto:zhangtongwei@stu.pku.edu.cn">zhangtongwei@stu.pku.edu.cn</a>。</p>`}
const renderEnhancedBase=render;
render=function(){
  const result=renderEnhancedBase();
  $("#new-course-btn").classList.toggle("hidden",!data.user.canEdit);
  if(data.user.role==="liaison"){
    $(".tab-btn[data-tab='courses']").classList.remove("hidden");
    $("#tab-courses").classList.remove("role-hidden");
  }
  renderCompletionOverview();
  renderGuide();
  return result;
};
if(location.hash==="#admin") loadMeta();
switchView();
