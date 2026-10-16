import "~/index.css";
void Promise.all([import("react"), import("react-dom/client"), import("./AgentsPreview")]).then(
  ([React, ReactDOM, { AgentsPreview }]) => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <AgentsPreview />
      </React.StrictMode>,
    );
  },
);
