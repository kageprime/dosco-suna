'use client';

// A textarea that completes `@handle` from the workspace's people. Typing
// `@` and a few letters lists the matches under the field; Enter or Tab
// inserts the handle, Escape closes the list. Plain text in, plain text out:
// the server resolves the mentions.
import { useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../../lib/utils';
import { menuRow, MENU_PANEL_STATIC } from '../../primitives/menu-recipe';
import { Textarea, type AutosizeTextAreaRef } from '../../primitives/textarea';
import { UserAvatar } from '../../primitives/user-avatar';
import { personName, type CalendarDirectory } from './calendar-people';

const MAX_MATCHES = 6;

/** The `@query` the caret is in, or null. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([a-z0-9._+-]*)$/i.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1]!.length - 1, query: match[1]!.toLowerCase() };
}

export function MentionTextarea({
  value,
  onChange,
  directory,
  onSubmit,
  onBlur,
  placeholder,
  minHeight,
  className,
  autoFocus,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  directory: CalendarDirectory;
  /** Cmd/Ctrl+Enter. */
  onSubmit?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  minHeight?: number;
  className?: string;
  autoFocus?: boolean;
  ariaLabel: string;
}) {
  const ref = useRef<AutosizeTextAreaRef>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);

  const matches = mention
    ? directory.people
      .filter((p) => [p.handle, p.name ?? '', p.email ?? ''].some((s) => s.toLowerCase().includes(mention.query)))
      .slice(0, MAX_MATCHES)
    : [];

  const track = (text: string, caret: number) => {
    const next = mentionQueryAt(text, caret);
    setMention(next);
    if (next?.query !== mention?.query) setActive(0);
  };

  const insert = (handle: string) => {
    const area = ref.current?.textArea;
    if (!mention || !area) return;
    const caret = area.selectionStart ?? value.length;
    const next = `${value.slice(0, mention.start)}@${handle} ${value.slice(caret)}`;
    onChange(next);
    setMention(null);
    const at = mention.start + handle.length + 2;
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (i + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insert(matches[active]!.handle);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSubmit) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    // The matches render in flow under the field: a dialog or the side panel grows, nothing is clipped.
    <div>
      <Textarea
        ref={ref}
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        minHeight={minHeight}
        autoFocus={autoFocus}
        className={cn('text-sm', className)}
        onChange={(event) => {
          onChange(event.target.value);
          track(event.target.value, event.target.selectionStart ?? event.target.value.length);
        }}
        onKeyDown={onKeyDown}
        onClick={(event) => track(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
        onBlur={() => {
          // A click on a match lands after the blur: let it run first.
          setTimeout(() => setMention(null), 120);
          onBlur?.();
        }}
      />
      {matches.length > 0 ? (
        <ul role="listbox" aria-label={ariaLabel} className={cn(MENU_PANEL_STATIC, 'mt-1')}>
          {matches.map((person, i) => (
            <li key={person.user_id} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={menuRow('sm', 'default', cn(i === active && 'bg-primary/10 text-foreground'))}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(person.handle)}
              >
                <UserAvatar email={person.email ?? ''} name={person.name} avatarUrl={person.avatar_url} colorKey={person.user_id} size="xs" />
                <span className="truncate">{personName(person, person.handle)}</span>
                <span className="text-muted-foreground ml-auto truncate text-xs">@{person.handle}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
