import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const container = document.getElementById("root")!;
createRoot(container).render(<App />);
