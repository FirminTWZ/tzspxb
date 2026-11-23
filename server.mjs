import http from "node:http";
import { readFileSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual, scrypt, scryptSync } from "node:crypto";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import XLSX from "xlsx";
import { attendanceOptions, legacyAttendancePolicy, normalizeAttendancePolicy } from "./public/attendance-policy.js";
import { studentHeaders, withdrawalHeaders } from "./public/training-workbook.js";

const ROOT=dirname(fileURLToPath(import.meta.url));
const DATA_DIR=join(ROOT,"data");
mkdirSync(DATA_DIR,{recursive:true});
const db=new DatabaseSync(join(DATA_DIR,"credits.db"));
db.exec(`PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,department TEXT NOT NULL,student_type TEXT NOT NULL CHECK(student_type IN ('undergraduate','graduate')),credits REAL NOT NULL DEFAULT 0,note TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,cohort_id INTEGER NOT NULL DEFAULT 1,UNIQUE(cohort_id,name,department,student_type));CREATE INDEX IF NOT EXISTS idx_records_lookup ON records(name,department,student_type);CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT OR IGNORE INTO settings VALUES('threshold_undergraduate','10');INSERT OR IGNORE INTO settings VALUES('threshold_graduate','10');`);
function ensureColumn(table,name,definition){const cols=db.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name);if(!cols.includes(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)}
ensureColumn("records","group_name","TEXT NOT NULL DEFAULT ''");ensureColumn("records","group_contact","TEXT NOT NULL DEFAULT ''");ensureColumn("records","political_status","TEXT NOT NULL DEFAULT ''");ensureColumn("records","league_branch","TEXT NOT NULL DEFAULT ''");ensureColumn("records","phone","TEXT NOT NULL DEFAULT ''");ensureColumn("records","email","TEXT NOT NULL DEFAULT ''");ensureColumn("records","withdrawn","INTEGER NOT NULL DEFAULT 0");ensureColumn("records","withdrawal_note","TEXT NOT NULL DEFAULT ''");ensureColumn("records","source_total","REAL");
db.exec("CREATE TABLE IF NOT EXISTS cohorts(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);INSERT INTO cohorts(name) SELECT '北京大学2025级团支书培训班' WHERE NOT EXISTS(SELECT 1 FROM cohorts);");
ensureColumn("records","cohort_id","INTEGER NOT NULL DEFAULT 1");
migrateStudentIdentity();
db.exec(`CREATE TABLE IF NOT EXISTS courses(id INTEGER PRIMARY KEY AUTOINCREMENT,course_key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('required','elective')),credits REAL NOT NULL CHECK(credits>=0),sort_order INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,source_header TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);CREATE INDEX IF NOT EXISTS idx_courses_order ON courses(sort_order);CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY AUTOINCREMENT,student_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,status TEXT NOT NULL CHECK(status IN ('attended','makeup','special')),source_mark TEXT NOT NULL DEFAULT '',credit_override REAL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(student_id,course_id));CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id);CREATE INDEX IF NOT EXISTS idx_attendance_course ON attendance(course_id);PRAGMA foreign_keys=ON;PRAGMA optimize;`);
ensureColumn("attendance","credit_override","REAL");
ensureColumn("courses","cohort_id","INTEGER NOT NULL DEFAULT 1");
db.exec(`CREATE INDEX IF NOT EXISTS idx_records_cohort_group ON records(cohort_id,group_name);
 CREATE INDEX IF NOT EXISTS idx_courses_cohort_order ON courses(cohort_id,sort_order,id);`);
db.exec("UPDATE courses SET course_key=cohort_id||':'||course_key WHERE instr(course_key,':')=0;");
db.exec(`CREATE TABLE IF NOT EXISTS cohort_settings(cohort_id INTEGER PRIMARY KEY,threshold_undergraduate REAL NOT NULL DEFAULT 10,threshold_graduate REAL NOT NULL DEFAULT 10,threshold_required REAL NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS admin_accounts(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('super','org','liaison')),cohort_id INTEGER,group_name TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);CREATE INDEX IF NOT EXISTS idx_admin_scope ON admin_accounts(role,cohort_id,group_name);`);
function passwordHash(password,salt=randomBytes(16).toString("hex")){return `${salt}:${scryptSync(String(password),salt,64).toString("hex")}`}
ensureColumn("admin_accounts","attendance_policy","TEXT");
ensureColumn("cohort_settings","liaison_attendance_policy","TEXT");
db.exec(`CREATE TABLE IF NOT EXISTS admin_registration_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('org','liaison')),
 cohort_id INTEGER REFERENCES cohorts(id),
 group_name TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_cohort_grants (
 account_id INTEGER NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
 cohort_id INTEGER NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
 PRIMARY KEY(account_id,cohort_id)
);
CREATE TABLE IF NOT EXISTS registration_cohort_requests (
 registration_id INTEGER NOT NULL REFERENCES admin_registration_requests(id) ON DELETE CASCADE,
 cohort_id INTEGER NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
 PRIMARY KEY(registration_id,cohort_id)
)`);
const deriveKey=promisify(scrypt);
async function passwordMatches(password,stored){const [salt,hex]=String(stored).split(":");if(!salt||!hex)return false;const actual=await deriveKey(password,salt,64),expected=Buffer.from(hex,"hex");return actual.length===expected.length&&timingSafeEqual(actual,expected)}
function seedSuper(username,password){const row=db.prepare("SELECT id FROM admin_accounts WHERE username=?").get(username);if(row)db.prepare("UPDATE admin_accounts SET role='super',active=1,cohort_id=NULL,group_name='' WHERE id=?").run(row.id);else db.prepare("INSERT INTO admin_accounts(username,password_hash,role) VALUES(?,?,'super')").run(username,passwordHash(password))}
if(process.env.SUPER_ADMIN_1_PASSWORD)seedSuper(process.env.SUPER_ADMIN_1_USERNAME||"pkuzzb",process.env.SUPER_ADMIN_1_PASSWORD);
if(process.env.SUPER_ADMIN_2_PASSWORD)seedSuper(process.env.SUPER_ADMIN_2_USERNAME||"zhangtongwei",process.env.SUPER_ADMIN_2_PASSWORD);
if(!db.prepare("SELECT COUNT(*) AS n FROM admin_accounts WHERE active=1").get().n)throw new Error("尚未配置管理员账号。请设置 SUPER_ADMIN_1_PASSWORD 后重新启动。");
const legacy=Object.fromEntries(db.prepare("SELECT key,value FROM settings").all().map(r=>[r.key,Number(r.value)]));for(const c of db.prepare("SELECT id FROM cohorts").all())db.prepare("INSERT OR IGNORE INTO cohort_settings(cohort_id,threshold_undergraduate,threshold_graduate,threshold_required) VALUES(?,?,?,0)").run(c.id,legacy.threshold_undergraduate??10,legacy.threshold_graduate??10);

