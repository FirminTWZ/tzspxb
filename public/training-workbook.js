const studentHeaders=["组别","序号","小组联络员","姓名","政治面貌","院系","所属团支部","手机","电子邮箱"];
export const withdrawalHeaders=["是否退出","退出备注"];
const courseSettings="课程设置";
const completionSettings="结业设置";
const historicalNames=["1031破冰","1115开班仪式＋第一次实务技能培训","第二次实务技能培训","0517第三次实务技能培训"];
const legacyCredits=[4,5,2,3];
const tailHeader=/^(?:是否退出|退出备注|总学分|合计学分|总分|学分合计|备注|是否结业|结业情况|必修学分|学分统计|合计)$/;
const withdrawalPattern=/[（(]((?:休学|退出|退班)(?::|：)?[^）)]*)[）)]$/;
const text=value=>String(value??"").trim();

export { studentHeaders };

export function readTrainingWorkbook(book, spreadsheet) {
  const getRows=name=>spreadsheet.utils.sheet_to_json(book.Sheets[name],{header:1,defval:null,raw:true});
  const names=book.SheetNames.filter(name=>/本科|硕博/.test(name));
  if (!names.length) throw new Error("未找到本科组或硕博组工作表");
  const settingsRows=book.Sheets[courseSettings]?getRows(courseSettings).slice(1).filter(row=>row.some(value=>text(value))):null;
  const sources=names.map(name=>{
    const [headers=[],...rows]=getRows(name);
    let end=studentHeaders.length;
    if (settingsRows) end+=settingsRows.length;
    else while (text(headers[end]) && !tailHeader.test(text(headers[end]))) end++;
    return {name,headers,rows,end,courseNames:headers.slice(studentHeaders.length,end).map(text)};
  });
  const primary=sources.reduce((largest,sheet)=>sheet.courseNames.length>largest.courseNames.length?sheet:largest);
  const legacyPivot=primary.courseNames.findIndex(name=>/0331.*耶鲁北大行/.test(name.replace(/\s/g,"")));
  const legacyRequiredEnd=primary.courseNames.findIndex(name=>/0517.*第三次实务技能培训/.test(name.replace(/\s/g,"")));
  const oldWithdrawals=new Map();
  if (book.Sheets["学员汇总"]) {
    for (const [name,department,type,, , , ,withdrawn,note] of getRows("学员汇总").slice(1)) {
      if(text(withdrawn)!=="是") continue;
      oldWithdrawals.set(JSON.stringify([text(type),text(department),text(name)+"（"+(text(note)||"退出")+"）"]),
        {name:text(name),note:text(note)});
    }
  }
  if (settingsRows && settingsRows.length!==primary.courseNames.length) {
    throw new Error("“课程设置”的行数与学员工作表中的课程列数不一致");
  }
  const courses=primary.courseNames.map((header,index)=>{
    const courseKey="course_"+String(index+1).padStart(2,"0");
    if (!settingsRows) {
      const credits=legacyCredits[index]??(index<=(legacyPivot<0?13:legacyPivot)?2:3);
      return {courseKey,name:historicalNames[index]||header.replace(/（[^）]*学分[^）]*）/g,"").trim(),
        category:index<=(legacyRequiredEnd<0?3:legacyRequiredEnd)?"required":"elective",credits,sortOrder:index+1,sourceHeader:header};
    }
    const [name,type,credit,order,key]=settingsRows[index];
    const category={必修:"required",选修:"elective",必修课程:"required",选修课程:"elective"}[text(type)];
    if (text(name)!==header || !category || text(credit)==="" || !Number.isFinite(Number(credit)) ||
        Number(credit)<0 || Number(credit)>1000 || (text(order)!=="" && (!Number.isSafeInteger(Number(order)) || Number(order)<0))) {
      throw new Error("请核对“课程设置”第 "+(index+2)+" 行的名称、类型、学分和排序，名称和顺序须与学员表课程列一致");
    }
    return {courseKey,storageKey:text(key)||null,name:header,category,credits:Number(credit),
      sortOrder:text(order)?Number(order):index+1,sourceHeader:header};
  });
  const students=[], attendance=[];
  for (const sheet of sources) {
    if (sheet.courseNames.some((name,index)=>name!==primary.courseNames[index]) ||
        (settingsRows && sheet.courseNames.length!==courses.length)) {
      throw new Error("“"+sheet.name+"”中的课程列与其他学员工作表不一致，请核对名称和顺序");
    }
    const studentType=/本科/.test(sheet.name)?"undergraduate":"graduate";
    const withdrawnColumn=sheet.headers.findIndex((header,index)=>index>=sheet.end && text(header)===withdrawalHeaders[0]);
    const noteColumn=sheet.headers.findIndex((header,index)=>index>=sheet.end && text(header)===withdrawalHeaders[1]);
    let group="",contact="";
    for (let index=0;index<sheet.rows.length;index++) {
      const row=sheet.rows[index];
      if (row[0]!=null) { group=text(row[0]); contact=""; }
      if (row[2]!=null) contact=text(row[2]);
      let name=text(row[3]);
      if (!name) continue;
      const department=text(row[5]);
      if (!department) throw new Error("“"+sheet.name+"”第 "+(index+2)+" 行缺少院系");
      const tail=row.slice(sheet.end);
      const match=name.match(withdrawalPattern);
      const previous=withdrawnColumn<0?oldWithdrawals.get(JSON.stringify([studentType==="undergraduate"?"本科生":"硕博生",department,name])):null;
      if (previous) name=previous.name;
      else if (match && withdrawnColumn<0) name=name.slice(0,match.index).trim();
      const withdrawn=withdrawnColumn>=0?/^(?:是|1|true|退出|休学|退班)$/i.test(text(row[withdrawnColumn]))
        :!!previous||!!match||tail.some(value=>/休学|退出|退班/.test(text(value)));
      const withdrawalNote=noteColumn>=0?text(row[noteColumn]):previous?.note??(match?.[1]||tail.map(text).find(value=>/休学|退出|退班/.test(value))||"");
      const importKey=sheet.name+":"+(index+2);
      const sourceTotal=settingsRows?null:tail.findLast(value=>typeof value==="number"&&Number.isFinite(value))??null;
      students.push({importKey,name,department,studentType,groupName:group,groupContact:contact,
        politicalStatus:text(row[4]),leagueBranch:text(row[6]),phone:text(row[7]),email:text(row[8]),withdrawn,withdrawalNote,sourceTotal});
      for(let courseIndex=0;courseIndex<sheet.courseNames.length;courseIndex++) {
        const raw=row[studentHeaders.length+courseIndex], mark=text(raw);
        if (!mark || mark==="0" || mark==="未参加") continue;
        const numeric=Number(raw);
        const status=Math.abs(numeric-1)<.01||mark==="现场出勤"?"attended":
          Math.abs(numeric-2)<.01||mark==="完成补修"?"makeup":
          /^2\s*2\s*\/\s*3$/.test(mark)||Math.abs(numeric-8/3)<.01||mark==="特殊课程"?"special":null;
        if (!status) throw new Error("“"+sheet.name+"”第 "+(index+2)+" 行「"+courses[courseIndex].name+"」出勤标记无效");
        attendance.push({studentKey:importKey,courseKey:courses[courseIndex].courseKey,status,sourceMark:mark});
      }
    }
  }
  let thresholds;
  if (book.Sheets[completionSettings]) {
    const [,row]=getRows(completionSettings);
    const values=[0,1,2].map(index=>text(row?.[index])?Number(row[index]):NaN);
    if (values.some(value=>!Number.isFinite(value)||value<0||value>10000)) throw new Error("“结业设置”中的结业门槛无效");
    thresholds={undergraduate:values[0],graduate:values[1],required:values[2]};
  }
  return {students,courses,attendance,thresholds};
}
