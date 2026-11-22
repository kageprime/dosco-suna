import type { JSONContent } from '@tiptap/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createElement, type RefObject } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { ComposerEditorHandle } from '../editor/composer-editor';
import type { DraftScope, StoredUpload } from './composer-draft';
import { readDraft } from './composer-draft-store';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const USER = 'synthetic-user';
const realUi = await import('../../../providers/ui-provider');
mock.module('../../../providers/ui-provider', () => ({ ...realUi, useUiViewerId: () => USER }));
const { useComposerDraft } = await import('./use-composer-draft');

const HOME: DraftScope = { kind: 'project', projectId: 'synthetic-project' };
const SESSION: DraftScope = { kind: 'session', sessionId: 'synthetic-session' };

function doc(text: string): JSONContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  };
}

const UPLOAD: StoredUpload = {
  attachment_id: 'att-1',
  filename: 'notes.txt',
  mime: 'text/plain',
  size: 5,
  expires_at: '2099-01-01T00:00:00.000Z',
  isImage: false,
};

/** The composer's editor: only what the draft hook reads off it. */
function fakeEditor(initial: string) {
  let current = doc(initial);
  const handle: ComposerEditorHandle = {
    getContent: () => ({ text: '', mentions: [] }),
    setContent: () => undefined,
    getEditingState: () => null,
    getDocument: () => current,
    setDocument: () => undefined,
    insertAtCursor: () => undefined,
    clear: () => undefined,
    focus: () => undefined,
    isEmpty: () => !current.content?.[0]?.content?.length,
    getElement: () => null,
  };
  return {
    ref: { current: handle },
    set: (text: string) => {
      current = doc(text);
    },
  };
}

function savedText(scope: DraftScope): string | null {
  const draft = readDraft(scope, USER);
  if (!draft) return null;
  return JSON.stringify(draft.doc).match(/"text":"([^"]*)"/)?.[1] ?? '';
}

type Hook = ReturnType<typeof useComposerDraft>;
type Lists = { uploads?: StoredUpload[]; quotes?: string[] };

/** Mounts the hook the way the project-home composer wires it. */
function mountHome(editorRef: RefObject<ComposerEditorHandle | null>, uploads: StoredUpload[]) {
  const handoffScope: RefObject<DraftScope | null> = { current: null };
  let hook: Hook | null = null;
  const Harness = ({ lists }: { lists: Lists }) => {
    hook = useComposerDraft({
      scope: HOME,
      handoffScope,
      editorRef,
      editorReady: true,
      attachedFiles: [],
      uploads: lists.uploads,
      quotes: lists.quotes,
      hasPrefill: false,
      onRestore: () => undefined,
    });
    return null;
  };
  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = create(createElement(Harness, { lists: { uploads } }));
  });
  const mounted = (): ReactTestRenderer => {
    if (!renderer) throw new Error('harness not mounted');
    return renderer;
  };
  return {
    hook: (): Hook => {
      if (!hook) throw new Error('hook not rendered');
      return hook;
    },
    setLists: (lists: Lists) =>
      act(() => {
        mounted().update(createElement(Harness, { lists }));
      }),
    /** The create resolved: the session page replaces project home. */
    navigate: () =>
      act(() => {
        handoffScope.current = SESSION;
        mounted().unmount();
      }),
  };
}

// The hook listens for `visibilitychange` and `pagehide`; its storage is the
// window's.
const dom = new Window({ url: 'https://example.test/' });
const saved = { window: globalThis.window, document: globalThis.document };
beforeAll(() => {
  Object.defineProperty(globalThis, 'window', { value: dom, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.document, configurable: true, writable: true });
});
afterAll(() => {
  Object.defineProperty(globalThis, 'window', { value: saved.window, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: saved.document, configurable: true, writable: true });
  dom.close();
});

