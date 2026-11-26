// Keep slot geometry fixed during a drag so the moving placeholder cannot
// change its own drop target. The config changes only on pointer release.
import { dropOrder } from "./action-model.js";

export function installProfileDrag(host, commit) {
  let drag = null,
    suppressClick = false;
  host.addEventListener("pointerdown", (e) => {
    const tab = e.target.closest(".profile-tab");
    if (e.button !== 0 || !tab) return;
    const items = [...host.querySelectorAll(".profile-item")];
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      active: false,
      from: Number(tab.closest(".profile-item").dataset.profileIndex),
      items,
      slots: items.map((n) => n.getBoundingClientRect()),
      indices: items.map((n) => Number(n.dataset.profileIndex)),
    };
  });
  host.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.active = true;
      host.setPointerCapture(e.pointerId);
      drag.items
        .find((n) => Number(n.dataset.profileIndex) === drag.from)
        .classList.add("dragging");
    }
    e.preventDefault();
    let target = 0,
      distance = Infinity;
    drag.slots.forEach((r, i) => {
      const d = Math.hypot(
        e.clientX - r.x - r.width / 2,
        e.clientY - r.y - r.height / 2,
      );
      if (d < distance) {
        target = i;
        distance = d;
      }
    });
    const r = drag.slots[target];
    const order = dropOrder(
      drag.indices,
      drag.from,
      drag.indices[target],
      e.clientX > r.x + r.width / 2,
    );
    drag.to = drag.indices[order.indexOf(drag.from)];
    drag.items.forEach(
      (n) => (n.style.order = order.indexOf(Number(n.dataset.profileIndex))),
    );
  });
  function finish(e, cancel = false) {
    if (!drag || drag.id !== e.pointerId) return;
    const done = drag;
    drag = null;
    done.items.forEach((n) => {
      n.classList.remove("dragging");
      n.style.order = "";
    });
    if (done.active) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      host.releasePointerCapture(e.pointerId);
      if (!cancel && done.to !== undefined && done.to !== done.from)
        commit(done.from, done.to);
    }
  }
  host.addEventListener("pointerup", (e) => finish(e));
  host.addEventListener("pointercancel", (e) => finish(e, true));
  host.addEventListener(
    "click",
    (e) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}
