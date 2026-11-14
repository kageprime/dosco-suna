'use client';

/**
 * The developer panel both white-label apps put next to a control: the SDK call
 * the app runs and the HTTP request that reaches Kortix (`./call-snippets.ts`).
 * Each app's `src/components/dev/call-snippet.tsx` resolves its snippet, passes
 * its placeholder bearer and the note that explains it, and decides when the
 * panel renders.
 *
 * Colouring is presentation and nothing else. The tokenizer
 * (`@kortix/white-label-shared/syntax-highlight`) only ever slices the snippet, so this file
 * holds the class per token role and no logic about what a token is.
 */

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@kortix/ui/collapsible';
import { type CallSnippet, isCopyableHttp, renderHttp } from './call-snippets';
import {
  type SnippetLanguage,
  type TokenKind,
  highlight,
} from './syntax-highlight';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@kortix/ui';
import { errorToast, successToast } from '@kortix/ui/toast';
import { CaretDownIcon, CheckIcon, CodeIcon, CopyIcon } from '@phosphor-icons/react';

export function CallSnippetPanel({
  snippet,
  authorization,
  bearerNote,
  className,
  defaultOpen = false,
}: {
  snippet: CallSnippet;
  /** The app's placeholder authorization line, never a real key. */
  authorization: string;
  /** What the placeholder bearer stands for in this app. */
  bearerNote: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  const http = renderHttp(snippet.http, authorization);

  return (
    <Collapsible defaultOpen={defaultOpen} className={cn('w-full', className)}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="group gap-1.5 text-muted-foreground"
        >
          <CodeIcon className="size-3" />
          The API call
          <CaretDownIcon className="size-3 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 space-y-3 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {snippet.summary}
          </p>

          <Block
            label="SDK"
            caption="What this app runs."
            code={snippet.sdk}
            language="ts"
          />

          <Block
            label="HTTP"
            caption={
              isCopyableHttp(snippet.http)
                ? 'What reaches Kortix — the form to use from any language.'
                : 'Not a REST call.'
            }
            code={http}
            language="http"
            copyable={isCopyableHttp(snippet.http)}
          />

          {snippet.serverInjected.length > 0 && (
            <div className="rounded-md border border-brand/30 bg-brand/5 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium">
                  Added by the server, not the browser
                </span>
                {snippet.serverInjected.map((field) => (
                  <Badge
                    key={field}
                    variant="outline"
                    className="font-mono text-[11px]"
                  >
                    {field}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <ul className="space-y-1.5">
            {snippet.notes.map((note) => (
              <li
                key={note}
                className="text-xs leading-relaxed text-muted-foreground"
              >
                {note}
              </li>
            ))}
          </ul>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {bearerNote}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Colour per token role, from the theme tokens `globals.css` already defines —
 * no palette of its own, so both themes stay correct for free. The values a
 * wrapper author retypes (strings, numbers) carry the brand tint; the structure
 * they read past (braces, commas, comments) recedes.
 */
const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: '',
  punctuation: 'text-muted-foreground',
  comment: 'text-muted-foreground italic',
  keyword: 'text-brand',
  string: 'text-brand/80',
  number: 'text-brand/70',
  property: 'text-foreground',
  method: 'text-brand font-medium',
  path: 'text-foreground',
};

function Block({
  label,
  caption,
  code,
  language,
  copyable = true,
}: {
  label: string;
  caption: string;
  code: string;
  language: SnippetLanguage;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(resetTimer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      if (!mounted.current) return;
      setCopied(true);
      successToast(`${label} call copied`);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1_500);
    } catch {
      if (mounted.current) errorToast('Could not copy');
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-[10px]">
          {label}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {caption}
        </span>
        {copyable && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Copy the ${label} call`}
            data-copied={copied ? '' : undefined}
            onClick={copy}
          >
            {copied ? (
              <CheckIcon className="size-3" />
            ) : (
              <CopyIcon className="size-3" />
            )}
          </Button>
        )}
      </div>
      {copyable ? (
        <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-background p-2.5 text-[11px] leading-relaxed text-foreground/80 scrollbar-thin">
          {/* Spans are slices of `code` in order — the copy button above still
              writes `code` itself, so what lands in an editor is byte for byte
              what this block shows (@kortix/white-label-shared/syntax-highlight). */}
          <code>
            {highlight(code, language).map((token, i) => (
              <span key={i} className={TOKEN_CLASS[token.kind]}>
                {token.text}
              </span>
            ))}
          </code>
        </pre>
      ) : (
        // Prose, not a code block: there is no path to copy, and printing one
        // would teach hand-rolling the runtime transport the SDK owns.
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {code}
        </p>
      )}
    </div>
  );
}
