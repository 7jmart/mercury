import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import CompanionApp from "./CompanionApp";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const useCompanion = params.get("mode") === "companion";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{useCompanion ? <CompanionApp /> : <App />}</React.StrictMode>,
);
