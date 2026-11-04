import { openBrowserLab } from "../virtual-screen/browser.js";
import type { Workload } from "./types.js";

/** The synthetic business form: three consecutive items per surface. */
export function sequence(variant = "uniform"): Workload {
  const summary =
    "Each surface has THREE consecutive items. Read its CURRENT Copy code and Priority. Enter the exact code, choose Urgent for HIGH otherwise Standard, then Save item exactly once. Save advances to the next item and clears controls. Never infer unseen values. No DOM, shell, external network, task data files or grader access. Unknown or delivered inputs must not be repeated." +
    (variant === "mixed"
      ? " A surface may show a blocking notice; dismiss it first. Dismissing is not an item (per-surface tools: a desktop_act target with dismiss:true and no expectation; fleet tools: a prepare policy)."
      : "");
  return {
    items: 3,
    declared: false,
    summary,
    async open(directory, count, seed) {
      const lab = await openBrowserLab(directory, count, seed, {
        sequence: true,
        ...(variant !== "uniform" ? { mix: variant } : {}),
      });
      return { ...lab, task: summary };
    },
  };
}

/** One MiniWoB++ episode per surface. */
export function miniwob(task: string): Workload {
  const summary =
    "Each surface shows one small web task (a MiniWoB++ episode) with its instruction at the top. Complete each surface's instruction exactly as written. When an episode ends a START cover appears: never click START. Declare a surface done only after you have completed its instruction. No DOM, shell, external network, task data files or grader access. Unknown or delivered inputs must not be repeated.";
  return {
    items: 1,
    declared: true,
    summary,
    async open(directory, count, seed) {
      const lab = await openBrowserLab(directory, count, seed, {
        miniwob: task,
      });
      return { ...lab, task: summary };
    },
  };
}
