import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { readTrainingWorkbook, studentHeaders } from "../public/training-workbook.js";

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
  let cookie="", scope="";
  return async (path,{method="GET",body,status=200,inspect=false,headers={}}={})=>{
    const response=await fetch(origin+path,{
      method,headers:{"Content-Type":"application/json",cookie,
        ...(scope?{"X-PKU-Admin-Scope":scope}:{}),...headers},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const token=response.headers.get("set-cookie");
    if(token) cookie=token.split(";")[0];
    const error=(response.status===status)?"":await response.text();
    assert.equal(response.status,status,method+" "+path+" "+error);
    if(inspect) return response;
    const result=await response.json();
    if(response.ok && result.scope) scope=result.scope;
    return result;
  };
}

test("legacy workbooks retain known marks and reject mismatched or invalid cells",()=>{
  const book=XLSX.utils.book_new();
  const headers=[...studentHeaders,"1031破冰","1115开班","0331耶鲁北大行","0517第三次实务技能培训","示例讲座","总学分"];
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([
    headers,["一组",1,"示例联络员","旧表学员（休学）","","示例院系","","","",1,2,"2 2/3",0,"",17]
  ]),"本科组");
  const parsed=readTrainingWorkbook(book,XLSX);
  assert.equal(parsed.courses.length,5);
  assert.equal(parsed.courses[2].credits,2);
  assert.equal(parsed.courses.at(-1).category,"elective");
  assert.equal(parsed.students[0].name,"旧表学员");
  assert.equal(parsed.students[0].withdrawn,true);
  assert.deepEqual(parsed.attendance.map(row=>row.status),["attended","makeup","special"]);
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[...studentHeaders,"不同课程"]]),"硕博组");
  assert.throws(()=>readTrainingWorkbook(book,XLSX),/课程列/);
  XLSX.utils.sheet_add_aoa(book.Sheets["本科组"],[["误录"]],{origin:"J2"});
  assert.throws(()=>readTrainingWorkbook(book,XLSX),/出勤标记无效/);
});

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
  for(const asset of ["attendance-policy.js","custom-select.js","training-workbook.js","app.js","index.html","admin.css","styles.css","pku-seal-v1.png","favicon.svg"]) {
    cpSync(join(root,"public",asset),join(directory,"public",asset));
  }
  symlinkSync(join(root,"node_modules"),join(directory,"node_modules"),process.platform==="win32"?"junction":"dir");
  service=await launch(directory);
  const {origin}=service;
  const admin=client(origin), org=client(origin), liaison=client(origin), peer=client(origin), other=client(origin), visitor=client(origin);
  const write=(user,path,body,status=200)=>user(path,{method:"POST",body,status});
  const signIn=(user,username,status=200)=>write(user,"/api/admin/login",{username,password},status);
  const enter=(user,cohortId,status=200)=>write(user,"/api/admin/session/cohort",{cohortId},status);
  const login=async (user,username,cohortId=1)=>{
    await signIn(user,username);
    return enter(user,cohortId);
  };
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
  await visitor("/custom-select.js",{inspect:true});
  await visitor("/attendance-policy.js",{inspect:true});
  await visitor("/vendor/",{status:404,inspect:true});
  await visitor("/api/admin/accounts",{status:401});
  await visitor("/api/admin/session",{status:401});
  await enter(visitor,1,401);
  const signedIn=await signIn(admin,"test-super");
  assert.equal(signedIn.cohort,null);
  assert.equal(signedIn.user.role,"super");
  assert.equal(signedIn.records,undefined);
  assert.deepEqual(signedIn.cohorts.map(cohort=>cohort.id),[1]);
  assert.equal((await admin("/api/admin/session")).cohort,null);
  await admin("/api/admin/dashboard",{status:428});
  await admin("/api/admin/accounts",{status:428});
  await write(admin,"/api/admin/settings",{undergraduate:99,graduate:99,required:99},428);
  await enter(admin,"1",400);
  await enter(admin,999999,403);
  const firstSession=await enter(admin,1);
  assert.equal((await admin("/api/admin/session")).scope,firstSession.scope);
  assert.deepEqual(firstSession.records[0].progress,{
    studiedCourses:1,remainingRequired:0,minimumCourses:null,
    totalEnoughRequiredShort:false,canGraduateWithRequiredOnly:false
  });
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
  const withdrawn=(await write(admin,"/api/admin/students",student("已退出学员","一组",{withdrawn:true,withdrawalNote:"赴外地"}))).id;
  await write(admin,"/api/admin/students",student("已退出学员","一组"),409);
  await write(admin,"/api/admin/settings",{undergraduate:3,graduate:4,required:3});
  await write(admin,"/api/admin/settings",{undergraduate:"",graduate:4,required:3},400);
  await createLiaison("liaison-one",1,"一组");
  await createLiaison("liaison-two",1,"二组");
  await write(admin,"/api/admin/accounts",{username:"test-org",password,role:"org",cohortIds:[1]});
  await write(admin,"/api/admin/accounts",{username:"wrong-group",password,role:"liaison",cohortId:1,groupName:"不存在"},400);

  const atSecond=await enter(admin,second);
  assert.equal(atSecond.cohort.id,second);
  assert.notEqual(atSecond.scope,firstSession.scope);
  assert.ok(atSecond.cohorts.some(cohort=>cohort.id===1));
  assert.deepEqual(atSecond.records,[]);
  await admin("/api/admin/settings",{method:"POST",body:{undergraduate:99,graduate:99,required:99},
    headers:{"X-PKU-Admin-Scope":firstSession.scope},status:409});
  await admin("/api/admin/export.xlsx?scope="+firstSession.scope,{status:409});
  assert.equal((await dashboard(admin)).thresholds.undergraduate,10);
  const elsewhere=(await write(admin,"/api/admin/students",student("示例甲","一组"))).id;
  assert.notEqual(elsewhere,first);
  await write(admin,"/api/admin/courses",{courseKey:"elsewhere",name:"异班课程",category:"required",credits:3,sortOrder:1});
  const crossCourse=(await dashboard(admin)).courses[0].id;
  await createLiaison("liaison-other",second,"一组");
  const returned=await enter(admin,1);
  assert.notEqual(returned.scope,firstSession.scope);
  assert.equal(returned.thresholds.undergraduate,3);
  assert.deepEqual(returned.records.find(row=>row.id===first).progress,{
    studiedCourses:0,remainingRequired:2,minimumCourses:1,
    totalEnoughRequiredShort:false,canGraduateWithRequiredOnly:true
  });
  await admin("/api/admin/dashboard",{headers:{"X-PKU-Admin-Scope":firstSession.scope},status:409});
  await write(admin,"/api/admin/cohorts",{name:"测试团校 B"},409);
  await write(admin,"/api/admin/courses",{id:crossCourse,name:"越界课程",category:"required",credits:2,sortOrder:1},404);
  await admin("/api/admin/courses/"+crossCourse,{method:"DELETE",status:404});
  assert.deepEqual((await signIn(org,"test-org")).cohorts.map(cohort=>cohort.id),[1]);
  await enter(org,second,403);
  await enter(org,1);
  assert.deepEqual((await signIn(liaison,"liaison-one")).cohorts.map(cohort=>cohort.id),[1]);
  await enter(liaison,second,403);
  await enter(liaison,1);
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
  const home=await visitor("/",{inspect:true});
  assert.doesNotMatch(await home.text(),/<script[^>]+src="\/vendor\/xlsx\.js"/);
  const template=await admin("/api/admin/template.xlsx",{inspect:true});
  const templateData=readTrainingWorkbook(XLSX.read(await template.arrayBuffer(),{type:"array"}),XLSX);
  assert.deepEqual(templateData.courses.map(course=>[course.category,course.credits]),[["required",2],["elective",3]]);
  // A stopped course is outside the export. Its historical attendance must survive re-import.
  await saveStudent(admin,first,elective,"attended","");
  await admin("/api/admin/courses/"+elective,{method:"DELETE"});
  const pausedStudent=await admin(studentPath(first));
  assert.equal(pausedStudent.student.courseCount,1);
  assert.equal(pausedStudent.student.totalCredits,3);
  const exported=await admin("/api/admin/export.xlsx",{inspect:true});
  const restored=readTrainingWorkbook(XLSX.read(await exported.arrayBuffer(),{type:"array"}),XLSX);
  assert.deepEqual(restored.thresholds,{undergraduate:3,graduate:4,required:3});
  assert.ok(restored.courses.some(course=>course.name==="必修"&&course.credits===3&&course.storageKey==="required"));
  assert.ok(restored.students.some(row=>row.name==="已退出学员"&&row.withdrawn&&row.withdrawalNote==="赴外地"));
  await write(admin,"/api/admin/settings",{undergraduate:20,graduate:24,required:6});
  await write(admin,"/api/admin/import-full",restored);
  assert.deepEqual((await dashboard(admin)).thresholds,restored.thresholds);
  assert.equal((await dashboard(admin)).courses.find(course=>course.name==="必修").id,required);
  assert.equal((await admin(studentPath(withdrawn))).student.withdrawalNote,"赴外地");
  await write(admin,"/api/admin/import-full",{...restored,attendance:[...restored.attendance,{studentKey:"missing",courseKey:"course_01",status:"makeup"}]},400);
  assert.equal((await admin(studentPath(first))).student.totalCredits,3);
  assert.deepEqual((await dashboard(liaison)).user.attendancePolicy,allCoursesPolicy);
  await write(admin,"/api/admin/courses",{id:elective,name:"选修",category:"elective",credits:2,sortOrder:2});
  assert.equal((await admin(studentPath(first))).student.totalCredits,5);
  await saveStudent(admin,first,elective,"","attended");
  await admin(studentPath(teammate),{method:"DELETE"});
  await admin(studentPath(teammate),{status:404});

  await enter(org,second,403);
  await write(admin,"/api/admin/accounts",{id:byName["test-org"],username:"test-org",role:"org",cohortIds:[1,second]});
  assert.deepEqual((await org("/api/admin/session")).cohorts.map(cohort=>cohort.id),[second,1]);
  assert.deepEqual((await enter(org,second)).records.map(row=>row.id),[elsewhere]);
  await write(admin,"/api/admin/accounts",{id:byName["test-org"],username:"test-org",role:"org",cohortIds:[1]});
  await org("/api/admin/dashboard",{status:409});
  assert.equal((await org("/api/admin/session")).cohort,null);
  await org("/api/admin/dashboard",{status:428});
  assert.equal((await enter(org,1)).cohort.id,1);
  await write(admin,"/api/admin/accounts",{id:byName["test-org"],username:"test-org",role:"org",cohortIds:[]});
  const noGrants=await org("/api/admin/session");
  assert.equal(noGrants.cohort,null);
  assert.deepEqual(noGrants.cohorts,[]);
  await enter(org,1,403);
  await write(org,"/api/admin/logout",{});
  await org("/api/admin/session",{status:401});
  await admin("/api/admin/accounts/"+byName["test-org"],{method:"DELETE"});
  await signIn(org,"test-org",401);

  await write(admin,"/api/admin/cohorts",{id:1,name:"已改名测试培训班"});
  await service.stop();
  service=await launch(directory);
  const afterRestart=client(service.origin);
  await login(afterRestart,"liaison-one");
  assert.equal((await dashboard(afterRestart)).cohort.name,"已改名测试培训班");
  assert.equal((await afterRestart("/api/meta")).cohorts.length,2);
  assert.deepEqual((await dashboard(afterRestart)).user.attendancePolicy,allCoursesPolicy);
  assert.equal((await afterRestart(studentPath(5))).student.totalCredits,2);
  assert.equal((await afterRestart(studentPath(first))).student.totalCredits,3);
});
