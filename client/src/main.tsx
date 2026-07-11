import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DemoPage } from "./board/DemoPage";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.pathname === "/board-demo" ? <DemoPage /> : <App />}
  </React.StrictMode>,
);
