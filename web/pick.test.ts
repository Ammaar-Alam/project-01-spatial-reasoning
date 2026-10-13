import assert from "node:assert/strict";
import { test } from "node:test";
import { cellFor } from "./pick.ts";

// block (x, y, z) fills the cube from (x, y, z) to (x + 1, y + 1, z + 1)
test("adds in front of the face that was clicked and removes the block behind it", () => {
  const top = { point: { x: 2.5, y: 1, z: 3.3 }, normal: { x: 0, y: 1, z: 0 } };
  assert.deepEqual(cellFor(top.point, top.normal, "add"), { x: 2, y: 1, z: 3 });
  assert.deepEqual(cellFor(top.point, top.normal, "remove"), { x: 2, y: 0, z: 3 });

  const side = { point: { x: 2, y: 0.5, z: 3.5 }, normal: { x: -1, y: 0, z: 0 } };
  assert.deepEqual(cellFor(side.point, side.normal, "add"), { x: 1, y: 0, z: 3 });
  assert.deepEqual(cellFor(side.point, side.normal, "remove"), { x: 2, y: 0, z: 3 });
});

test("places on the floor and tolerates hits a hair off the face", () => {
  const floor = { x: 1.2, y: 0, z: 4.9 };
  assert.deepEqual(cellFor(floor, { x: 0, y: 1, z: 0 }, "add"), { x: 1, y: 0, z: 4 });
  const near = { x: 3.0000001, y: 0.99999, z: 0.2 };
  assert.deepEqual(cellFor(near, { x: 1, y: 0, z: 0 }, "add"), { x: 3, y: 0, z: 0 });
  assert.deepEqual(cellFor(near, { x: 1, y: 0, z: 0 }, "remove"), { x: 2, y: 0, z: 0 });
});
