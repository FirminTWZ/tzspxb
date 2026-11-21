import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const password="Example-only-2026";
const caseRoot=resolve(process.env.PKU_REGRESSION_DIR||tmpdir());
const requiredPolicy={mode:"custom",scope:"required",statuses:["attended","makeup",""]};
const allCoursesPolicy={...requiredPolicy,scope:"all"};
const readOnly={mode:"readonly"};
const legacy={mode:"legacy"};

function legacyFixture(directory) {
  const db=new DatabaseSync(join(directory,"data","credits.db"));
  db.exec(`
    CREATE TABLE records(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, department TEXT NOT NULL,
      student_type TEXT NOT NULL, credits REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name,department,student_type)
    );
    CREATE TABLE courses(
      id INTEGER PRIMARY KEY AUTOINCREMENT, course_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      category TEXT NOT NULL, credits REAL NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, source_header TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE attendance(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      status TEXT NOT NULL, source_mark TEXT NOT NULL DEFAULT '', credit_override REAL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(student_id,course_id)
    );
    INSERT INTO records(id,name,department,student_type,group_name) VALUES(5,'原有学员','示例院系','undergraduate','一组');
    INSERT INTO courses(id,course_key,name,category,credits) VALUES(7,'old-course','原有课程','required',2);
    INSERT INTO attendance(student_id,course_id,status,source_mark) VALUES(5,7,'attended','旧版记录');
  `);
  db.close();
}

async function launch(directory) {
  const child=spawn(process.execPath,["server.mjs"],{
    cwd:directory,
    env:{...process.env,PORT:"0",HOST:"127.0.0.1",COOKIE_SECURE:"false",
      SUPER_ADMIN_1_USERNAME:"test-super",SUPER_ADMIN_1_PASSWORD:password,
      SUPER_ADMIN_2_USERNAME:"",SUPER_ADMIN_2_PASSWORD:""},
    stdio:["ignore","pipe","pipe"]
  });
  const closed=once(child,"close");
  let log="";
  child.stderr.on("data",chunk=>log+=chunk);
  const origin=await new Promise((yes,no)=>{
    let stdout="";
    child.stdout.setEncoding("utf8").on("data",chunk=>{
      stdout+=chunk;
      const port=stdout.match(/localhost:(\d+)/)?.[1];
      if(port) yes("http://127.0.0.1:"+port);
    });
    child.once("exit",code=>no(new Error("Server exited "+code+" "+log)));
    child.once("error",no);
  });
  return {origin,stop:async()=>{child.kill();await closed;}};
}

