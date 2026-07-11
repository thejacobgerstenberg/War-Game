import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./theme.css";

// Dev-only board harness. The whole expression sits behind
// import.meta.env.DEV, which Vite statically replaces with `false` in prod
// builds, so Rollup dead-code-eliminates the branch AND the lazy chunk:
// /board-demo (and its ?svgUrl= fetch hook) does not exist in production.
const DemoPage = import.meta.env.DEV
  ? React.lazy(() =>
      import("./board/DemoPage").then((m) => ({ default: m.DemoPage })),
    )
  : null;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {DemoPage !== null && window.location.pathname === "/board-demo" ? (
      <React.Suspense fallback={null}>
        <DemoPage />
      </React.Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
