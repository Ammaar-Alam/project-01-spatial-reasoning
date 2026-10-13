import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { type Cell, cellFor } from "./pick.ts";

export type Style = "solid" | "faint" | "missing" | "extra" | "protected";
export type Layer = { blocks: Cell[]; style: Style };
// front looks along -z, side along -x, top straight down with x to the right
export type View = "front" | "side" | "top" | "angled";
export type Mode = "add" | "remove";

const SNAPSHOT = { width: 1024, height: 768 };
const BACKGROUND = 0xf7f8fa;
const INK = 0x1d2733;
const STYLES: Record<Style, { face: [number, number]; edge: [number, number] }> = {
  solid: { face: [0x8aa6c8, 1], edge: [0x23364c, 0.7] },
  faint: { face: [0x8aa6c8, 0.18], edge: [0x23364c, 0.25] },
  missing: { face: [0xd2452b, 0.14], edge: [0xd2452b, 1] },
  extra: { face: [0xe0a126, 1], edge: [0x7a5200, 0.6] },
  protected: { face: [0x2f8f86, 0.2], edge: [0x2f8f86, 0.9] },
};

const BOX = new THREE.BoxGeometry(1, 1, 1);
const BOX_EDGES = new THREE.EdgesGeometry(BOX).getAttribute("position").array;

// every block's outline in one draw call, offset from the unit cube centred on the origin
function outlines(blocks: Cell[], color: number, opacity: number): THREE.LineSegments {
  const positions = new Float32Array(blocks.length * BOX_EDGES.length);
  blocks.forEach((block, i) => {
    for (let j = 0; j < BOX_EDGES.length; j += 3) {
      const at = i * BOX_EDGES.length + j;
      positions[at] = (BOX_EDGES[j] ?? 0) + block.x + 0.5;
      positions[at + 1] = (BOX_EDGES[j + 1] ?? 0) + block.y + 0.5;
      positions[at + 2] = (BOX_EDGES[j + 2] ?? 0) + block.z + 0.5;
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  return new THREE.LineSegments(geometry, material);
}

function faces(blocks: Cell[], color: number, opacity: number): THREE.InstancedMesh {
  const material = new THREE.MeshLambertMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity === 1,
    // pushed back a hair so the outlines on the same edges always draw on top
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const mesh = new THREE.InstancedMesh(BOX, material, blocks.length);
  const matrix = new THREE.Matrix4();
  blocks.forEach((block, i) => {
    mesh.setMatrixAt(i, matrix.makeTranslation(block.x + 0.5, block.y + 0.5, block.z + 0.5));
  });
  return mesh;
}

function dispose(group: THREE.Group) {
  for (const child of group.children) {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      if (child.geometry !== BOX) child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  }
  group.clear();
}

// light rig and orbit feel adapted from MineBench (MIT), components/voxel/VoxelViewer.tsx
// with less ambient light so flat colored faces still read as separate sides
function addLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x1a2330, 0.55));
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const lights: [number, number, [number, number, number]][] = [
    [0xffffff, 1, [3, 10, 6]],
    [0xcfe3ff, 0.5, [-8, 6, -6]],
    [0xffffff, 0.22, [-10, 7, 10]],
  ];
  for (const [color, intensity, [x, y, z]] of lights) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(x, y, z);
    scene.add(light);
  }
}

// floor lines on every cell boundary and a faint box around the whole grid
function addGridLines(group: THREE.Group, size: Cell) {
  const points: number[] = [];
  for (let x = 0; x <= size.x; x++) points.push(x, 0, 0, x, 0, size.z);
  for (let z = 0; z <= size.z; z++) points.push(0, 0, z, size.x, 0, z);
  const floor = new THREE.BufferGeometry();
  floor.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  group.add(new THREE.LineSegments(floor, new THREE.LineBasicMaterial({ color: 0xc3ccd6 })));
  const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(size.x, size.y, size.z));
  const bounds = new THREE.Box3Helper(box, 0xa7b3c0);
  bounds.name = "bounds";
  group.add(bounds);
}

// the grid's centre and the camera that frames all of it for a view
function viewCamera(size: Cell, view: View, aspect: number): THREE.Camera {
  const centre = new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2);
  const radius = centre.length();
  const distance = radius * 4;
  if (view === "angled") {
    const camera = new THREE.PerspectiveCamera(40, aspect, 0.1, distance * 4);
    const fit = (radius * 1.15) / Math.sin(THREE.MathUtils.degToRad(Math.min(40, 40 * aspect) / 2));
    camera.position
      .copy(centre)
      .add(new THREE.Vector3(1, 0.8, 1.25).normalize().multiplyScalar(fit));
    camera.lookAt(centre);
    return camera;
  }
  const [width, height, direction, up] = {
    front: [size.x, size.y, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
    side: [size.z, size.y, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
    top: [size.x, size.z, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)],
  }[view] as [number, number, THREE.Vector3, THREE.Vector3];
  const half = Math.max(width / aspect, height) * 0.58;
  const camera = new THREE.OrthographicCamera(
    -half * aspect,
    half * aspect,
    half,
    -half,
    0.1,
    distance * 2,
  );
  camera.position.copy(centre).addScaledVector(direction, distance);
  camera.up.copy(up);
  camera.lookAt(centre);
  return camera;
}

