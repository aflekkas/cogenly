import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_DETAIL_PARENTS, SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/open-source-licenses": "Open-source licenses",
};

function settingsBreadcrumbLabel(pathname: string): string | null {
  return SETTINGS_BREADCRUMB_LABELS[pathname] ?? null;
}

/**
 * `Settings / Section`, or `Settings / Section / Detail` on a detail page.
 * The scope a change applies to lives at the top of the page content, see
 * `SettingsScopeSentence`.
 */
export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const sectionLabel = settingsBreadcrumbLabel(normalizedPathname);
  const parentPath = SETTINGS_DETAIL_PARENTS[normalizedPathname];
  const parentLabel = parentPath ? SETTINGS_SECTION_LABELS[parentPath] : null;

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>Settings</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          {parentLabel ? (
            <>
              <WorkspaceBreadcrumbItem>{parentLabel}</WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
            </>
          ) : null}
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? "Settings"}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
