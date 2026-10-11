import { grade } from "./grade.ts";
import { findTaskFiles, loadTask, TASKS_DIR, TaskError } from "./task.ts";

// every task must load, and its reference and alternative answers must pass the grader
export async function checkTasks(root: string): Promise<{ checked: number; problems: string[] }> {
  const files = await findTaskFiles(root);
  const problems: string[] = [];

  for (const file of files) {
    try {
      const task = await loadTask(root, file);
      const answers = [
        { label: "reference answer", answer: task.reference },
        ...task.alternatives.map((blocks, i) => ({
          label: `alternative ${i + 1}`,
          answer: { status: "solved", blocks },
        })),
      ];
      for (const { label, answer } of answers) {
        const { failures } = grade(task, JSON.stringify(answer));
        if (failures.length > 0) {
          const reasons = failures.map((failure) => `  ${failure.code}: ${failure.message}`);
          problems.push(`${task.id}: ${label} fails\n${reasons.join("\n")}`);
        }
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
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  console.log(`${plural(checked, "task")} checked, ${plural(problems.length, "problem")}`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}
