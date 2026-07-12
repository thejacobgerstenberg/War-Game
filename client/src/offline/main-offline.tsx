/**
 * Offline single-file build entry (spec §6). Mirrors main.tsx minus the
 * dev-only DemoPage branch: no router, no socket, no session — OfflineApp
 * owns the whole flow.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import "../theme.css"; // theme variables + (dead on file://) /fonts @font-faces
import "./fonts-offline.css"; // data-URI faces (Author C) — AFTER theme.css so they win
import { OfflineApp } from "./OfflineApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <OfflineApp />
  </React.StrictMode>,
);
