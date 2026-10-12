import { type Answer, type ParseFailure, parseAnswer } from "./answer.ts";
import {
  type Block,
  blockKey,
  describeBlocks,
  difference,
  duplicates,
  inBounds,
} from "./geometry.ts";
import type { Task } from "./task.ts";

export type FailureCode =
  | ParseFailure["code"]
  | "out_of_bounds"
  | "duplicate_block"
  // said impossible on a task that has a solution
  | "claimed_impossible"
  // built something on a task that has no solution
  | "missed_impossible"
  | "too_many_edits"
  | "wrong_edit_count"
  | "too_many_blocks"
  | "wrong_block_count"
  | "protected_changed"
  | "forbidden_edit"
  | "wrong_structure"
  // the provider marked the reply as a refusal, set by the runner before grading the text
  | "refused";

export type Failure = { code: FailureCode; message: string };

export type Grade = { pass: boolean; failures: Failure[] };

export type GradedTask = Pick<
  Task,
  "size" | "initial" | "constraints" | "reference" | "alternatives"
>;

export function grade(task: GradedTask, raw: string): Grade {
  const parsed = parseAnswer(raw);
  const failures = parsed.ok ? check(task, parsed.answer) : [parsed.failure];
  return { pass: failures.length === 0, failures };
}

function check(task: GradedTask, answer: Answer): Failure[] {
  const { reference } = task;

  if (answer.status === "impossible") {
    return reference.status === "impossible"
      ? []
      : [{ code: "claimed_impossible", message: "said impossible, but the task has a solution" }];
  }

  const illegal = legality(task, answer.blocks);
  if (illegal.length > 0) return illegal;

  if (reference.status === "impossible") {
    return [
      { code: "missed_impossible", message: "built a structure, but the task has no solution" },
    ];
  }

  const accepted: [Block[], ...Block[][]] = [reference.blocks, ...task.alternatives];
  return [...constraints(task, answer.blocks), ...structure(accepted, answer.blocks)];
}

function legality(task: GradedTask, blocks: Block[]): Failure[] {
  const failures: Failure[] = [];
  const outside = blocks.filter((block) => !inBounds(block, task.size));
  if (outside.length > 0) {
    const { x, y, z } = task.size;
    failures.push({
      code: "out_of_bounds",
      message: `${count(outside.length)} outside the ${x}x${y}x${z} grid: ${describeBlocks(outside)}`,
    });
  }
  const repeated = duplicates(blocks);
  if (repeated.length > 0) {
    failures.push({
      code: "duplicate_block",
      message: `listed twice: ${describeBlocks(repeated)}`,
    });
  }
  return failures;
}

// edits are measured on the final state: added = final - initial, removed = initial - final
function constraints(task: GradedTask, final: Block[]): Failure[] {
  const rules = task.constraints;
  const added = difference(final, task.initial);
  const removed = difference(task.initial, final);
  const edits = added.length + removed.length;
  const failures: Failure[] = [];

  if (rules.maxEdits !== undefined && edits > rules.maxEdits) {
    failures.push({
      code: "too_many_edits",
      message: `${edits} edits, at most ${rules.maxEdits} allowed`,
    });
  }
  if (rules.exactEdits !== undefined && edits !== rules.exactEdits) {
    failures.push({
      code: "wrong_edit_count",
      message: `${edits} edits, exactly ${rules.exactEdits} required`,
    });
  }
  if (rules.maxBlocks !== undefined && final.length > rules.maxBlocks) {
    failures.push({
      code: "too_many_blocks",
      message: `${count(final.length)}, at most ${rules.maxBlocks} allowed`,
    });
  }
  if (rules.exactBlocks !== undefined && final.length !== rules.exactBlocks) {
    failures.push({
      code: "wrong_block_count",
      message: `${count(final.length)}, exactly ${rules.exactBlocks} required`,
    });
  }
  if (rules.only === "add" && removed.length > 0) {
    failures.push({
      code: "forbidden_edit",
      message: `removed ${count(removed.length)}, only additions allowed`,
    });
  }
  if (rules.only === "remove" && added.length > 0) {
    failures.push({
      code: "forbidden_edit",
      message: `added ${count(added.length)}, only removals allowed`,
    });
  }

  const before = new Set(task.initial.map(blockKey));
  const after = new Set(final.map(blockKey));
  const changed = rules.protected.filter(
    (cell) => before.has(blockKey(cell)) !== after.has(blockKey(cell)),
  );
  if (changed.length > 0) {
    failures.push({
      code: "protected_changed",
      message: `changed protected cells: ${describeBlocks(changed)}`,
    });
  }

  return failures;
}

// exact occupancy match with any accepted structure, block order does not matter
// a miss is described against the closest accepted structure
function structure(accepted: [Block[], ...Block[][]], actual: Block[]): Failure[] {
  const diffs = accepted.map((expected) => ({
    missing: difference(expected, actual),
    extra: difference(actual, expected),
  }));
  const size = (diff: { missing: Block[]; extra: Block[] }) =>
    diff.missing.length + diff.extra.length;
  const { missing, extra } = diffs.reduce((best, diff) => (size(diff) < size(best) ? diff : best));
  if (missing.length === 0 && extra.length === 0) return [];

  const parts = [];
  if (missing.length > 0)
    parts.push(`missing ${count(missing.length)}: ${describeBlocks(missing)}`);
  if (extra.length > 0) parts.push(`${count(extra.length)} extra: ${describeBlocks(extra)}`);
  return [{ code: "wrong_structure", message: parts.join("; ") }];
}

const count = (n: number): string => `${n} ${n === 1 ? "block" : "blocks"}`;
