import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BackendProvider } from "./lib/BackendContext";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BackendProvider>
      <App />
    </BackendProvider>
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  // updateViaCache: "none" makes the browser bypass its HTTP cache when
  // checking /sw.js for updates, so a new deploy is picked up promptly
  // instead of waiting up to 24h for the default SW-script cache to expire.
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((registration) => {
    // Check for updates periodically (every 60s)
    setInterval(() => registration.update().catch(() => {}), 60_000);

    const onUpdateFound = () => {
      const newWorker = registration.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          // New SW installed and waiting — dispatch event for App to pick up
          window.dispatchEvent(new CustomEvent("sw-update-available"));
        }
      });
    };

    // If there's already a waiting worker (e.g. from a previous visit)
    if (registration.waiting && navigator.serviceWorker.controller) {
      window.dispatchEvent(new CustomEvent("sw-update-available"));
    }

    registration.addEventListener("updatefound", onUpdateFound);

    // Reload all tabs when the new SW takes over
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      window.location.reload();
    });
  }).catch((err) => {
    console.warn("Service worker registration failed:", err);
  });
}
