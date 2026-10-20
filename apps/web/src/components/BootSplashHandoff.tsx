import { useEffect } from "react";

import { dismissBootSplash } from "../bootSplash";

/** Mounted beside the app root: starts the boot splash hand-off after the first commit. */
export function BootSplashHandoff() {
  useEffect(() => {
    void dismissBootSplash();
  }, []);
  return null;
}
