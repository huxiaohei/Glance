import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { startApplyingSettings } from "./app/applySettings";
import { initSettings } from "./stores/settings";
import "./theme.css";

// 先读设置并应用主题再渲染，避免先深后浅的闪烁；initSettings 不会抛
void initSettings().then(() => {
  try {
    startApplyingSettings();
  } catch (e) {
    // 应用设置出错也要渲染，界面退回默认外观
    console.error("startApplyingSettings failed", e);
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
