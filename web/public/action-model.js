import { blankBinding } from "./schema.js";

export const LAYER_KINDS = [3, 4, 9, 14, 15, 16, 17];
export function behaviorOf(b) {
  if (b.kind === 0) return "inherit";
  if (b.kind === 1) return "none";
  if (b.kind === 9) return "toggle";
  if (LAYER_KINDS.includes(b.kind)) return "layer";
  if ([2, 11, 12, 13, 18].includes(b.kind)) return "hold";
  return "press";
}
export function actionOf(b) {
  const kind =
    { 10: 2, 11: 5, 12: 6, 13: 7, 14: 5, 15: 6, 16: 7, 17: 8, 18: 2, 4: 2 }[
      b.kind
    ] ?? b.kind;
  return {
    ...b,
    kind: [0, 1, 3, 9].includes(kind) ? 1 : kind,
    layer: 0,
    value: b.kind === 18 ? 0 : b.value,
  };
}
export function composeBinding(mode, a, target = 1) {
  if (mode === "inherit") return blankBinding();
  if (mode === "none") return blankBinding(1);
  if (mode === "toggle") return { ...blankBinding(9), layer: target };
  const mapping = {
    hold: { 1: 1, 2: 2, 5: 11, 6: 12, 7: 13 },
    press: { 1: 1, 2: 10, 5: 5, 6: 6, 7: 7, 8: 8 },
    layer: { 1: 3, 2: 4, 5: 14, 6: 15, 7: 16, 8: 17 },
  };
  const kind = mapping[mode]?.[a.kind];
  if (kind === undefined) throw Error("This action cannot use that behavior.");
  return { ...a, kind, layer: mode === "layer" ? target : 0 };
}

// Returned order represents the actual destination, including any shifts.
export function dropOrder(indices, from, target, after) {
  const order = indices.filter((i) => i !== from);
  if (from === target) return indices.slice();
  const at = order.indexOf(target) + (after ? 1 : 0);
  order.splice(at, 0, from);
  return order;
}
