import type { Cell } from "./pick.ts";

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the page has no #${id}`);
  return found as T;
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const created = Object.assign(document.createElement(tag), props);
  created.append(...children);
  return created;
}

// the server answers a failure with plain text that is meant to be shown as is
export async function request(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await response.text());
  return response;
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const cellKey = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;
