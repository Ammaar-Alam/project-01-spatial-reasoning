import path from "node:path";
import { grade } from "./grade.ts";
import { findTaskFiles, loadTask, TaskError } from "./task.ts";

const TASKS_DIR = path.resolve(import.meta.dirname, "../tasks");

// every task must load and its own reference answer must pass the grader
export async function checkTasks(root: string): Promise<{ checked: number; problems: string[] }> {
  const files = await findTaskFiles(root);
  const problems: string[] = [];

  for (const file of files) {
    try {
      const task = await loadTask(root, file);
      const { failures } = grade(task, JSON.stringify(task.reference));
      if (failures.length > 0) {
        const reasons = failures.map((failure) => `  ${failure.code}: ${failure.message}`);
        problems.push(`${task.id}: reference answer fails\n${reasons.join("\n")}`);
      }
    } catch (error) {
      if (!(error instanceof TaskError)) throw error;
      problems.push(error.message);
    }
  }

  return { checked: files.length, problems };
}

if (import.meta.main) {
  const { checked, problems } = await checkTasks(TASKS_DIR);
  for (const problem of problems) console.error(`${problem}\n`);
  console.log(
    `${checked} ${checked === 1 ? "task" : "tasks"} checked, ${problems.length} with problems`,
  );
  process.exitCode = problems.length > 0 ? 1 : 0;
}
