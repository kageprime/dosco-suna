"use client";

import { getArtifact, getPublicArtifact, parseArtifactUrl } from "@kortix/sdk";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { useContext, type ReactElement, type ReactNode } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "../primitives/hover-card";
import { useLocale, useTranslations } from "../i18n";

/** Enrich a chat link without changing its destination or click behavior. */
type ArtifactLinkProps = {
  href: string;
  raw: boolean;
  children: (label: ReactNode) => ReactElement;
};

export function ArtifactLink(props: ArtifactLinkProps) {
  const client = useContext(QueryClientContext);
  if (!client) return props.children(undefined);
  return <ResolvedArtifactLink {...props} />;
}

function ResolvedArtifactLink({ href, raw, children }: ArtifactLinkProps) {
  const ref = parseArtifactUrl(href)!;
  const t = useTranslations("markdownAppLinks");
  const locale = useLocale();
  const project = useQuery({
    queryKey: ["artifact-link-project", ref.projectId, ref.artifactId],
    queryFn: () =>
      getArtifact(ref.projectId!, ref.artifactId, { showErrors: false }),
    enabled: !!ref.projectId,
    staleTime: 60_000,
    retry: false,
  });
  const shared = useQuery({
    queryKey: ["artifact-link-public", ref.artifactId],
    queryFn: () => getPublicArtifact(ref.artifactId),
    enabled: !ref.projectId,
    staleTime: 60_000,
    retry: false,
  });
  const artifact = ref.projectId ? project.data : shared.data;
  if (!artifact) return children(undefined);
  const updated = new Date(artifact.updated_at);
  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        {children(raw ? artifact.title : undefined)}
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)] text-xs"
      >
        <div className="flex flex-col gap-2">
          <div className="text-foreground break-words font-medium">
            {artifact.title}
          </div>
          {artifact.description && (
            <p className="text-muted-foreground break-words whitespace-pre-wrap">
              {artifact.description}
            </p>
          )}
          <div className="text-muted-foreground">
            {t(artifact.type === "doc" ? "artifactDocument" : "artifactPage")}
          </div>
          {!Number.isNaN(updated.getTime()) && (
            <div className="text-muted-foreground">
              <time dateTime={artifact.updated_at}>
                {t("artifactUpdated", {
                  date: new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                  }).format(updated),
                })}
              </time>
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** Only enrich destinations on Kortix or the current host. */
export function isArtifactLink(href: string): boolean {
  if (!parseArtifactUrl(href)) return false;
  try {
    const url = new URL(href, "https://kortix.com");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return false;
    return (
      (href.startsWith("/") && url.origin === "https://kortix.com") ||
      (url.protocol === "https:" &&
        !url.port &&
        (url.hostname === "kortix.com" ||
          url.hostname.endsWith(".kortix.com"))) ||
      (typeof window !== "undefined" && url.origin === window.location.origin)
    );
  } catch {
    return false;
  }
}
