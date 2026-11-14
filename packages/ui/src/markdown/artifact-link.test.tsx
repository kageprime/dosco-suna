import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlTestProvider } from "../test-utils/intl";
import { MarkdownLink, UnifiedMarkdown } from "./unified-markdown";
import { isArtifactLink } from "./artifact-link";

const id = "00000000-0000-4000-8000-000000000001";
const href = `https://dev.kortix.com/share/artifact/${id}`;
function render(label = href, client?: QueryClient) {
  const link = (
    <IntlTestProvider locale="en" onError={() => {}}>
      <MarkdownLink href={href}>{label}</MarkdownLink>
    </IntlTestProvider>
  );
  return renderToStaticMarkup(
    client ? (
      <QueryClientProvider client={client}>{link}</QueryClientProvider>
    ) : (
      link
    ),
  );
}
test("artifact URLs remain usable without a query provider", () => {
  expect(render()).toContain(`href="${href}"`);
  expect(render()).toContain(href);
});
test("only supported artifact destinations are enriched", () => {
  expect(isArtifactLink(href)).toBe(true);
  expect(isArtifactLink(`/share/artifact/${id}`)).toBe(true);
  for (const host of [
    "https://example.com",
    "https://kortix.com.evil.test",
    "https://kortix.com@evil.test",
    "http://dev.kortix.com",
  ]) {
    expect(isArtifactLink(`${host}/share/artifact/${id}`)).toBe(false);
  }
});
test("resolved metadata replaces a raw URL and preserves a custom label", () => {
  const client = new QueryClient();
  client.setQueryData(["artifact-link-public", id], {
    artifact_id: id,
    title: "Project brief",
    description: "A synthetic artifact",
    type: "doc",
    updated_at: "2026-11-14T00:00:00Z",
    content_url: "https://example.invalid/content",
  });
  expect(render(href, client)).toContain("Project brief");
  expect(render(href, client)).not.toContain(`>${href}</a>`);
  expect(render(href, client)).toContain('data-slot="hover-card-trigger"');
  expect(render("Read the brief", client)).toContain("Read the brief");
  expect(render("Read the brief", client)).toContain(`href="${href}"`);
  client.clear();
});
test("missing metadata preserves the original anchor", () => {
  const client = new QueryClient();
  expect(render(href, client)).toContain(`href="${href}"`);
  client.clear();
});

test("workspace metadata enriches relative links", () => {
  const pid = "00000000-0000-4000-8000-000000000002";
  const url = `/workspaces/${pid}/artifacts/${id}`;
  const client = new QueryClient();
  client.setQueryData(["artifact-link-project", pid, id], {
    title: "Private brief",
    type: "doc",
    updated_at: "2026-11-14T00:00:00Z",
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlTestProvider locale="en">
        <MarkdownLink href={url}>{url}</MarkdownLink>
      </IntlTestProvider>
    </QueryClientProvider>,
  );
  expect(html).toContain("Private brief");
  expect(html).toContain(`href="${url}"`);
  expect(html).toContain('data-slot="hover-card-trigger"');
  client.clear();
});
test("document markdown preserves artifact URLs", () => {
  const client = new QueryClient();
  client.setQueryData(["artifact-link-public", id], {
    title: "Hidden metadata",
    type: "doc",
    updated_at: "2026-11-14T00:00:00Z",
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlTestProvider locale="en">
        <UnifiedMarkdown trust="agent" variant="document" content={href} />
      </IntlTestProvider>
    </QueryClientProvider>,
  );
  expect(html).toContain(href);
  expect(html).not.toContain("Hidden metadata");
  expect(html).not.toContain('data-slot="hover-card-trigger"');
  client.clear();
});