function client(origin) {
  let cookie="";
  return async (path,{method="GET",body,status=200,inspect=false}={})=>{
    const response=await fetch(origin+path,{
      method,headers:{"Content-Type":"application/json",cookie},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const token=response.headers.get("set-cookie");
    if(token) cookie=token.split(";")[0];
    const error=(response.status===status)?"":await response.text();
    assert.equal(response.status,status,method+" "+path+" "+error);
    if(inspect) return response;
    return response.json();
  };
}

test("migration, attendance permissions, scopes and manager workflows",async t=>{
  const directory=mkdtempSync(join(caseRoot,"pku-credit-regression-"));
  assert.ok(directory.startsWith(caseRoot+sep+"pku-credit-regression-"));
  let service;
  t.after(async ()=>{
    if(service) await service.stop();
    rmSync(directory,{recursive:true,force:true});
  });
  mkdirSync(join(directory,"data"));
  legacyFixture(directory);
  cpSync(join(root,"server.mjs"),join(directory,"server.mjs"));
  mkdirSync(join(directory,"public"));
  for(const asset of ["attendance-policy.js","app.js","index.html","admin.css","styles.css"]) {
    cpSync(join(root,"public",asset),join(directory,"public",asset));
  }
  symlinkSync(join(root,"node_modules"),join(directory,"node_modules"),process.platform==="win32"?"junction":"dir");
  service=await launch(directory);
  const {origin}=service;
  const admin=client(origin), org=client(origin), liaison=client(origin), peer=client(origin), other=client(origin), visitor=client(origin);
  const login=(user,username,cohortId=1,status=200)=>user("/api/admin/login",{method:"POST",body:{username,password,cohortId},status});
  const write=(user,path,body,status=200)=>user(path,{method:"POST",body,status});
  const editPermissions=(user,body,status=200)=>user("/api/admin/liaison-attendance",{method:"PATCH",body,status});
  const accounts=async ()=>(await admin("/api/admin/accounts")).accounts;
  const coursePath=id=>"/api/admin/courses/"+id+"/attendance";
  const studentPath=id=>"/api/admin/students/"+id;
  const dashboard=user=>user("/api/admin/dashboard");
  const saveCourse=(user,id,items,status)=>write(user,coursePath(id),{items},status);
  const saveStudent=(user,studentId,courseId,status,expectedStatus,result=200)=>
    write(user,"/api/admin/attendance",{studentId,items:[{courseId,status,expectedStatus}]},result);
  const student=(name,groupName,extra={})=>({name,groupName,department:"示例院系",studentType:"undergraduate",...extra});
  const createLiaison=(username,cohortId,groupName)=>write(admin,"/api/admin/accounts",{username,password,role:"liaison",cohortId,groupName});

  await visitor("/",{inspect:true});
  await visitor("/attendance-policy.js",{inspect:true});
  await visitor("/vendor/",{status:404,inspect:true});
  await visitor("/api/admin/accounts",{status:401});
  await login(admin,"test-super");
  const original=await admin(studentPath(5));
  assert.equal(original.student.totalCredits,2);
  assert.equal(original.attendance[0].sourceMark,"旧版记录");
  assert.equal((await write(admin,"/api/admin/students",student("修改后学员","一组",{id:5}))).id,5);
  assert.equal((await admin(studentPath(5))).student.totalCredits,2);
  await write(admin,"/api/admin/cohorts",{name:"测试团校 B"});
  const second=(await visitor("/api/meta")).cohorts.find(cohort=>cohort.name==="测试团校 B").id;

  await write(admin,"/api/admin/courses",{courseKey:"required",name:"必修",category:"required",credits:3,sortOrder:1});
  await write(admin,"/api/admin/courses",{courseKey:"elective",name:"选修",category:"elective",credits:2,sortOrder:2});
  const {courses}=await dashboard(admin);
  const required=courses.find(course=>course.name==="必修").id;
  const elective=courses.find(course=>course.name==="选修").id;
  const first=(await write(admin,"/api/admin/students",student("示例甲","一组"))).id;
  const teammate=(await write(admin,"/api/admin/students",student("示例乙","一组"))).id;
  const different=(await write(admin,"/api/admin/students",student("示例丙","二组"))).id;
  const withdrawn=(await write(admin,"/api/admin/students",student("已退出学员","一组",{withdrawn:true}))).id;
  await write(admin,"/api/admin/settings",{undergraduate:3,graduate:4,required:3});
  await createLiaison("liaison-one",1,"一组");
  await createLiaison("liaison-two",1,"二组");
  await write(admin,"/api/admin/accounts",{username:"test-org",password,role:"org",cohortIds:[1]});
  await write(admin,"/api/admin/accounts",{username:"wrong-group",password,role:"liaison",cohortId:1,groupName:"不存在"},400);

  await login(admin,"test-super",second);
  const elsewhere=(await write(admin,"/api/admin/students",student("示例甲","一组"))).id;
  assert.notEqual(elsewhere,first);
  await write(admin,"/api/admin/courses",{courseKey:"elsewhere",name:"异班课程",category:"required",credits:3,sortOrder:1});
  const crossCourse=(await dashboard(admin)).courses[0].id;
  await createLiaison("liaison-other",second,"一组");
  await login(admin,"test-super");
  await login(org,"test-org");
  await login(liaison,"liaison-one");
  await login(peer,"liaison-two");
  await login(other,"liaison-other",second);
  const byName=Object.fromEntries((await accounts()).map(account=>[account.username,account.id]));
  const firstId=byName["liaison-one"], peerId=byName["liaison-two"];

  assert.equal((await dashboard(liaison)).records.every(row=>row.groupName==="一组"),true);
  assert.deepEqual((await dashboard(liaison)).user.attendancePolicy,legacy);
  await liaison(studentPath(different),{status:404});
  await liaison(studentPath(elsewhere),{status:404});
  await write(liaison,"/api/admin/students",student("不能创建","一组"),403);
  await write(liaison,"/api/admin/courses",{name:"不能创建"},403);
  await write(liaison,"/api/admin/settings",{undergraduate:0,graduate:0,required:0},403);
  await liaison("/api/admin/accounts",{status:403});
  await editPermissions(org,{accountIds:[firstId],attendancePolicy:allCoursesPolicy},403);
  await editPermissions(liaison,{accountIds:[firstId],attendancePolicy:allCoursesPolicy},403);

  await saveStudent(liaison,first,required,"attended","",403);
  await saveStudent(liaison,first,elective,"makeup","",403);
  await saveStudent(liaison,first,required,"makeup","");
  await saveStudent(liaison,first,required,"","makeup",403);
  assert.equal((await liaison(studentPath(first))).student.totalCredits,3);
  await editPermissions(admin,{accountIds:[firstId],attendancePolicy:requiredPolicy});
  assert.deepEqual((await liaison(coursePath(required))).attendancePolicy,requiredPolicy);
  await saveCourse(liaison,required,[{studentId:first,status:"attended",expectedStatus:"makeup"}]);
  await saveStudent(liaison,first,required,"","makeup",409);
  await saveStudent(liaison,first,required,"","attended");
  await saveStudent(liaison,first,elective,"attended","",403);
  await saveStudent(liaison,first,crossCourse,"attended","",403);
  await saveStudent(liaison,withdrawn,required,"attended","",403);
  await saveCourse(liaison,required,[{studentId:first,status:"attended",expectedStatus:""},{studentId:different,status:"attended",expectedStatus:""}],403);
  assert.equal((await admin(studentPath(first))).student.totalCredits,0);
  await saveStudent(admin,first,required,"special","");
  await saveStudent(liaison,first,required,"attended","special",403);
  assert.equal((await admin(studentPath(first))).student.totalCredits,8);
  await saveStudent(admin,first,required,"","special");

  await editPermissions(admin,{accountIds:[firstId,byName["test-org"]],attendancePolicy:readOnly},409);
  assert.deepEqual((await dashboard(liaison)).user.attendancePolicy,requiredPolicy);
  await editPermissions(admin,{accountIds:[firstId,peerId],attendancePolicy:readOnly});
  await saveStudent(peer,different,required,"makeup","",403);
  await saveStudent(liaison,teammate,required,"attended","",403);
  await editPermissions(admin,{cohortId:1,attendancePolicy:allCoursesPolicy});
  assert.deepEqual((await dashboard(other)).user.attendancePolicy,legacy);
  assert.equal((await accounts()).find(account=>account.id===firstId).attendancePolicy,null);
  await saveStudent(liaison,teammate,elective,"attended","");
  await saveStudent(peer,different,required,"makeup","");
  await editPermissions(admin,{accountIds:[firstId],attendancePolicy:{mode:"custom",scope:"all",statuses:[""]}});
  await saveStudent(liaison,teammate,elective,"makeup","attended",403);
  await saveStudent(liaison,teammate,elective,"","attended");
  await editPermissions(admin,{accountIds:[firstId],attendancePolicy:null});
  assert.deepEqual((await dashboard(liaison)).user.attendancePolicy,allCoursesPolicy);
  await write(visitor,"/api/admin/register",{username:"approved-liaison",password,role:"liaison",cohortId:1,groupName:"一组"},201);
  const approval=(await admin("/api/admin/registrations")).registrations.find(record=>record.username==="approved-liaison");
  await write(admin,"/api/admin/registrations/"+approval.id,{decision:"approve"});
  const newLiaison=client(origin);
  await login(newLiaison,"approved-liaison");
  assert.deepEqual((await dashboard(newLiaison)).user.attendancePolicy,allCoursesPolicy);

  const options={name:"示例甲",department:"示例院系",studentType:"undergraduate",groupName:"一组",cohortId:1};
  const preview=await write(admin,"/api/admin/courses/"+required+"/check-in",{action:"preview",entries:[options]});
  assert.deepEqual(preview.ready.map(row=>row.id),[first]);
  await write(admin,"/api/admin/courses/"+required+"/check-in",{action:"commit",entries:[options],expectedIds:[first]});
  assert.equal((await admin(studentPath(first))).attendance.find(item=>item.courseId===required).sourceMark,"名单签到");
  await saveStudent(admin,first,required,"attended","attended");
  assert.equal((await admin(studentPath(first))).attendance.find(item=>item.courseId===required).sourceMark,"名单签到");
  const query=await write(visitor,"/api/query",options);
  assert.equal(query.totalCredits,3);
  assert.equal(query.completed,true);
  assert.equal(query.phone,undefined);
  assert.equal((await dashboard(admin)).stats.withdrawn,1);
  await liaison("/api/admin/export.xlsx",{status:403});
  const exported=await admin("/api/admin/export.xlsx",{inspect:true});
  assert.ok((await exported.arrayBuffer()).byteLength>1000);

  await service.stop();
  service=await launch(directory);
  const afterRestart=client(service.origin);
  await login(afterRestart,"liaison-one");
  assert.deepEqual((await dashboard(afterRestart)).user.attendancePolicy,allCoursesPolicy);
  assert.equal((await afterRestart(studentPath(5))).student.totalCredits,2);
  assert.equal((await afterRestart(studentPath(first))).student.totalCredits,3);
});
