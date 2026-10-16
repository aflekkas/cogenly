// Entry for apps/web/dev/agent-faces.html, a dev-only page outside the router.
// The page imports dynamically, like src/bootstrap.ts, so React refresh is ready first.
import "~/index.css";

void Promise.all([import("react"), import("react-dom/client"), import("./AgentFacesPreview")]).then(
  ([React, ReactDOM, { AgentFacesPreview }]) => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <AgentFacesPreview />
      </React.StrictMode>,
    );
  },
);