beforeEach(() => {
  dom.localStorage.clear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// Project home sends with `clearOnSend={false}`: the sent text stays in the
// locked box until the session page opens, and the home draft is handed to
// that session on unmount (Slack #kortix-triage report, KRTX-4944).
describe('useComposerDraft after a send that keeps its text on screen', () => {
  test('a released attachment does not carry the sent text into the session composer', () => {
    const editor = fakeEditor('What is the first word in the attached file');
    const home = mountHome(editor.ref, [UPLOAD]);

    // Send: the composer hands the message off and keeps it on screen.
    act(() => home.hook().clearSavedDraft());
    expect(savedText(HOME)).toBeNull();
    // The send posted, so it releases its uploads: the tray's finished-upload
    // list changes while the editor still shows the sent text.
    home.setLists({ uploads: [] });
    home.navigate();

    expect(savedText(SESSION)).toBeNull();
    expect(savedText(HOME)).toBeNull();
  });

  test('an upload finishing after Send does not save the sent text as the draft', () => {
    const editor = fakeEditor('Summarize the attached file');
    const home = mountHome(editor.ref, []);

    act(() => home.hook().clearSavedDraft());
    // Send does not wait for uploads; this one finishes a moment later.
    home.setLists({ uploads: [UPLOAD] });
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(savedText(HOME)).toBeNull();
    home.navigate();
    expect(savedText(SESSION)).toBeNull();
  });

  test('a text-only send leaves no draft behind', () => {
    const editor = fakeEditor('Plain text, no files');
    const home = mountHome(editor.ref, []);

    act(() => home.hook().handleDocChange(doc('Plain text, no files'), false));
    act(() => home.hook().clearSavedDraft());
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    home.navigate();

    expect(savedText(HOME)).toBeNull();
    expect(savedText(SESSION)).toBeNull();
  });

  test('text typed after Send is still saved and handed to the session', () => {
    const editor = fakeEditor('First message');
    const home = mountHome(editor.ref, [UPLOAD]);

    act(() => home.hook().clearSavedDraft());
    home.setLists({ uploads: [] });
    // The user writes the next message while the send is still in flight.
    editor.set('A follow-up');
    act(() => home.hook().handleDocChange(doc('A follow-up'), false));
    home.navigate();

    expect(savedText(SESSION)).toBe('A follow-up');
  });

  test('a composer that empties on Send still re-saves a refused send it restores', () => {
    const editor = fakeEditor('Retry me');
    const home = mountHome(editor.ref, []);

    // A clearing composer empties the editor before it clears the saved draft.
    editor.set('');
    act(() => home.hook().clearSavedDraft());
    // The host refused the send: the composer puts the text back and saves it.
    editor.set('Retry me');
    act(() => home.hook().handleDocChange(doc('Retry me'), false));
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(savedText(HOME)).toBe('Retry me');
  });

  test('a sent command typed again is saved again', () => {
    const editor = fakeEditor('/help');
    const home = mountHome(editor.ref, []);

    // A command send clears the saved draft first, then empties the editor.
    act(() => home.hook().clearSavedDraft());
    editor.set('');
    act(() => home.hook().handleDocChange(doc(''), true));
    editor.set('/help');
    act(() => home.hook().handleDocChange(doc('/help'), false));
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(savedText(HOME)).toBe('/help');
  });

  test('a quote added to the text still on screen is a new draft', () => {
    const editor = fakeEditor('Kept after a refused send');
    const home = mountHome(editor.ref, []);

    act(() => home.hook().clearSavedDraft());
    home.setLists({ quotes: ['a quoted line'] });
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(readDraft(HOME, USER)?.quotes).toEqual(['a quoted line']);
  });

  test('after a refused send, a file added to the text still on screen is saved', () => {
    const editor = fakeEditor('Create failed, try again');
    const home = mountHome(editor.ref, []);

    act(() => home.hook().clearSavedDraft());
    // The create failed: the text stays on screen and is a draft again.
    act(() => home.hook().sendRefused());
    home.setLists({ uploads: [UPLOAD] });
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(savedText(HOME)).toBe('Create failed, try again');
    expect(readDraft(HOME, USER)?.uploads).toEqual([UPLOAD]);
  });
});
