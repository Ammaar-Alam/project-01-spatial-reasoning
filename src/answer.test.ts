import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnswer } from "./answer.ts";

const solved = '{"status": "solved", "blocks": [{"x": 0, "y": 1, "z": 2}]}';

const failureCode = (raw: string) => {
  const result = parseAnswer(raw);
  assert.equal(result.ok, false);
  return result.ok ? undefined : result.failure.code;
};

test("accepts a bare JSON answer", () => {
  assert.deepEqual(parseAnswer(`\n${solved}\n`), {
    ok: true,
    answer: { status: "solved", blocks: [{ x: 0, y: 1, z: 2 }] },
  });
});

test("accepts one fenced JSON answer", () => {
  assert.equal(parseAnswer(`\`\`\`json\n${solved}\n\`\`\``).ok, true);
  assert.equal(parseAnswer(`\`\`\`\n${solved}\n\`\`\``).ok, true);
});

test("accepts an impossible answer with a reason", () => {
  assert.equal(parseAnswer('{"status": "impossible", "reason": "needs 5 edits"}').ok, true);
});

test("rejects text around the JSON", () => {
  assert.equal(failureCode(`Here is my answer: ${solved}`), "invalid_json");
  assert.equal(failureCode(`\`\`\`json\n${solved}\n\`\`\`\nDone.`), "invalid_json");
});

test("rejects more than one JSON value", () => {
  assert.equal(failureCode(`${solved}\n${solved}`), "invalid_json");
  assert.equal(
    failureCode(`\`\`\`json\n${solved}\n\`\`\`\n\`\`\`json\n${solved}\n\`\`\``),
    "invalid_json",
  );
});

test("rejects fields outside the schema", () => {
  assert.equal(
    failureCode('{"status": "solved", "blocks": [{"x": 0, "y": 0, "z": 0, "type": "stone"}]}'),
    "invalid_answer",
  );
  assert.equal(
    failureCode('{"status": "solved", "blocks": [], "notes": "easy"}'),
    "invalid_answer",
  );
});

test("rejects non-integer coordinates", () => {
  assert.equal(
    failureCode('{"status": "solved", "blocks": [{"x": 0.5, "y": 0, "z": 0}]}'),
    "invalid_answer",
  );
  assert.equal(
    failureCode('{"status": "solved", "blocks": [{"x": "1", "y": 0, "z": 0}]}'),
    "invalid_answer",
  );
});

test("rejects unknown statuses and missing reasons", () => {
  assert.equal(failureCode('{"status": "partial", "blocks": []}'), "invalid_answer");
  assert.equal(failureCode('{"status": "impossible"}'), "invalid_answer");
  assert.equal(failureCode('{"status": "impossible", "reason": "  "}'), "invalid_answer");
});
