export const title = "Synthesis final merge vs cancel";

export const colors = {
  live: "teal",
  merging: "blue",
  settled: "tan",
  broken: "orange",
};

export function state(v) {
  const owners = v.mergeOwner === "none" ? "no lease" : `lease ${v.mergeOwner}`;
  const result = v.hasResult ? "result saved" : "no result";
  const bill =
    Array.isArray(v.billed) && v.billed.length > 0
      ? `billed:${v.billed.join(",")}`
      : "not billed";
  return `${v.status} · ${owners} · ${result} · ${bill}`;
}

export function group(v) {
  if (v.status === "canceled" && v.hasResult) return "broken";
  if (v.status === "canceled") return "settled";
  if (v.status === "complete") return "settled";
  if (Array.isArray(v.billed) && v.billed.length > 0) return "merging";
  return "live";
}

export function step(action) {
  switch (action) {
    case "UserCancel":
      return "user cancels the job";
    case "GateCheck":
      return "merge gate sees a live job";
    case "ClaimMerge":
      return "worker claims the merge lease";
    case "BillableMerge":
      return "worker starts the billable Sonnet merge";
    case "SaveRead":
      return "saveJobResult re-reads the job";
    case "SaveInsert":
      return "saveJobResult inserts job_results";
    case "SaveAdvance":
      return "saveJobResult advances job status";
    case "Done":
      return null;
    case "JobSettled":
      return null;
    default:
      return action;
  }
}