const sessions=new Map(),SESSION_MS=12*60*60*1000,secureCookie=process.env.COOKIE_SECURE==="true"?"; Secure":"";
const activeCohorts=db.prepare("SELECT id,name FROM cohorts WHERE active=1 ORDER BY id DESC");
const activeCohort=db.prepare("SELECT id,name FROM cohorts WHERE id=? AND active=1");
const activeAccount=db.prepare("SELECT * FROM admin_accounts WHERE id=? AND active=1");
const hasCohortGrant=db.prepare("SELECT 1 FROM admin_cohort_grants WHERE account_id=? AND cohort_id=?");
function orgCohorts(accountId) {
 return db.prepare(`SELECT c.id,c.name FROM admin_cohort_grants g
  JOIN cohorts c ON c.id=g.cohort_id WHERE g.account_id=? AND c.active=1 ORDER BY c.id DESC`).all(accountId);
}
function requestedCohorts(registrationId) {
 return db.prepare(`SELECT c.id,c.name FROM registration_cohort_requests g
  JOIN cohorts c ON c.id=g.cohort_id WHERE g.registration_id=? ORDER BY c.id DESC`).all(registrationId);
}
function canAccessCohort(account,cohortId) {
 if (!Number.isSafeInteger(cohortId) || !activeCohort.get(cohortId)) return false;
 if (account.role==="super") return true;
 if (account.role==="liaison") return account.cohort_id===cohortId && !!account.group_name;
 return account.role==="org" && !!hasCohortGrant.get(account.id,cohortId);
}
function accessibleCohorts(account) {
 if (account.role==="super") return activeCohorts.all();
 if (account.role==="org") return orgCohorts(account.id);
 const cohort=account.group_name && account.cohort_id!=null ? activeCohort.get(account.cohort_id) : null;
 return cohort ? [cohort] : [];
}
function validCohortIds(value,{allowEmpty=false}={}) {
 if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length>1000 ||
     value.some(id=>!Number.isSafeInteger(id) || id<1) || new Set(value).size!==value.length) return false;
 const exists=db.prepare("SELECT 1 FROM cohorts WHERE id=? AND active=1");
 return value.every(id=>exists.get(id));
}
function replaceOrgGrants(accountId,cohortIds) {
 db.prepare("DELETE FROM admin_cohort_grants WHERE account_id=?").run(accountId);
 const add=db.prepare("INSERT INTO admin_cohort_grants(account_id,cohort_id) VALUES(?,?)");
 for (const id of cohortIds) add.run(accountId,id);
}
function migrateStudentIdentity() {
 const definition=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='records'").get().sql;
 const oldKey=/UNIQUE\s*\(\s*name\s*,\s*department\s*,\s*student_type\s*\)/i;
 if(!oldKey.test(definition)) return;
 const columns=db.prepare("PRAGMA table_info(records)").all().map(({name})=>'"'+name.replaceAll('"','""')+'"').join(",");
 const schema=db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='records' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
 const sequence=db.prepare("SELECT seq FROM sqlite_sequence WHERE name='records'").get()?.seq??0;
 // Keep the record IDs used by attendance and restore indexes and triggers.
 db.exec("PRAGMA foreign_keys=OFF");
 try {
  transaction(()=>{
   db.exec(definition.replace(/^CREATE TABLE\s+(?:"records"|records)/i,"CREATE TABLE records_scoped")
    .replace(oldKey,"UNIQUE(cohort_id,name,department,student_type)"));
   db.exec("INSERT INTO records_scoped("+columns+") SELECT "+columns+" FROM records");
   db.exec("DROP TABLE records; ALTER TABLE records_scoped RENAME TO records");
   for(const entry of schema) db.exec(entry.sql);
   if(sequence>0) {
    db.prepare("INSERT INTO sqlite_sequence(name,seq) SELECT 'records',? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='records')").run(sequence);
    db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='records'").run(sequence);
   }
  });
 } finally {
  db.exec("PRAGMA foreign_keys=ON");
 }
}
function transaction(work) {
 db.exec("BEGIN IMMEDIATE");
 try {
  const result=work();
  db.exec("COMMIT");
  return result;
 } catch (error) {
  db.exec("ROLLBACK");
  throw error;
 }
}
const mime={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".svg":"image/svg+xml",".png":"image/png"};
class InputError extends Error {
 constructor(message,status=400) {
  super(message);
  this.status=status;
 }
}
function json(res,status,value,headers={}){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers});res.end(JSON.stringify(value))}
function binary(res,buffer,filename){res.writeHead(200,{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,"Content-Length":buffer.length,"Cache-Control":"no-store"});res.end(buffer)}
async function body(req,limit=14_000_000) {
 const chunks=[];
 let size=0;
 for await(const chunk of req) {
  size+=chunk.length;
  if(size>limit) throw new InputError("请求内容过大",413);
  chunks.push(chunk);
 }
 if(!chunks.length) return {};
 const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
 if(!value||typeof value!=="object"||Array.isArray(value)) throw new InputError("请求数据格式不正确");
 return value;
}
function token(req){return(req.headers.cookie||"").split(";").map(v=>v.trim()).find(v=>v.startsWith("pku_admin="))?.slice(10)||""}
function setAdminCohort(session,cohortId) {
 session.cohortId=cohortId;
 // A fresh scope also distinguishes stale screens after switching A → B → A.
 session.scope=randomBytes(12).toString("base64url");
}
function adminSession(req) {
 const key=token(req), session=sessions.get(key);
 if (!session) return null;
 const current=activeAccount.get(session.user.id);
 if (session.expires<Date.now() || !current || current.password_hash!==session.user.password_hash ||
     current.role!==session.user.role || current.cohort_id!==session.user.cohort_id || current.group_name!==session.user.group_name) {
  sessions.delete(key);
  return null;
 }
 if (session.cohortId!==null && !canAccessCohort(current,session.cohortId)) setAdminCohort(session,null);
 return {...session,user:current};
}
function requireIdentity(req,res) {
 const session=adminSession(req);
 if(!session) json(res,401,{error:"请先登录管理员后台"});
 return session;
}
function adminScopeMatches(res,session,scope) {
 if(!scope || scope===session.scope) return true;
 json(res,409,{code:"ADMIN_SCOPE_CHANGED",error:"管理范围已改变，请核对当前培训班/团校后重试"});
 return false;
}
function requireAdmin(req,res,scope=req.headers["x-pku-admin-scope"]) {
 const session=requireIdentity(req,res);
 if (!session || !adminScopeMatches(res,session,scope)) return null;
 if (session.cohortId===null) {
  json(res,428,{error:"请先选择要管理的培训班/团校"});
  return null;
 }
 return session;
}
function requireWrite(req,res,scope){const s=requireAdmin(req,res,scope);if(!s)return null;if(s.user.role==="liaison"){json(res,403,{error:"此操作仅限培训班/团校管理员"});return null}return s}
function requireSuper(req,res){const s=requireAdmin(req,res);if(!s)return null;if(s.user.role!=="super"){json(res,403,{error:"只有校团委组织部账号可以管理账号与权限"});return null}return s}
function safeEqual(a,b){const aa=Buffer.from(String(a)),bb=Buffer.from(String(b));return aa.length===bb.length&&timingSafeEqual(aa,bb)}
function thresholds(cohortId){return db.prepare("SELECT threshold_undergraduate AS undergraduate,threshold_graduate AS graduate,threshold_required AS required FROM cohort_settings WHERE cohort_id=?").get(cohortId)||{undergraduate:10,graduate:10,required:0}}
function cohortAttendancePolicy(cohortId) {
 const raw=db.prepare("SELECT liaison_attendance_policy AS policy FROM cohort_settings WHERE cohort_id=?").get(cohortId)?.policy;
 return raw?JSON.parse(raw):legacyAttendancePolicy;
}
function effectiveAttendancePolicy(account) {
 if (account.role!=="liaison") return {mode:"manager"};
 return account.attendance_policy?JSON.parse(account.attendance_policy):cohortAttendancePolicy(account.cohort_id);
}
function publicUser(u,cohorts){return{id:u.id,username:u.username,role:u.role,roleName:u.role==="super"?"校团委组织部":u.role==="org"?"校团委组织部骨干":"小组联络员",cohortId:u.cohort_id,cohortIds:u.role==="org"?cohorts.map(cohort=>cohort.id):[],groupName:u.group_name,canManageAccounts:u.role==="super",canEdit:u.role!=="liaison",attendancePolicy:effectiveAttendancePolicy(u)}}
function validGroup(cohortId, groupName) {
 return Number.isSafeInteger(cohortId) && !!groupName && !!db.prepare(
  "SELECT 1 FROM records r JOIN cohorts c ON c.id=r.cohort_id WHERE c.active=1 AND c.id=? AND r.group_name=? LIMIT 1"
 ).get(cohortId, groupName);
}
function accountExists(username) {
 return !!db.prepare("SELECT 1 FROM admin_accounts WHERE username=?").get(username);
}
function listRegistrations() {
 return db.prepare(`SELECT r.id,r.username,r.role,r.cohort_id AS cohortId,c.name AS cohortName,
  r.group_name AS groupName,r.created_at AS createdAt
  FROM admin_registration_requests r LEFT JOIN cohorts c ON c.id=r.cohort_id ORDER BY r.id DESC`).all()
  .map(row=>({...row,cohorts:row.role==="org"?requestedCohorts(row.id):[]}));
}
function str(v,max=300){return String(v??"").trim().slice(0,max)}
function validType(v){return v==="undergraduate"||v==="graduate"?v:""}
function cleanStudent(v){if(!v||typeof v!=="object")throw new InputError("学员信息无效");const s={name:str(v.name,40),department:str(v.department,80),studentType:validType(v.studentType),groupName:str(v.groupName,40),groupContact:str(v.groupContact,40),politicalStatus:str(v.politicalStatus,40),leagueBranch:str(v.leagueBranch,160),phone:str(v.phone,40),email:str(v.email,120),withdrawn:v.withdrawn?1:0,withdrawalNote:str(v.withdrawalNote,100),sourceTotal:v.sourceTotal===""||v.sourceTotal==null?null:Number(v.sourceTotal),note:str(v.note,300)};if(!s.name||!s.department||!s.studentType)throw new InputError("学员姓名、院系和类型不能为空");if(s.sourceTotal!=null&&!Number.isFinite(s.sourceTotal))s.sourceTotal=null;return s}
function cleanCourse(v){if(!v||typeof v!=="object")throw new InputError("课程信息无效");const c={id:v.id?Number(v.id):null,key:str(v.courseKey,80),name:str(v.name,120),category:v.category==="elective"?"elective":v.category==="required"?"required":"",credits:Number(v.credits),sortOrder:Number(v.sortOrder||0),active:v.active===false||v.active===0?0:1,sourceHeader:str(v.sourceHeader,160)};if((c.id!==null&&(!Number.isSafeInteger(c.id)||c.id<1))||!Number.isSafeInteger(c.sortOrder)||c.sortOrder<0||str(v.credits)===""||!c.name||!c.category||!Number.isFinite(c.credits)||c.credits<0||c.credits>1000)throw new InputError("课程名称、类型、学分或排序无效");if(!c.key)c.key=c.id?`course_${c.id}`:`manual_${Date.now()}_${randomBytes(3).toString("hex")}`;return c}
const studentFields=`r.id,r.name,r.department,r.student_type AS studentType,r.group_name AS groupName,
 r.group_contact AS groupContact,r.political_status AS politicalStatus,r.league_branch AS leagueBranch,
 r.phone,r.email,r.withdrawn,r.withdrawal_note AS withdrawalNote,r.source_total AS sourceTotal,
 r.note,r.updated_at AS updatedAt`;
