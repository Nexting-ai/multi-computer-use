// The real Excalidraw editor, one instance per cursor (browser session), kept
// in sync through lab/board/server.ts. Remote cursors are Excalidraw's own
// collaborator pointers. ?view=1: read-only viewer (live or replay).
import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, reconcileElements, CaptureUpdateAction, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import "./node_modules/@excalidraw/excalidraw/dist/prod/index.css";

const COLORS = ["#06b6d4", "#ec4899", "#65a30d", "#ea580c", "#8b5cf6", "#059669", "#dc2626", "#2563eb", "#c026d3", "#16a34a", "#ca8a04", "#0d9488"];
const params = new URLSearchParams(location.search);
const VIEW = params.has("view");
const N = VIEW ? 0 : Number(location.pathname.split("/").pop());
window.__busy = 0;

function collaborators(pointers) {
  const map = new Map();
  for (const p of pointers) {
    if (p.n === N) continue;
    const c = COLORS[(p.n - 1) % COLORS.length];
    map.set(String(p.n), {
      pointer: { x: p.x, y: p.y, tool: "pointer" },
      button: p.button || "up",
      username: p.label || `C${p.n}`,
      color: { background: c, stroke: c },
    });
  }
  return map;
}

function App() {
  const api = useRef(null);
  const known = useRef(new Map()); // element id -> highest version seen
  const pending = useRef([]);
  const held = useRef([]);
  const retry = useRef(0);
  const apply = (e) => {
    const a = api.current;
    if (!a) return pending.current.push(e);
    if (e.type === "snapshot" || e.type === "elements") {
      // Like a real collaborative client: never replace the scene while this
      // user is in the middle of drawing, dragging or typing; merge after.
      const st = a.getAppState();
      if (!VIEW && (st.newElement || st.editingTextElement || st.multiElement || st.resizingElement || st.selectedElementsAreBeingDragged || st.cursorButton === "down")) {
        held.current.push(...e.elements);
        clearTimeout(retry.current);
        retry.current = setTimeout(() => apply({ type: "elements", elements: held.current.splice(0) }), 60);
        if (e.type === "snapshot") a.updateScene({ collaborators: collaborators(e.pointers) });
        return;
      }
      for (const el of e.elements) known.current.set(el.id, Math.max(known.current.get(el.id) ?? -1, el.version));
      const merged = reconcileElements(a.getSceneElementsIncludingDeleted(), e.elements, a.getAppState());
      a.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    }
    if (e.type === "snapshot" || e.type === "pointers") a.updateScene({ collaborators: collaborators(e.pointers) });
  };
  window.__apply = apply; // replay drives the viewer through this
  useEffect(() => {
    if (VIEW && params.has("replay")) return;
    const es = new EventSource("/events");
    es.onmessage = (m) => apply(JSON.parse(m.data));
    return () => es.close();
  }, []);
  const onChange = (elements) => {
    if (VIEW) return;
    const changed = elements.filter((el) => (known.current.get(el.id) ?? -1) < el.version);
    if (!changed.length) return;
    for (const el of changed) known.current.set(el.id, el.version);
    window.__busy++;
    fetch("/elements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cursor: N, elements: changed }) }).finally(() => window.__busy--);
  };
  let last = 0;
  const onPointerUpdate = ({ pointer, button }) => {
    if (VIEW) return;
    const now = performance.now();
    if (now - last < 50 && button !== "down") return;
    last = now;
    fetch("/pointer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: N, x: pointer.x, y: pointer.y, button }) });
  };
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Excalidraw
        excalidrawAPI={(a) => {
          api.current = a;
          window.__api = a;
          // ?seed=<url>: draw skeleton elements (the target picture).
          if (params.has("seed"))
            fetch(params.get("seed")).then((r) => r.json()).then((sk) => {
              a.updateScene({ elements: convertToExcalidrawElements(sk, { regenerateIds: false }), captureUpdate: CaptureUpdateAction.NEVER });
              window.__seeded = true;
            });
          // ?fit=x0,y0,x1,y1: viewer frames this scene area.
          if (params.has("fit")) {
            const [x0, y0, x1, y1] = params.get("fit").split(",").map(Number);
            const frame = () => {
              const z = Math.min(innerWidth / (x1 - x0), innerHeight / (y1 - y0));
              a.updateScene({ appState: { zoom: { value: z }, scrollX: -x0 + (innerWidth / z - (x1 - x0)) / 2, scrollY: -y0 + (innerHeight / z - (y1 - y0)) / 2 } });
            };
            // After the editor's own first layout, and whenever the frame resizes.
            setTimeout(frame, 300);
            setTimeout(frame, 1200);
            addEventListener("resize", frame);
          }
          for (const e of pending.current.splice(0)) apply(e);
        }}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        isCollaborating={true}
        viewModeEnabled={VIEW}
        zenModeEnabled={VIEW}
        gridModeEnabled={false}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false, changeViewBackgroundColor: false, clearCanvas: false } }}
        initialData={{ appState: { viewBackgroundColor: "#ffffff", currentItemRoughness: 0, currentItemFontFamily: 2, scrollX: 0, scrollY: 0, zoom: { value: 1 } } }}
      />
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
