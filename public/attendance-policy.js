export const legacyAttendancePolicy={mode:"legacy"};

export const attendanceStatuses=["attended","makeup",""];

export function normalizeAttendancePolicy(value) {
  if (value?.mode==="legacy" || value?.mode==="readonly") return {mode:value.mode};
  if (value?.mode!=="custom" || !["required","all"].includes(value.scope) ||
      !Array.isArray(value.statuses) || !value.statuses.length ||
      value.statuses.some(status=>!attendanceStatuses.includes(status))) return undefined;
  return {
    mode:"custom",
    scope:value.scope,
    statuses:attendanceStatuses.filter(status=>value.statuses.includes(status))
  };
}

export function attendanceOptions(policy, category, current, withdrawn) {
  if (policy?.mode==="manager") return [...attendanceStatuses,"special"];
  if (withdrawn || current==="special") return [];
  if (policy?.mode==="legacy") return category==="required" && current===""?["makeup"]:[];
  if (policy?.mode==="custom" && (category==="required" || policy.scope==="all")) return policy.statuses;
  return [];
}
