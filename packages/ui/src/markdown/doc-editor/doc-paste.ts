import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Lexer, Marked } from 'marked';

import { markdownToHtml } from './markdown';

/** What only Markdown spells: a typed `- `, `#### ` or `**…**` turns into these. */
const FORMATTING = new Set(['heading', 'list', 'blockquote', 'table', 'hr', 'strong', 'em', 'codespan', 'del', 'image']);
const walker = new Marked();

/**
 * Whether pasted text is written in Markdown. Indented text is not a code
 * block, a bare URL is not a link, and text with HTML in it stays text: it
 * would open as a raw block.
 */
export function isMarkdown(text: string): boolean {
  let markdown = false;
  let html = false;
  walker.walkTokens(Lexer.lex(text), (token) => {
    if (token.type === 'html') html = true;
    else if (
      FORMATTING.has(token.type) ||
      (token.type === 'code' && token.codeBlockStyle !== 'indented') ||
      (token.type === 'link' && token.raw !== token.href)
    )
      markdown = true;
  });
  return markdown && !html;
}

/** HTML that carries its own formatting (a web page, another doc), not a code editor's styled lines. */
const FORMATTED = 'h1,h2,h3,h4,h5,h6,ul,ol,table,blockquote,pre,code,strong,b,em,i,u,s,del,a,img,hr';
const isFormatted = (html: string) => new DOMParser().parseFromString(html, 'text/html').querySelector(FORMATTED) !== null;

/**
 * Markdown pasted as text opens as formatting, as it does when typed or when
 * the file opens. Shift+paste and a paste into code keep the text as is, and
 * a clipboard with formatted HTML keeps that HTML.
 */
export const MarkdownPaste = Extension.create({
  name: 'markdownPaste',
  addProseMirrorPlugins() {
    // Shift held: ProseMirror's own rule for "paste as plain text" (Shift+Insert is a normal paste).
    let plain = false;
    return [
      new Plugin({
        key: new PluginKey('markdownPaste'),
        props: {
          handleDOMEvents: {
            keydown: (_view, event) => {
              plain = event.shiftKey && event.key !== 'Insert';
              return false;
            },
            keyup: (_view, event) => {
              if (event.key === 'Shift') plain = false;
              return false;
            },
          },
          handlePaste: (view, event) => {
            const text = event.clipboardData?.getData('text/plain') ?? '';
            const html = event.clipboardData?.getData('text/html') ?? '';
            if (plain || view.state.selection.$from.parent.type.spec.code || !isMarkdown(text) || (html && isFormatted(html)))
              return false;
            // No event: the converted paste carries no clipboard, so this handler lets it through.
            view.pasteHTML(markdownToHtml(text));
            return true;
          },
        },
      }),
    ];
  },
});
