export type Cell = { x: number; y: number; z: number };

// the empty cell in front of the face that was hit, or the block behind it
// half a cell along the normal lands inside the right cube even if the hit is slightly off the face
export function cellFor(point: Cell, normal: Cell, mode: "add" | "remove"): Cell {
  const step = mode === "add" ? 0.5 : -0.5;
  return {
    x: Math.floor(point.x + normal.x * step),
    y: Math.floor(point.y + normal.y * step),
    z: Math.floor(point.z + normal.z * step),
  };
}
