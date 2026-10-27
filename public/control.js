/**
 * Touch and key toolbar for the MFD viewer.
 *
 * Coordinates are normalised to 0..1 over the video rectangle; the plugin
 * scales them to the MFD's own pixel resolution reported in the PONG frame.
 */

const MOVE_INTERVAL_MS = 50;

export function createController({
  layer,
  keys,
  canInteract,
  onTouch,
  onKey,
  onBlocked,
}) {
  let pointerId = null;
  let lastPoint = null;
  let moveTimer = null;
  let signature = "";

  function coords(event) {
    const rect = layer.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    const clamp = (value) => Math.min(1, Math.max(0, value));
    return {
      x: Math.round(clamp((event.clientX - rect.left) / rect.width) * 10000) / 10000,
      y: Math.round(clamp((event.clientY - rect.top) / rect.height) * 10000) / 10000,
    };
  }

  function flushMove() {
    if (moveTimer) {
      clearTimeout(moveTimer);
      moveTimer = null;
    }
    if (lastPoint && pointerId !== null) onTouch({ phase: "move", ...lastPoint });
  }

  function scheduleMove() {
    if (moveTimer) return;
    moveTimer = setTimeout(() => {
      moveTimer = null;
      if (lastPoint && pointerId !== null) onTouch({ phase: "move", ...lastPoint });
    }, MOVE_INTERVAL_MS);
  }

  function finish(phase) {
    if (pointerId === null) return;
    if (moveTimer) {
      clearTimeout(moveTimer);
      moveTimer = null;
    }
    if (lastPoint) onTouch({ phase, ...lastPoint });
    pointerId = null;
    lastPoint = null;
  }

  layer.addEventListener("pointerdown", (event) => {
    if (!canInteract()) {
      onBlocked();
      return;
    }
    event.preventDefault();
    pointerId = event.pointerId;
    try {
      layer.setPointerCapture(pointerId);
    } catch (_error) {
      // pointer capture is best effort
    }
    lastPoint = coords(event);
    onTouch({ phase: "press", ...lastPoint });
  });

  layer.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId || !canInteract()) return;
    lastPoint = coords(event);
    scheduleMove();
  });

  layer.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointerId) return;
    flushMove();
    finish("release");
  });

  layer.addEventListener("pointercancel", (event) => {
    if (event.pointerId !== pointerId) return;
    finish("cancel");
  });

  layer.addEventListener("lostpointercapture", (event) => {
    if (event.pointerId !== pointerId) return;
    finish("cancel");
  });

  const pressed = new Set();

  function setKeys(list) {
    const next = JSON.stringify(
      (list || []).map((key) => [key.index, key.label, key.translation])
    );
    if (next === signature) return;
    signature = next;
    pressed.clear();

    keys.textContent = "";
    for (const key of list || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = key.label;
      button.dataset.index = String(key.index);

      const down = (event) => {
        event.preventDefault();
        if (!canInteract()) {
          onBlocked();
          return;
        }
        pressed.add(key.index);
        onKey({ index: key.index, state: 1 });
        try {
          button.setPointerCapture(event.pointerId);
        } catch (_error) {
          // best effort
        }
      };
      const up = () => {
        if (!pressed.delete(key.index)) return;
        onKey({ index: key.index, state: 0 });
      };

      button.addEventListener("pointerdown", down);
      button.addEventListener("pointerup", up);
      button.addEventListener("pointercancel", up);
      button.addEventListener("pointerleave", up);
      keys.appendChild(button);
    }
  }

  return { setKeys };
}