export function createScene(canvas: HTMLCanvasElement, onHover: (cell: Cell | null) => void) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(BACKGROUND);

  const scene = new THREE.Scene();
  addLights(scene);
  const grid = new THREE.Group();
  const blocks = new THREE.Group();
  const cursor = outlines([{ x: 0, y: 0, z: 0 }], INK, 1);
  cursor.visible = false;
  scene.add(grid, blocks, cursor);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.8;
  controls.panSpeed = 0.7;
  controls.screenSpacePanning = true;
  controls.minPolarAngle = 0.02;
  controls.maxPolarAngle = Math.PI - 0.02;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };

  let size: Cell = { x: 1, y: 1, z: 1 };
  let shown: Layer[] = [];
  let editable = false;
  let onEdit: (cell: Cell, mode: Mode) => void = () => {};

  function frame() {
    const framed = viewCamera(size, "angled", camera.aspect);
    camera.position.copy(framed.position);
    camera.far = framed instanceof THREE.PerspectiveCamera ? framed.far : 1000;
    camera.updateProjectionMatrix();
    controls.target.set(size.x / 2, size.y / 2, size.z / 2);
    controls.update();
  }

  function setGrid(next: Cell) {
    const resized = next.x !== size.x || next.y !== size.y || next.z !== size.z;
    size = { ...next };
    dispose(grid);
    addGridLines(grid, size);
    if (resized) frame();
  }

  function show(layers: Layer[]) {
    shown = layers;
    dispose(blocks);
    for (const { blocks: cells, style } of layers) {
      if (cells.length === 0) continue;
      const { face, edge } = STYLES[style];
      blocks.add(faces(cells, ...face), outlines(cells, ...edge));
    }
  }

  const inside = (cell: Cell) =>
    cell.x >= 0 &&
    cell.y >= 0 &&
    cell.z >= 0 &&
    cell.x < size.x &&
    cell.y < size.y &&
    cell.z < size.z;

  // the cell a pointer is over: next to a block face, inside a block, or on the floor
  const raycaster = new THREE.Raycaster();
  function target(event: PointerEvent | MouseEvent, mode: Mode): Cell | null {
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const meshes = blocks.children.filter((child) => child instanceof THREE.InstancedMesh);
    const [hit] = raycaster.intersectObjects(meshes, false);
    if (hit?.face) {
      const cell = cellFor(hit.point, hit.face.normal, mode);
      return inside(cell) ? cell : null;
    }
    if (mode === "remove") return null;
    const floor = raycaster.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      new THREE.Vector3(),
    );
    if (!floor) return null;
    const cell = { x: Math.floor(floor.x), y: 0, z: Math.floor(floor.z) };
    return inside(cell) ? cell : null;
  }

  const modeOf = (event: { shiftKey: boolean }): Mode => (event.shiftKey ? "remove" : "add");
  function hover(event: PointerEvent | MouseEvent) {
    const cell = editable ? target(event, modeOf(event)) : null;
    cursor.visible = cell !== null;
    onHover(cell);
    if (!cell) return;
    cursor.position.set(cell.x, cell.y, cell.z);
    (cursor.material as THREE.LineBasicMaterial).color.set(event.shiftKey ? 0xd2452b : INK);
  }

  // a click edits, a drag orbits
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (event) => {
    down = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener("pointerup", (event) => {
    const moved = down ? Math.hypot(event.clientX - down.x, event.clientY - down.y) : Infinity;
    down = null;
    if (!editable || event.button !== 0 || moved > 4) return;
    const cell = target(event, modeOf(event));
    if (cell) onEdit(cell, modeOf(event));
    hover(event);
  });
  canvas.addEventListener("pointermove", hover);
  canvas.addEventListener("pointerleave", () => {
    cursor.visible = false;
    onHover(null);
  });
  canvas.addEventListener("dblclick", frame);

  new ResizeObserver(() => {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }).observe(canvas);

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  let snapshotRenderer: THREE.WebGLRenderer | null = null;

  // the given blocks alone from a fixed view of the whole grid, so equal grids frame the same
  async function snapshot(view: View, layers: Layer[]): Promise<Blob> {
    snapshotRenderer ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    snapshotRenderer.setPixelRatio(1);
    snapshotRenderer.setSize(SNAPSHOT.width, SNAPSHOT.height, false);
    snapshotRenderer.setClearColor(BACKGROUND);
    const previous = shown;
    const bounds = grid.getObjectByName("bounds");
    show(layers);
    cursor.visible = false;
    if (bounds) bounds.visible = false;
    try {
      snapshotRenderer.render(scene, viewCamera(size, view, SNAPSHOT.width / SNAPSHOT.height));
    } finally {
      show(previous);
      if (bounds) bounds.visible = true;
    }
    return new Promise((resolve, reject) => {
      snapshotRenderer?.domElement.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("snapshot failed"))),
        "image/png",
      );
    });
  }

  return {
    setGrid,
    show,
    frame,
    snapshot,
    // orbits the view around the grid's vertical axis, for recording a turntable
    turn(radians: number) {
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), radians);
      camera.position.copy(controls.target).add(offset);
      controls.update();
    },
    // turns block editing on or off, clicks then go to the handler
    edit(handler: ((cell: Cell, mode: Mode) => void) | null) {
      editable = handler !== null;
      onEdit = handler ?? (() => {});
      cursor.visible = false;
    },
  };
}

export type Scene = ReturnType<typeof createScene>;