function studentRows(cohortId,groupName="",studentId=null,includeAttendance=false) {
 const filters=["r.cohort_id=?"], args=[cohortId];
 if (groupName) { filters.push("r.group_name=?"); args.push(groupName); }
 if (studentId!==null) { filters.push("r.id=?"); args.push(studentId); }
 return db.prepare(`SELECT ${studentFields},
  COALESCE(SUM(CASE WHEN c.id IS NOT NULL THEN COALESCE(a.credit_override,c.credits) END),0) AS totalCredits,
  COALESCE(SUM(CASE WHEN c.category='required' THEN COALESCE(a.credit_override,c.credits) END),0) AS requiredCredits,
  COUNT(c.id) AS courseCount
  ${includeAttendance?", GROUP_CONCAT(c.id) AS attendedCourseIds":""}
 FROM records r LEFT JOIN attendance a ON a.student_id=r.id
 LEFT JOIN courses c ON c.id=a.course_id AND c.cohort_id=r.cohort_id AND c.active=1
 WHERE ${filters.join(" AND ")}
 GROUP BY r.id ORDER BY r.student_type,r.group_name,r.department,r.name`).all(...args);
}


function courseRows(cohortId){return db.prepare("SELECT id,course_key AS courseKey,name,category,credits,sort_order AS sortOrder,active,source_header AS sourceHeader,updated_at AS updatedAt FROM courses WHERE cohort_id=? ORDER BY sort_order,id").all(cohortId)}
function completionProgress(student, courses, attended, limits) {
 const totalLimit=limits[student.studentType], requiredLimit=limits.required;
 const required=[0], elective=[0];
 for (const course of courses) {
  if (attended.has(course.id)) continue;
  const credits=course.category==="required"?required:elective;
  credits.push(credits.at(-1)+course.credits);
 }

 // For any fixed number of courses in one category, the highest credits
 // give the best chance of meeting the threshold. Both prefix sums increase.
 let minimum=Infinity;
 let electives=elective.length-1;
 for (let requirements=0;requirements<required.length;requirements++) {
  const requiredGain=required[requirements];
  if (student.requiredCredits+requiredGain<requiredLimit) continue;
  const totalWithRequired=student.totalCredits+requiredGain;
  if (totalWithRequired+elective[electives]<totalLimit) continue;
  while (electives>0 && totalWithRequired+elective[electives-1]>=totalLimit) electives--;
  minimum=Math.min(minimum,requirements+electives);
 }

 const requiredGain=required.at(-1);
 return {
  studiedCourses:attended.size,
  remainingRequired:required.length-1,
  minimumCourses:Number.isFinite(minimum)?minimum:null,
  totalEnoughRequiredShort:student.totalCredits>=totalLimit && student.requiredCredits<requiredLimit,
  canGraduateWithRequiredOnly:!student.completed && required.length>1 &&
   student.totalCredits+requiredGain>=totalLimit && student.requiredCredits+requiredGain>=requiredLimit
 };
}

function cleanCheckInEntries(entries) {
 if (!Array.isArray(entries) || !entries.length || entries.length>3000) return null;
 const fields={name:40,department:80,groupName:40};
 const cleaned=[];
 for (const entry of entries) {
  if (!entry || typeof entry!=="object") return null;
  const row={};
  for (const [key, max] of Object.entries(fields)) {
   const value=entry[key]??"";
   if (typeof value!=="string") return null;
   row[key]=value.trim().normalize("NFC");
   if (row[key].length>max) return null;
  }
  if (!row.name) return null;
  cleaned.push(row);
 }
 return cleaned;
}

function checkInPlan(cohortId, courseId, entries) {
 const students=db.prepare(`
  SELECT r.id,r.name,r.department,r.group_name AS groupName,r.withdrawn,a.status
  FROM records r
  LEFT JOIN attendance a ON a.student_id=r.id AND a.course_id=?
  WHERE r.cohort_id=?
 `).all(courseId,cohortId);
 const byName=new Map();
 for (const student of students) {
  const name=student.name.trim().normalize("NFC");
  if (!byName.has(name)) byName.set(name,[]);
  byName.get(name).push(student);
 }
 const seen=new Set(), ready=[], skipped=[];
 for (const [index, row] of entries.entries()) {
  const candidates=(byName.get(row.name)??[]).filter(student=>
   (!row.department || student.department.trim().normalize("NFC")===row.department) &&
   (!row.groupName || student.groupName.trim().normalize("NFC")===row.groupName));
  const student=candidates[0];
  let reason;
  if (!student) reason="未找到匹配学员";
  else if (candidates.length>1) reason="有重名，请补充院系或小组";
  else if (seen.has(student.id)) reason="名单重复";
  else {
   seen.add(student.id);
   if (student.withdrawn) reason="学员已退出或休学";
   else if (student.status==="attended") reason="已签到";
   else if (student.status) reason="已有补修或特殊课程记录";
  }
  if (reason) skipped.push({...row,line:index+1,reason});
  else ready.push({id:student.id,name:student.name,department:student.department,groupName:student.groupName});
 }
 return {ready,skipped};
}

