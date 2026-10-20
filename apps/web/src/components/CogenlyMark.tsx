import { useEffect, useId, useRef } from "react";

import { registerBootSplashTarget } from "~/bootSplash";
import { cn } from "~/lib/utils";

// The app icon at UI sizes: the small-size cut from assets/brand/cogenly-mark-small.svg,
// which stays legible at 16-20px. Decorative; label the surrounding control instead.
// `bootSplashTarget` marks the one visible instance the boot splash morphs into.
export function CogenlyMark({
  bootSplashTarget = false,
  className,
}: {
  bootSplashTarget?: boolean;
  className?: string;
}) {
  const gradientId = useId();
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!bootSplashTarget || !ref.current) return;
    return registerBootSplashTarget(ref.current);
  }, [bootSplashTarget]);
  return (
    <svg
      ref={ref}
      aria-hidden="true"
      className={cn("size-4.5 shrink-0", className)}
      fill="none"
      viewBox="0 0 128 128"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="64"
          y1="0"
          x2="64"
          y2="128"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--color-brand-ember-from)" />
          <stop offset="1" stopColor="var(--color-brand-ember-to)" />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="28" fill={`url(#${gradientId})`} />
      <path
        d="M76.71 44.08A26 26 0 1 0 76.71 83.92"
        stroke="var(--color-brand-glyph)"
        strokeWidth="20"
        strokeLinecap="round"
      />
      <circle cx="94" cy="64" r="10" fill="var(--color-brand-glyph)" />
    </svg>
  );
}
