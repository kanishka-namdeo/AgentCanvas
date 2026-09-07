
const { createEmptyCanvasDocument } = await import("../../../src/lib/canvas/types");
const { applyPatchToCanvas } = await import("../../../src/lib/canvas/patch");
const log = JSON.parse(require("fs").readFileSync("scripts/research/oneshot-opt/capture-log.json", "utf-8"));
let doc: any = createEmptyCanvasDocument("eval-capture", "Capture");
let lastTool = "(initial)";
let prevLayout: string | undefined;
for (const entry of log) {
  if (entry.kind === "tool_start") lastTool = entry.name;
  if (entry.kind === "patch") {
    try { doc = applyPatchToCanvas(doc, entry.patch); } catch {}
    const root = (doc.children ?? [])[0];
    const layout = root?.layout;
    if (layout !== prevLayout) {
      console.log(`seq ${String(entry.seq).padStart(3)} ${lastTool.padEnd(26)} patch-op=${entry.patch.op.padEnd(12)} layout=${JSON.stringify(layout)}`);
      if (entry.patch.op === "update") {
        console.log("   update shape:", JSON.stringify(entry.patch.shape).slice(0, 200));
      } else if (entry.patch.op === "update_many") {
        console.log("   update_many count:", entry.patch.updates?.length, "first changes:", JSON.stringify(entry.patch.updates?.[0]?.changes).slice(0, 200));
      }
      prevLayout = layout;
    }
  }
}