function adminContext(session) {
 const cohorts=accessibleCohorts(session.user);
 return {
  scope:session.scope,
  user:publicUser(session.user,cohorts),
  cohorts,
  cohort:cohorts.find(cohort=>cohort.id===session.cohortId)??null
 };
}
function dashboard(session) {
 const cohortId=session.cohortId, t=thresholds(cohortId);
 const group=session.user.role==="liaison"?session.user.group_name:"";
 const courses=courseRows(cohortId);
 const available=courses.filter(course=>course.active).sort((a,b)=>b.credits-a.credits);
 const empty=new Set();
 const all=studentRows(cohortId,group,null,true).map(({attendedCourseIds,...row})=>{
  const completed=!row.withdrawn && row.totalCredits>=t[row.studentType] && row.requiredCredits>=t.required;
  const record={...row,completed};
  if (!row.withdrawn) {
   const attended=attendedCourseIds?new Set(attendedCourseIds.split(",").map(Number)):empty;
   record.progress=completionProgress(record,available,attended,t);
  }
  return record;
 });
 const active=all.filter(row=>!row.withdrawn);
 const summarize=rows=>{
  const count=rows.length, passed=rows.filter(row=>row.completed).length;
  return {
   count,passed,
   rate:count?Math.round(passed*1000/count)/10:0,
   average:count?Math.round(rows.reduce((sum,row)=>sum+row.totalCredits,0)*10/count)/10:0
  };
 };
 return {
  ...adminContext(session),records:all,courses,thresholds:t,features:{workbookRoundTrip:true},
  stats:{
   total:summarize(active),
   undergraduate:summarize(active.filter(row=>row.studentType==="undergraduate")),
   graduate:summarize(active.filter(row=>row.studentType==="graduate")),
   withdrawn:all.length-active.length
  }
 };
}
function upsertStudent(s,cohortId){return db.prepare(`INSERT INTO records(name,department,student_type,credits,note,group_name,group_contact,political_status,league_branch,phone,email,withdrawn,withdrawal_note,source_total,cohort_id,updated_at) VALUES(?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(cohort_id,name,department,student_type) DO UPDATE SET note=COALESCE(NULLIF(excluded.note,''),records.note),group_name=excluded.group_name,group_contact=excluded.group_contact,political_status=excluded.political_status,league_branch=excluded.league_branch,phone=excluded.phone,email=excluded.email,withdrawn=excluded.withdrawn,withdrawal_note=excluded.withdrawal_note,source_total=COALESCE(excluded.source_total,records.source_total),updated_at=CURRENT_TIMESTAMP RETURNING id`).get(s.name,s.department,s.studentType,s.note,s.groupName,s.groupContact,s.politicalStatus,s.leagueBranch,s.phone,s.email,s.withdrawn,s.withdrawalNote,s.sourceTotal,cohortId).id}

function workbookBuffer(cohortId,template=false) {
 const wb=XLSX.utils.book_new();
 const courses=template?[
  {name:"必修课程示例",category:"required",credits:2,sortOrder:1},
  {name:"选修课程示例",category:"elective",credits:3,sortOrder:2}
 ]:courseRows(cohortId).filter(course=>course.active);
 const headers=[...studentHeaders,...courses.map(course=>course.name),...withdrawalHeaders];
 const students=template?[]:studentRows(cohortId);
 const attendance=template?[]:db.prepare(`SELECT a.student_id AS studentId,a.course_id AS courseId,a.status
  FROM records r JOIN attendance a ON a.student_id=r.id JOIN courses c ON c.id=a.course_id
  WHERE r.cohort_id=? AND c.cohort_id=? AND c.active=1`).all(cohortId,cohortId);
 const marks=new Map(attendance.map(row=>[row.studentId+":"+row.courseId,
  row.status==="special"?"2 2/3":row.status==="makeup"?2:1]));
 for(const [type,sheetName] of [["undergraduate","本科组"],["graduate","硕博组"]]) {
  const rows=students.filter(student=>student.studentType===type).map((s,index)=>[
   s.groupName,index+1,s.groupContact,s.name,s.politicalStatus,s.department,s.leagueBranch,s.phone,s.email,
   ...courses.map(course=>marks.get(s.id+":"+course.id)??""),s.withdrawn?"是":"否",s.withdrawalNote
  ]);
  const sheet=XLSX.utils.aoa_to_sheet([headers,...rows]);
  sheet["!cols"]=headers.map((_,index)=>({wch:index===3||index>=9?22:16}));
  XLSX.utils.book_append_sheet(wb,sheet,sheetName);
 }
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([
  ["课程名称","课程类型","标准学分","排序","课程标识（导出后保留）"],
  ...courses.map(course=>[course.name,course.category==="required"?"必修":"选修",
   course.credits,course.sortOrder,course.courseKey?.replace(/^\d+:/,"")??""])
 ]),"课程设置");
 if(!template) {
  const t=thresholds(cohortId);
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([
   ["姓名","院系","学员类型","组别","总学分","必修学分","是否结业","是否退出","退出备注"],
   ...students.map(r=>[r.name,r.department,r.studentType==="undergraduate"?"本科生":"硕博生",r.groupName,
    r.totalCredits,r.requiredCredits,!r.withdrawn&&r.totalCredits>=t[r.studentType]&&r.requiredCredits>=t.required?"是":"否",
    r.withdrawn?"是":"否",r.withdrawalNote])
  ]),"学员汇总");
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([
   ["本科生结业学分","硕博生结业学分","必修课结业学分"],[t.undergraduate,t.graduate,t.required]
  ]),"结业设置");
 }
 return XLSX.write(wb,{type:"buffer",bookType:"xlsx",compression:true});
}

function setThresholds(cohortId, settings) {
 const values=["undergraduate","graduate","required"].map(key=>
  str(settings?.[key])===""?NaN:Number(settings[key]));
 if(values.some(value=>!Number.isFinite(value)||value<0||value>10000)) throw new InputError("结业学分无效");
 db.prepare(`INSERT INTO cohort_settings(cohort_id,threshold_undergraduate,threshold_graduate,threshold_required)
  VALUES(?,?,?,?) ON CONFLICT(cohort_id) DO UPDATE SET threshold_undergraduate=excluded.threshold_undergraduate,
  threshold_graduate=excluded.threshold_graduate,threshold_required=excluded.threshold_required`).run(cohortId,...values);
}

function importTrainingData(cohortId, payload) {
 if(!Array.isArray(payload?.students)||!Array.isArray(payload?.courses)||!Array.isArray(payload?.attendance)) {
  throw new InputError("导入数据结构不正确");
 }
 const {students,courses,attendance}=payload;
 if(!(students.length||courses.length)) throw new InputError("文件中没有可导入的学员或课程");
 if(students.length>3000||courses.length>1000||attendance.length>100000) throw new InputError("导入数据量过大",413);
 const existingCourses=courseRows(cohortId), byStoredKey=new Map(existingCourses.map(course=>[course.courseKey,course]));
 const coursesByName=new Map();
 for(const course of existingCourses) {
  if(!coursesByName.has(course.name)) coursesByName.set(course.name,[]);
  coursesByName.get(course.name).push(course);
 }
 const courseKeys=new Set(), destinationKeys=new Set();
 const parsedCourses=courses.map(raw=>{
  const key=str(raw?.courseKey,80);
  if(!key||courseKeys.has(key)) throw new InputError("课程列标识缺失或重复");
  courseKeys.add(key);
  const course=cleanCourse(raw);
  const rawStorageKey=raw.storageKey===null?"":str(raw.storageKey??raw.courseKey,80);
  const storageKey=rawStorageKey?cohortId+":"+rawStorageKey:"";
  const named=coursesByName.get(course.name)??[];
  const byKey=byStoredKey.get(storageKey);
  // Exported identifiers are explicit. Legacy column keys can move when a sheet is rearranged.
  const explicit=raw.storageKey!=null && raw.storageKey!=="";
  if(!byKey && named.length>1) throw new InputError("系统中有多门同名课程「"+course.name+"」，请在工作簿中保留课程标识");
  const match=explicit&&byKey?byKey:(named.length===1?named[0]:byKey);
  const destination=match?.courseKey||storageKey||cohortId+":xlsx_"+randomBytes(8).toString("hex");
  if(destinationKeys.has(destination)) throw new InputError("两列课程匹配到同一门课，请检查课程名称和标识");
  destinationKeys.add(destination);
  return {course,key,destination};
 });
 const studentKeys=new Set(), identities=new Set();
 const parsedStudents=students.map(raw=>{
  const key=str(raw?.importKey,200), student=cleanStudent(raw);
  const identity=JSON.stringify([student.studentType,student.department,student.name]);
  if(!key||studentKeys.has(key)||identities.has(identity)) throw new InputError("导入文件中有重复的学员记录，请核对姓名、院系和类型");
  studentKeys.add(key);
  identities.add(identity);
  return {student,key};
 });
 const checkedAttendance=new Set();
 for(const row of attendance) {
  const pair=JSON.stringify([row?.studentKey,row?.courseKey]);
  if(!studentKeys.has(row?.studentKey)||!courseKeys.has(row?.courseKey)
     ||!["attended","makeup","special"].includes(row?.status)||checkedAttendance.has(pair)) {
   throw new InputError("出勤记录包含重复行或无法匹配的课程、学员");
  }
  checkedAttendance.add(pair);
 }
 return transaction(()=>{
  if(payload.thresholds!==undefined) setThresholds(cohortId,payload.thresholds);
  const saveCourse=db.prepare(`INSERT INTO courses(course_key,name,category,credits,sort_order,active,source_header,cohort_id)
   VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(course_key) DO UPDATE SET name=excluded.name,category=excluded.category,
   credits=excluded.credits,sort_order=excluded.sort_order,active=1,source_header=excluded.source_header,
   updated_at=CURRENT_TIMESTAMP RETURNING id`);
  const courseIds=new Map(parsedCourses.map(({course,key,destination})=>[key,
   saveCourse.get(destination,course.name,course.category,course.credits,course.sortOrder,course.sourceHeader,cohortId).id]));
  const importedIds=[...courseIds.values()];
  const remove=importedIds.length?db.prepare("DELETE FROM attendance WHERE student_id=? AND course_id IN ("+
   importedIds.map(()=>"?").join(",")+")"):null;
  const studentIds=new Map(parsedStudents.map(({student,key})=>{
   const id=upsertStudent(student,cohortId);
   if(remove) remove.run(id,...importedIds);
   return [key,id];
  }));
  const insert=db.prepare("INSERT INTO attendance(student_id,course_id,status,source_mark,credit_override) VALUES(?,?,?,?,?)");
  for(const row of attendance) insert.run(studentIds.get(row.studentKey),courseIds.get(row.courseKey),row.status,str(row.sourceMark,30),row.status==="special"?8:null);
  return {ok:true,students:students.length,courses:courses.length,attendance:attendance.length};
 });
}

