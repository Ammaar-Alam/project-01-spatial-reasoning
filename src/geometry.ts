import { z } from "zod";

// one occupied grid cell, y is up
export const blockSchema = z.strictObject({ x: z.int(), y: z.int(), z: z.int() });

export type Block = z.infer<typeof blockSchema>;

// grid dimensions, valid coordinates run from 0 to size - 1 on each axis
export type Size = { x: number; y: number; z: number };

export const blockKey = (block: Block): string => `${block.x},${block.y},${block.z}`;

export const inBounds = (block: Block, size: Size): boolean =>
  block.x >= 0 &&
  block.x < size.x &&
  block.y >= 0 &&
  block.y < size.y &&
  block.z >= 0 &&
  block.z < size.z;

// blocks listed more than once, each reported once
export function duplicates(blocks: Block[]): Block[] {
  const seen = new Set<string>();
  const reported = new Set<string>();
  const result: Block[] = [];
  for (const block of blocks) {
    const key = blockKey(block);
    if (seen.has(key) && !reported.has(key)) {
      reported.add(key);
      result.push(block);
    }
    seen.add(key);
  }
  return result;
}

// blocks in a that are not in b
export function difference(a: Block[], b: Block[]): Block[] {
  const keys = new Set(b.map(blockKey));
  return a.filter((block) => !keys.has(blockKey(block)));
}

// "(1, 0, 2), (3, 0, 1) and 4 more" for readable failure messages
export function describeBlocks(blocks: Block[], limit = 5): string {
  const shown = blocks.slice(0, limit).map((block) => `(${block.x}, ${block.y}, ${block.z})`);
  const rest = blocks.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}
