import { useEffect } from "react";

import { dismissBootSplash, holdBootSplashHandoff } from "../bootSplash";

/**
 * Mounted beside the app root: starts the boot splash hand-off after the first commit, and
 * removes the splash outright if it unmounts first.
 */
export function BootSplashHandoff() {
  useEffect(() => {
    const release = holdBootSplashHandoff();
    void dismissBootSplash();
    return release;
  }, []);
  return null;
}