async function api(req,res,url){try{
if(req.method==="POST"&&url.pathname==="/api/admin/register"){
 const d=await body(req, 8192), username=String(d.username??"").trim(), password=d.password, role=d.role;
 if (!username || username.length>60 || /[\s\u0000-\u001f\u007f]/u.test(username) ||
     typeof password!=="string" || password.length<8 || password.length>128) {
  return json(res,400,{error:"请填写不含空白的账号（最多 60 字），密码须为 8 至 128 字符"});
 }
 if (!["org","liaison"].includes(role)) return json(res,400,{error:"请选择可申请的角色"});
 const cohortId=role==="liaison"?Number(d.cohortId):null, groupName=role==="liaison"?str(d.groupName,40):"";
 if (role==="liaison" && !validGroup(cohortId,groupName)) return json(res,400,{error:"请选择有效的培训班与负责小组"});
 if (role==="org" && !validCohortIds(d.cohortIds)) return json(res,400,{error:"请选择至少一个有效的培训班/团校"});
 if (["pkuzzb","zhangtongwei",process.env.SUPER_ADMIN_1_USERNAME,process.env.SUPER_ADMIN_2_USERNAME].includes(username) ||
     accountExists(username) || db.prepare("SELECT 1 FROM admin_registration_requests WHERE username=?").get(username)) {
  return json(res,409,{error:"该账号已使用或已提交申请"});
 }
 const hash=passwordHash(password);
 transaction(()=>{
  const result=db.prepare("INSERT INTO admin_registration_requests(username,password_hash,role,cohort_id,group_name) VALUES(?,?,?,?,?)")
   .run(username,hash,role,cohortId,groupName);
  if (role==="org") {
   const add=db.prepare("INSERT INTO registration_cohort_requests(registration_id,cohort_id) VALUES(?,?)");
   for (const id of d.cohortIds) add.run(result.lastInsertRowid,id);
  }
 });
 return json(res,201,{ok:true});
}
if(req.method==="GET"&&url.pathname==="/api/admin/registrations"){
 if (!requireSuper(req,res)) return;
 return json(res,200,{registrations:listRegistrations()});
}
const reviewMatch=url.pathname.match(/^\/api\/admin\/registrations\/(\d+)$/);
if(req.method==="POST"&&reviewMatch){
 if (!requireSuper(req,res)) return;
 const {decision,cohortIds}=await body(req,8192);
 // Recheck authorization after reading the request body.
 if (!requireSuper(req,res)) return;
 if (!["approve","reject"].includes(decision)) return json(res,400,{error:"请选择审批操作"});
 const id=Number(reviewMatch[1]);
 db.exec("BEGIN IMMEDIATE");
 try {
  const application=db.prepare("SELECT * FROM admin_registration_requests WHERE id=?").get(id);
  if (!application) {
   db.exec("ROLLBACK");
   return json(res,404,{error:"申请已处理或不存在"});
  }
  if (decision==="approve") {
   if (accountExists(application.username) ||
       (application.role==="liaison" && !validGroup(application.cohort_id,application.group_name))) {
    db.exec("ROLLBACK");
    return json(res,409,{error:"账号已被占用，或申请的小组已不存在。请驳回后重新申请。"});
   }
   const grants=application.role==="org"?(cohortIds??requestedCohorts(id).map(cohort=>cohort.id)):[];
   if (application.role==="org" && !validCohortIds(grants)) {
    db.exec("ROLLBACK");
    return json(res,400,{error:"通过组织部骨干申请前，请至少选择一个有效的培训班/团校"});
   }
   const result=db.prepare("INSERT INTO admin_accounts(username,password_hash,role,cohort_id,group_name) VALUES(?,?,?,?,?)")
    .run(application.username,application.password_hash,application.role,application.cohort_id,application.group_name);
   if (application.role==="org") replaceOrgGrants(result.lastInsertRowid,grants);
  }
  db.prepare("DELETE FROM admin_registration_requests WHERE id=?").run(id);
  db.exec("COMMIT");
 } catch(error) {
  db.exec("ROLLBACK");
  throw error;
 }
 return json(res,200,{ok:true});
}
if(req.method==="GET"&&url.pathname==="/api/meta"){const cohorts=db.prepare("SELECT id,name FROM cohorts WHERE active=1 ORDER BY id DESC").all(),cohortId=Number(url.searchParams.get("cohortId")),departments=cohortId?db.prepare("SELECT DISTINCT department FROM records WHERE cohort_id=? ORDER BY department COLLATE NOCASE").all(cohortId).map(r=>r.department):[],groups=cohortId?db.prepare("SELECT DISTINCT group_name AS name FROM records WHERE cohort_id=? AND trim(group_name)<>'' ORDER BY group_name COLLATE NOCASE").all(cohortId).map(r=>r.name):[];return json(res,200,{cohorts,departments,groups,thresholds:cohortId?thresholds(cohortId):null})}
if(req.method==="POST"&&url.pathname==="/api/query"){
 const d=await body(req,8192);
 const name=str(d?.name,40),department=str(d?.department,80),groupName=str(d?.groupName,40),studentType=validType(d?.studentType),cohortId=Number(d?.cohortId);
 if(!name||!department||!groupName||!studentType||!Number.isSafeInteger(cohortId)||cohortId<1) {
  return json(res,400,{error:"请选择培训班、所属小组，并填写姓名、院系和学员类型"});
 }
 const student=db.prepare(`SELECT r.id,r.withdrawn FROM records r JOIN cohorts c ON c.id=r.cohort_id AND c.active=1
  WHERE r.cohort_id=? AND r.name=? AND r.department=? AND r.student_type=? AND r.group_name=?`)
  .get(cohortId,name,department,studentType,groupName);
 if(!student) return json(res,404,{error:"未查到对应记录，请核对培训班、所属小组、姓名、院系和学员类型"});
 const courses=db.prepare(`SELECT c.name,c.category,COALESCE(a.credit_override,c.credits) AS credits,a.status
  FROM attendance a JOIN courses c ON c.id=a.course_id WHERE a.student_id=? AND c.cohort_id=? AND c.active=1
  ORDER BY c.sort_order,c.id`).all(student.id,cohortId);
 const totalCredits=courses.reduce((sum,course)=>sum+course.credits,0);
 const requiredCredits=courses.reduce((sum,course)=>sum+(course.category==="required"?course.credits:0),0);
 const t=thresholds(cohortId), completed=!student.withdrawn&&totalCredits>=t[studentType]&&requiredCredits>=t.required;
 return json(res,200,{name,department,totalCredits,requiredCredits,completed,withdrawn:!!student.withdrawn,thresholds:t,courses});
}
if(req.method==="POST"&&url.pathname==="/api/admin/login"){
 const d=await body(req,8192), username=str(d?.username,60), password=d?.password;
 if (typeof password!=="string" || password.length>1024) return json(res,401,{error:"账号或密码不正确"});
 const account=db.prepare("SELECT * FROM admin_accounts WHERE username=? AND active=1").get(username);
 if (!account) {
  const application=db.prepare("SELECT password_hash FROM admin_registration_requests WHERE username=?").get(username);
  if (application && await passwordMatches(password,application.password_hash)) {
   return json(res,403,{error:"注册申请正在等待审批，审批通过后即可登录"});
  }
 }
 if (!account || !await passwordMatches(password,account.password_hash)) return json(res,401,{error:"账号或密码不正确"});
 const current=activeAccount.get(account.id);
 if (!current || current.username!==username || current.password_hash!==account.password_hash) {
  return json(res,401,{error:"账号或密码不正确"});
 }
 const now=Date.now(), t=randomBytes(32).toString("base64url"), session={expires:now+SESSION_MS,user:current};
 setAdminCohort(session,null);
 sessions.delete(token(req));
 for (const [key,value] of sessions) if (value.expires<now) sessions.delete(key);
 sessions.set(t,session);
 return json(res,200,adminContext(session),{"Set-Cookie":`pku_admin=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secureCookie}`});
}
if(req.method==="POST"&&url.pathname==="/api/admin/logout"){
 const session=adminSession(req);
 if(session && !adminScopeMatches(res,session,req.headers["x-pku-admin-scope"])) return;
 sessions.delete(token(req));
 return json(res,200,{ok:true},{"Set-Cookie":`pku_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`});
}
if(req.method==="GET"&&url.pathname==="/api/admin/session"){
 const s=requireIdentity(req,res);
 if(!s)return;
 return json(res,200,s.cohortId===null?adminContext(s):dashboard(s));
}
if(req.method==="POST"&&url.pathname==="/api/admin/session/cohort"){
 const d=await body(req,8192), session=requireIdentity(req,res);
 if(!session || !adminScopeMatches(res,session,req.headers["x-pku-admin-scope"])) return;
 const cohortId=d?.cohortId;
 if(!Number.isSafeInteger(cohortId) || cohortId<1) return json(res,400,{error:"请选择培训班/团校"});
 if(!canAccessCohort(session.user,cohortId)) return json(res,403,{error:"该培训班/团校不在账号的授权范围内"});
 const saved=sessions.get(token(req));
 if(saved.cohortId!==cohortId) setAdminCohort(saved,cohortId);
 return json(res,200,dashboard({...saved,user:session.user}));
}
if(req.method==="GET"&&url.pathname==="/api/admin/dashboard"){const s=requireAdmin(req,res);if(!s)return;return json(res,200,dashboard(s))}
if(req.method==="POST"&&url.pathname==="/api/admin/settings"){
 if(!requireWrite(req,res)) return;
 const d=await body(req,8192), session=requireWrite(req,res);
 if(!session) return;
 setThresholds(session.cohortId,d);
 return json(res,200,{ok:true});
}
if(req.method==="POST"&&url.pathname==="/api/admin/cohorts"){
 if(!requireWrite(req,res)) return;
 const d=await body(req);
 const session=requireWrite(req,res);
 if(!session) return;
 const name=str(d.name,100), id=Number(d.id||0);
 if(!name || !Number.isSafeInteger(id) || id<0) return json(res,400,{error:"请填写有效的培训班/团校名称"});
 if(db.prepare("SELECT 1 FROM cohorts WHERE name=? AND id<>?").get(name,id)) {
  return json(res,409,{error:"该培训班/团校名称已存在"});
 }
 if(id){
  if(!canAccessCohort(session.user,id)) return json(res,403,{error:"该培训班/团校不在账号的授权范围内"});
  db.prepare("UPDATE cohorts SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(name,id);
 } else {
  if(session.user.role!=="super") return json(res,403,{error:"仅最高权限账号可以新增培训班/团校"});
  transaction(()=>{
   const result=db.prepare("INSERT INTO cohorts(name) VALUES(?)").run(name);
   db.prepare("INSERT INTO cohort_settings(cohort_id) VALUES(?)").run(result.lastInsertRowid);
  });
 }
 return json(res,200,{ok:true});
}
if(req.method==="POST"&&url.pathname==="/api/admin/students"){
 if(!requireWrite(req,res)) return;
 const d=await body(req);
 const session=requireWrite(req,res);
 if(!session) return;
 const s=cleanStudent(d), id=Number(d.id||0), cohortId=session.cohortId;
 if(!Number.isSafeInteger(id)||id<0) return json(res,400,{error:"学员编号无效"});
 if(!id) {
  if(db.prepare("SELECT 1 FROM records WHERE cohort_id=? AND name=? AND department=? AND student_type=?")
    .get(cohortId,s.name,s.department,s.studentType)) {
   return json(res,409,{error:"该学员已存在，请从列表打开原记录编辑"});
  }
  return json(res,200,{ok:true,id:upsertStudent(s,cohortId)});
 }
 if(!db.prepare("SELECT 1 FROM records WHERE id=? AND cohort_id=?").get(id,cohortId)) {
  return json(res,404,{error:"学员不存在或不在当前培训班/团校"});
 }
 if(db.prepare("SELECT 1 FROM records WHERE cohort_id=? AND name=? AND department=? AND student_type=? AND id<>?")
    .get(cohortId,s.name,s.department,s.studentType,id)) {
  return json(res,409,{error:"当前培训班/团校已存在相同姓名、院系和学员类型的记录"});
 }
 db.prepare("UPDATE records SET name=?,department=?,student_type=?,group_name=?,group_contact=?,political_status=?,league_branch=?,phone=?,email=?,withdrawn=?,withdrawal_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND cohort_id=?")
  .run(s.name,s.department,s.studentType,s.groupName,s.groupContact,s.politicalStatus,s.leagueBranch,s.phone,s.email,s.withdrawn,s.withdrawalNote,id,cohortId);
 return json(res,200,{ok:true,id});
}
const studentMatch=url.pathname.match(/^\/api\/admin\/students\/(\d+)$/);
if(req.method==="GET"&&studentMatch){const session=requireAdmin(req,res);if(!session)return;const cohortId=session.cohortId,id=Number(studentMatch[1]),group=session.user.role==="liaison"?session.user.group_name:"",student=studentRows(cohortId,group,id)[0];if(!student)return json(res,404,{error:"学员不存在或不在账号管理范围内"});const attendance=db.prepare("SELECT c.id AS courseId,c.name,c.category,c.credits,a.status,a.source_mark AS sourceMark,a.credit_override AS creditOverride FROM courses c LEFT JOIN attendance a ON a.course_id=c.id AND a.student_id=? WHERE c.active=1 AND c.cohort_id=? ORDER BY c.sort_order,c.id").all(id,cohortId);return json(res,200,{student,attendance,attendancePolicy:effectiveAttendancePolicy(session.user)})}
if(req.method==="DELETE"&&studentMatch){const session=requireWrite(req,res);if(!session)return;const id=Number(studentMatch[1]),student=db.prepare("SELECT id FROM records WHERE id=? AND cohort_id=?").get(id,session.cohortId);if(!student)return json(res,404,{error:"学员不存在"});db.prepare("DELETE FROM records WHERE id=?").run(id);return json(res,200,{ok:true})}
if(req.method==="POST"&&url.pathname==="/api/admin/courses"){
 if(!requireWrite(req,res)) return;
 const d=await body(req,8192), session=requireWrite(req,res);
 if(!session) return;
 const c=cleanCourse(d), cohortId=session.cohortId;
 if(c.id!==null) {
  const updated=db.prepare(`UPDATE courses SET name=?,category=?,credits=?,sort_order=?,active=?,
   updated_at=CURRENT_TIMESTAMP WHERE id=? AND cohort_id=?`).run(c.name,c.category,c.credits,c.sortOrder,c.active,c.id,cohortId);
  if(!updated.changes) return json(res,404,{error:"课程不存在或不在当前培训班/团校"});
 } else {
  db.prepare(`INSERT INTO courses(course_key,name,category,credits,sort_order,active,source_header,cohort_id)
   VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(course_key) DO UPDATE SET name=excluded.name,
   category=excluded.category,credits=excluded.credits,sort_order=excluded.sort_order,active=excluded.active,
   source_header=excluded.source_header,updated_at=CURRENT_TIMESTAMP`)
   .run(cohortId+":"+c.key,c.name,c.category,c.credits,c.sortOrder,c.active,c.sourceHeader,cohortId);
 }
 return json(res,200,{ok:true});
}
const courseMatch=url.pathname.match(/^\/api\/admin\/courses\/(\d+)$/);
if(req.method==="DELETE"&&courseMatch){
 const session=requireWrite(req,res);
 if(!session) return;
 const updated=db.prepare("UPDATE courses SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND cohort_id=?")
  .run(Number(courseMatch[1]),session.cohortId);
 if(!updated.changes) return json(res,404,{error:"课程不存在或不在当前培训班/团校"});
 return json(res,200,{ok:true});
}
const checkInMatch=url.pathname.match(/^\/api\/admin\/courses\/(\d+)\/check-in$/);
if (req.method==="POST" && checkInMatch) {
 if (!requireWrite(req,res)) return;
 const payload=await body(req,2_000_000);
 const session=requireWrite(req,res);
 if (!session) return;
 const courseId=Number(checkInMatch[1]), entries=cleanCheckInEntries(payload?.entries);
 const commit=payload?.action==="commit";
 if (!entries || (!commit && payload?.action!=="preview")) {
  return json(res,400,{error:"请提交 1 至 3000 条有效的名单记录"});
 }
 const expected=payload.expectedIds;
 if (commit && (!Array.isArray(expected) || expected.length===0 || expected.length>entries.length ||
     !expected.every(id=>Number.isSafeInteger(id) && id>0) || new Set(expected).size!==expected.length)) {
  return json(res,400,{error:"请先核对待签到名单"});
 }
 if (commit) db.exec("BEGIN IMMEDIATE");
 try {
  const course=db.prepare("SELECT id FROM courses WHERE id=? AND cohort_id=? AND active=1").get(courseId,session.cohortId);
  if (!course) {
   if (commit) db.exec("ROLLBACK");
   return json(res,404,{error:"该课程不存在或已停用"});
  }
  const plan=checkInPlan(session.cohortId,courseId,entries);
  if (!commit) return json(res,200,plan);
  const expectedSet=new Set(expected);
  if (plan.ready.length!==expected.length || !plan.ready.every(student=>expectedSet.has(student.id))) {
   db.exec("ROLLBACK");
   return json(res,409,{error:"学员或出勤记录已更新，请重新预览后确认"});
  }
  const insert=db.prepare("INSERT INTO attendance(student_id,course_id,status,source_mark) VALUES(?,?,'attended','名单签到')");
  for (const student of plan.ready) insert.run(student.id,courseId);
  db.exec("COMMIT");
  return json(res,200,{signed:plan.ready.length,skipped:plan.skipped.length});
 } catch (error) {
  if (commit) db.exec("ROLLBACK");
  throw error;
 }
}
const courseAttendanceMatch=url.pathname.match(/^\/api\/admin\/courses\/(\d+)\/attendance$/);
if(req.method==="GET"&&courseAttendanceMatch){const session=requireAdmin(req,res);if(!session)return;const cohortId=session.cohortId,courseId=Number(courseAttendanceMatch[1]),course=courseRows(cohortId).find(c=>c.id===courseId);if(!course?.active)return json(res,404,{error:"课程不存在"});const group=session.user.role==="liaison"?session.user.group_name:"",where=group?"r.cohort_id=? AND r.group_name=?":"r.cohort_id=?",args=group?[courseId,cohortId,group]:[courseId,cohortId],students=db.prepare(`SELECT r.id,r.name,r.department,r.student_type AS studentType,r.group_name AS groupName,r.withdrawn,a.status,a.source_mark AS sourceMark,a.credit_override AS creditOverride FROM records r LEFT JOIN attendance a ON a.student_id=r.id AND a.course_id=? WHERE ${where} ORDER BY r.withdrawn,r.student_type,r.group_name,r.name`).all(...args);return json(res,200,{course,students,attendancePolicy:effectiveAttendancePolicy(session.user)})}
const personalAttendance=url.pathname==="/api/admin/attendance";
if(req.method==="POST" && (courseAttendanceMatch || personalAttendance)) {
 if(!requireAdmin(req,res)) return;
 const d=await body(req);
 const session=requireAdmin(req,res);
 if(!session) return;
 const courseId=Number(courseAttendanceMatch?.[1]), studentId=Number(d?.studentId);
 if(!Array.isArray(d?.items)) return json(res,400,{error:"出勤数据无效"});
 const items=d.items.map(row=>({
  studentId:personalAttendance?studentId:Number(row?.studentId),
  courseId:personalAttendance?Number(row?.courseId):courseId,
  status:row?.status??"",
  expectedStatus:row?.expectedStatus,
  sourceMark:str(row?.sourceMark,30)
 }));
 const statuses=["","attended","makeup","special"];
 if(items.some(item=>!Number.isSafeInteger(item.studentId)||item.studentId<1||
  !Number.isSafeInteger(item.courseId)||item.courseId<1||!statuses.includes(item.status)||
  (item.expectedStatus!==undefined && !statuses.includes(item.expectedStatus))) ||
  new Set(items.map(item=>item.studentId+":"+item.courseId)).size!==items.length) {
  return json(res,400,{error:"出勤数据无效"});
 }
 const liaison=session.user.role==="liaison", policy=effectiveAttendancePolicy(session.user);
 const findStudent=db.prepare("SELECT group_name,withdrawn FROM records WHERE id=? AND cohort_id=?");
 const findCourse=db.prepare("SELECT category FROM courses WHERE id=? AND cohort_id=? AND active=1");
 const findStatus=db.prepare("SELECT status FROM attendance WHERE student_id=? AND course_id=?");
 const result=transaction(()=>{
  const changes=[];
  for(const item of items){
   const student=findStudent.get(item.studentId,session.cohortId);
   const course=findCourse.get(item.courseId,session.cohortId);
   if(!student || !course || (liaison && student.group_name!==session.user.group_name)) {
    return {status:403,error:"学员或课程不在账号的管理范围内"};
   }
   const current=findStatus.get(item.studentId,item.courseId)?.status??"";
   if(current===item.status) continue;
   if(item.expectedStatus!==undefined && item.expectedStatus!==current) {
    return {status:409,error:"出勤记录已有变化，请关闭窗口后重新打开核对"};
   }
   if(!attendanceOptions(policy,course.category,current,student.withdrawn).includes(item.status)) {
    return {status:403,error:"当前权限无法更改这条出勤，请关闭窗口后重新打开核对权限"};
   }
   changes.push(item);
  }
  const remove=db.prepare("DELETE FROM attendance WHERE student_id=? AND course_id=?");
  const save=db.prepare(`INSERT INTO attendance(student_id,course_id,status,source_mark,credit_override,updated_at)
   VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(student_id,course_id) DO UPDATE SET status=excluded.status,
   source_mark=excluded.source_mark,credit_override=excluded.credit_override,updated_at=CURRENT_TIMESTAMP`);
  for(const item of changes){
   if(!item.status) remove.run(item.studentId,item.courseId);
   else save.run(item.studentId,item.courseId,item.status,liaison?(item.status==="makeup"?"2":"1"):item.sourceMark,item.status==="special"?8:null);
  }
 });
 if(result) return json(res,result.status,{error:result.error});
 return json(res,200,{ok:true});
}
if(req.method==="POST"&&url.pathname==="/api/admin/import-full"){
 if(!requireWrite(req,res)) return;
 const payload=await body(req), session=requireWrite(req,res);
 if(!session) return;
 return json(res,200,importTrainingData(session.cohortId,payload));
}
if(req.method==="GET"&&url.pathname==="/api/admin/template.xlsx"){const s=requireWrite(req,res,url.searchParams.get("scope")??undefined);if(!s)return;return binary(res,workbookBuffer(s.cohortId,true),"完整导入模板.xlsx")}
if(req.method==="GET"&&url.pathname==="/api/admin/export.xlsx"){const s=requireWrite(req,res,url.searchParams.get("scope")??undefined);if(!s)return;return binary(res,workbookBuffer(s.cohortId,false),`${activeCohort.get(s.cohortId).name}-完整数据.xlsx`)}
if(req.method==="GET"&&url.pathname==="/api/admin/accounts"){
 if(!requireSuper(req,res))return;
 const accounts=db.prepare("SELECT a.id,a.username,a.role,a.cohort_id AS cohortId,c.name AS cohortName,a.group_name AS groupName,a.active,a.attendance_policy FROM admin_accounts a LEFT JOIN cohorts c ON c.id=a.cohort_id ORDER BY CASE a.role WHEN 'super' THEN 0 WHEN 'org' THEN 1 ELSE 2 END,a.username").all()
  .map(({attendance_policy,...account})=>({...account,
   cohorts:account.role==="org"?orgCohorts(account.id):[],
   attendancePolicy:attendance_policy?JSON.parse(attendance_policy):null
  }));
 const cohorts=db.prepare("SELECT id,name FROM cohorts WHERE active=1 ORDER BY id DESC").all()
  .map(cohort=>({...cohort,attendancePolicy:cohortAttendancePolicy(cohort.id)}));
 return json(res,200,{accounts,cohorts});
}
if(req.method==="PATCH"&&url.pathname==="/api/admin/liaison-attendance"){
 if(!requireSuper(req,res))return;
 const d=await body(req,64_000);
 if(!requireSuper(req,res))return;
 const byCohort=d?.cohortId!==undefined, byAccount=d?.accountIds!==undefined;
 if(byCohort===byAccount) return json(res,400,{error:"请指定联络员账号或一个培训班/团校"});
 const policy=d.attendancePolicy===null&&!byCohort?null:normalizeAttendancePolicy(d.attendancePolicy);
 if(policy===undefined) return json(res,400,{error:"请选择有效的出勤权限，自定义权限须至少勾选一种状态"});
 const stored=policy===null?null:JSON.stringify(policy);
 if(byCohort){
  if(!validCohortIds([d.cohortId])) return json(res,400,{error:"请选择有效的培训班/团校"});
  const updated=transaction(()=>{
   db.prepare("INSERT INTO cohort_settings(cohort_id,liaison_attendance_policy) VALUES(?,?) ON CONFLICT(cohort_id) DO UPDATE SET liaison_attendance_policy=excluded.liaison_attendance_policy").run(d.cohortId,stored);
   return db.prepare("UPDATE admin_accounts SET attendance_policy=NULL,updated_at=CURRENT_TIMESTAMP WHERE role='liaison' AND cohort_id=?").run(d.cohortId).changes;
  });
  return json(res,200,{ok:true,updated});
 }
 const ids=d.accountIds;
 if(!Array.isArray(ids)||!ids.length||ids.length>3000||new Set(ids).size!==ids.length||
    ids.some(id=>!Number.isSafeInteger(id)||id<1)) return json(res,400,{error:"请选择有效的联络员账号"});
 const updated=transaction(()=>{
  const exists=db.prepare("SELECT 1 FROM admin_accounts WHERE id=? AND role='liaison' AND active=1");
  if(ids.some(id=>!exists.get(id))) return 0;
  const change=db.prepare("UPDATE admin_accounts SET attendance_policy=?,updated_at=CURRENT_TIMESTAMP WHERE id=?");
  for(const id of ids) change.run(stored,id);
  return ids.length;
 });
 if(!updated) return json(res,409,{error:"所选账号已变更，请刷新账号列表后重新选择"});
 return json(res,200,{ok:true,updated});
}
if(req.method==="POST"&&url.pathname==="/api/admin/accounts"){
 if(!requireSuper(req,res))return;
 const d=await body(req),id=Number(d.id),username=str(d.username,60),password=String(d.password||""),role=["super","org","liaison"].includes(d.role)?d.role:"",cohortId=role==="liaison"?Number(d.cohortId):null,groupName=role==="liaison"?str(d.groupName,40):"",target=id?db.prepare("SELECT username,role FROM admin_accounts WHERE id=?").get(id):null;
 if(!requireSuper(req,res))return;
 if(!username||!role||(!id&&!password)||(role==="liaison"&&(!cohortId||!groupName)))return json(res,400,{error:"请完整填写账号、角色及管理范围"});
 if(id&&!target)return json(res,404,{error:"账号不存在"});
 if(role==="liaison" && !validGroup(cohortId,groupName)) return json(res,400,{error:"请选择有效的培训班/团校和负责小组"});
 if(db.prepare("SELECT 1 FROM admin_accounts WHERE username=? AND id<>?").get(username,id||0)) {
  return json(res,409,{error:"该账号名称已被使用"});
 }
 if(role==="super"&&target?.role!=="super")return json(res,403,{error:"最高权限账号不能通过此界面新增"});
 if(target?.role==="super"&&(role!=="super"||username!==target.username))return json(res,403,{error:"最高权限账号不能改名或降权"});
 if(role==="org" && !validCohortIds(d.cohortIds,{allowEmpty:target?.role==="org"})) {
  return json(res,400,{error:"请选择有效的培训班/团校。新增组织部骨干至少选一项。"});
 }
 const hash=password?passwordHash(password):null;
 transaction(()=>{
  let accountId=id;
  if(id) {
   db.prepare("UPDATE admin_accounts SET username=?,attendance_policy=CASE WHEN role='liaison' AND ?='liaison' AND cohort_id=? THEN attendance_policy ELSE NULL END,role=?,cohort_id=?,group_name=?,password_hash=COALESCE(?,password_hash),updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(username,role,cohortId,role,cohortId,groupName,hash,id);
  } else {
   accountId=db.prepare("INSERT INTO admin_accounts(username,password_hash,role,cohort_id,group_name) VALUES(?,?,?,?,?)")
    .run(username,hash,role,cohortId,groupName).lastInsertRowid;
  }
  replaceOrgGrants(accountId,role==="org"?d.cohortIds:[]);
 });
 return json(res,200,{ok:true})}
const accountMatch=url.pathname.match(/^\/api\/admin\/accounts\/(\d+)$/);
if(req.method==="DELETE"&&accountMatch){const session=requireSuper(req,res);if(!session)return;const id=Number(accountMatch[1]),target=db.prepare("SELECT username,role FROM admin_accounts WHERE id=?").get(id);if(!target)return json(res,404,{error:"账号不存在"});if(target.username===session.user.username||target.role==="super")return json(res,403,{error:"当前账号及两个最高权限账号不能删除"});db.prepare("DELETE FROM admin_accounts WHERE id=?").run(id);return json(res,200,{ok:true})}
return json(res,404,{error:"接口不存在"})}catch(error){
 if(error instanceof InputError) return json(res,error.status,{error:error.message});
 if(error instanceof SyntaxError) return json(res,400,{error:"请求数据格式不正确"});
 console.error(error);
 return json(res,500,{error:"服务器处理失败，请稍后重试"});
}}

const publicDir=join(ROOT,"public");
const vendorFile=join(ROOT,"node_modules","xlsx","dist","xlsx.full.min.js");
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,"http://localhost");
 res.setHeader("X-Content-Type-Options","nosniff");
 res.setHeader("X-Frame-Options","DENY");
 res.setHeader("Referrer-Policy","same-origin");
 if(url.pathname.startsWith("/api/")) return api(req,res,url);
 const vendor=url.pathname==="/vendor/xlsx.js";
 const file=vendor?vendorFile:resolve(publicDir,url.pathname==="/"?"index.html":"."+url.pathname);
 if(!vendor && !file.startsWith(publicDir+sep)) {
  res.writeHead(404);
  return res.end("Not found");
 }
 let content;
 try {
  if(!statSync(file).isFile()) {
   res.writeHead(404);
   return res.end("Not found");
  }
  content=readFileSync(file);
 } catch(error) {
  const missing=["ENOENT","ENOTDIR"].includes(error.code);
  res.writeHead(missing?404:500);
  return res.end(missing?"Not found":"Unable to load the page");
 }
 const extension=extname(file), noCache=[".html",".js",".css"].includes(extension);
 res.writeHead(200,{"Content-Type":mime[extension]||"application/octet-stream","Cache-Control":noCache?"no-cache, no-store, must-revalidate":"public, max-age=3600"});
 if(extension===".html") content=Buffer.from(content.toString("utf8").replace('/styles.css','/styles.css?v=school').replace('/app.js','/app.js?v=school'),"utf8");
 res.end(content);
});
const port=Number(process.env.PORT||8787);
server.listen(port,process.env.HOST||"0.0.0.0",()=>console.log(`网站已启动：http://localhost:${server.address().port}`));
