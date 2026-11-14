import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { deleteSelection, joinBackward, selectNodeBackward, splitBlock } from '@tiptap/pm/commands';
import type { DraftScope } from './composer-draft';
import type { ComposerEditorHandle } from '../editor/composer-editor';
import { readDraft, writeDraft } from './composer-draft-store';
import { serializeDraft } from './composer-draft';

let pending: { sessionId: string; finish: (editor: ComposerEditorHandle) => void } | null = null;

/** Called by the destination's draft lifecycle after restoration, including an empty draft. */
export function completeHomeComposerFocus(scope: DraftScope, editor: ComposerEditorHandle): void {
  if (scope.kind === 'session' && pending?.sessionId === scope.sessionId) pending.finish(editor);
}

/** The source registers its handle; no global textbox search chooses the destination. */
let sourceEditor: ComposerEditorHandle | null = null;
export function registerHomeComposerEditor(editor: ComposerEditorHandle | null): void {
  sourceEditor = editor;
}

/** Own only BODY keyboard input between the home editor and its destination restore. */
export function handoffHomeComposerFocus(sessionId: string, userId: string): void {
  const original = document.activeElement;
  if (!(original instanceof HTMLElement) || !original.matches('[contenteditable="true"][role="textbox"]')) return;
  const schema = sourceEditor?.getEditingState()?.schema;
  if (!schema) return;
  let state: EditorState | null = null;
  const scope = { kind: 'session' as const, sessionId };
  let timer: number;
  const stop = () => {
    if (pending?.finish === finish) pending = null;
    clearTimeout(timer);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', stop, true);
    document.removeEventListener('focusin', onFocus, true);
  };
  const finish = (editor: ComposerEditorHandle) => {
    const ownsFocus = document.activeElement === document.body || document.activeElement === editor.getElement();
    stop();
    const element = editor.getElement();
    if (ownsFocus && element) {
      element.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };
  const onFocus = (event: FocusEvent) => {
    if (event.target !== original && event.target !== document.body && event.target instanceof HTMLElement &&
        !event.target.matches('[contenteditable="true"][role="textbox"]')) stop();
  };
  const onKey = (event: KeyboardEvent) => {
    if (document.activeElement !== document.body || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length !== 1 && event.key !== 'Backspace' && event.key !== 'Enter') return;
    event.preventDefault();
    const draft = readDraft(scope, userId) ?? serializeDraft({
      doc: { type: 'doc', content: [] }, documentIsEmpty: false, files: [], userId,
    });
    if (!draft) return;
    if (!state) {
      const doc = schema.nodeFromJSON(draft.doc);
      state = EditorState.create({ schema, doc, selection: TextSelection.atEnd(doc) });
    }
    const dispatch = (transaction: Transaction) => {
      state = state!.apply(transaction);
    };
    if (event.key === 'Backspace') {
      if (!deleteSelection(state, dispatch)) {
        const before = state.selection.$from.nodeBefore;
        if (before?.isInline) {
          const size = before.isText ? (Array.from(before.text ?? '').at(-1)?.length ?? 1) : before.nodeSize;
          dispatch(state.tr.delete(state.selection.from - size, state.selection.from));
        } else if (!joinBackward(state, dispatch)) selectNodeBackward(state, dispatch);
      }
    } else if (event.key === 'Enter') splitBlock(state, dispatch);
    else dispatch(state.tr.insertText(event.key));
    writeDraft(scope, { ...draft, doc: state.doc.toJSON() });
  };
  pending = { sessionId, finish };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', stop, true);
  document.addEventListener('focusin', onFocus, true);
  timer = window.setTimeout(stop, 30_000);
}
