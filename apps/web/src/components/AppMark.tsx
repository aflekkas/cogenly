import type { SVGProps } from "react";

/** Neutral placeholder app mark: a rounded square with a centered dot. */
export function AppMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      data-app-mark="true"
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}
