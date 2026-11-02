import type { SurfacePort } from "../../packages/virtual-screen/src/index.js";

/** Independent per-surface grade (never computed by the runtime under test). */
export type Score = {
  surface_id: string;
  /** Every graded item correct. */
  success: boolean;
  /** Something was committed, and it is wrong. */
  wrong: boolean;
  commits: number;
  correct_items?: number;
  detail?: unknown;
};

/** One block's environment: surfaces, the task as every arm sees it, and grading. */
export type Lab = {
  surfaces: string[];
  port: SurfacePort;
  /** Task text, identical for every arm of the block. */
  task: string;
  /** Host task table for the fleet runtime (surface -> column -> value). */
  inputs?: Record<string, Record<string, string>>;
  grade(): Promise<Score[]> | Score[];
  /** Copies per-surface artifacts (saved files, input journals) before close. */
  collect?(dir: string): Promise<void>;
  close(): Promise<void>;
};

export type Workload = {
  /** Durable items per surface (each verified, or declared, separately). */
  items: number;
  /** The model declares items done; correctness is graded afterwards. */
  declared: boolean;
  /** How long the fleet runtime waits for a post-condition (slow apps). */
  settle_ms?: number;
  /** Task description for the frozen plan (block tables are added per block). */
  summary: string;
  open(directory: string, count: number, seed: number): Promise<Lab>;
};
