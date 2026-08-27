"use client";

import { createContext, useContext } from "react";

/**
 * Server-resolved org feature flags, provided once by Shell (which gets them
 * from the root layout) so client components deep in the tree — like the
 * AppShell floating chat — don't each need a prop threaded through every
 * page. Defaults mirror the env defaults for surfaces that are on when
 * unset; the provider always overrides them with real resolved values.
 */
export type OrgFeatureFlags = {
  chatEnabled: boolean;
};

const OrgFeaturesContext = createContext<OrgFeatureFlags>({
  chatEnabled: true,
});

export function OrgFeaturesProvider({
  value,
  children,
}: {
  value: OrgFeatureFlags;
  children: React.ReactNode;
}) {
  return (
    <OrgFeaturesContext.Provider value={value}>
      {children}
    </OrgFeaturesContext.Provider>
  );
}

export function useOrgFeatures(): OrgFeatureFlags {
  return useContext(OrgFeaturesContext);
}
