import XLSX from "xlsx";
import { readTrainingWorkbook } from "../public/training-workbook.js";

const source=process.argv[2];
if(!source) throw new Error("缺少 Excel 文件路径");
const payload=readTrainingWorkbook(XLSX.readFile(source,{cellFormula:true}),XLSX);
const username=process.env.IMPORT_ADMIN_USERNAME,password=process.env.IMPORT_ADMIN_PASSWORD;if(!username||!password)throw new Error("请设置 IMPORT_ADMIN_USERNAME 和 IMPORT_ADMIN_PASSWORD");
const meta=await(await fetch("http://localhost:8787/api/meta")).json(),cohortId=meta.cohorts[0]?.id;if(!cohortId)throw new Error("没有可用的培训班");
const login=await fetch("http://localhost:8787/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password,cohortId})});if(!login.ok)throw new Error("管理员登录失败");const cookie=login.headers.getSetCookie?.()[0]?.split(";")[0]||login.headers.get("set-cookie").split(";")[0];
const res=await fetch("http://localhost:8787/api/admin/import-full",{method:"POST",headers:{"Content-Type":"application/json","Cookie":cookie},body:JSON.stringify(payload)});const result=await res.json();if(!res.ok)throw new Error(result.error||"导入失败");console.log(JSON.stringify({...result,withdrawn:payload.students.filter(s=>s.withdrawn).length,special:payload.attendance.filter(a=>a.status==="special").length}));
