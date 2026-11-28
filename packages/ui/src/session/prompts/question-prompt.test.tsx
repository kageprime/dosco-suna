import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, test } from 'bun:test';
import { QuestionPrompt } from './question-prompt';
import { UiProvider } from '../../providers/ui-provider';
import { defaultUiMessages } from '../../i18n';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});
const request = {
  id: 'question-synthetic',
  sessionID: 'session-synthetic',
  questions: [
    {
      header: 'Format',
      question: 'Which format?',
      options: [{ label: 'Text', description: 'Plain text' }],
      custom: true,
    },
  ],
};
const text = (tree: ReactTestRenderer) => JSON.stringify(tree.toJSON());

describe('question answer acknowledgement', () => {
  test('keeps answers editable after a rejected reply and retries exactly once', async () => {
    let calls = 0;
    let rejectReply: (error: Error) => void = () => undefined;
    const trees: ReactTestRenderer[] = [];
    await act(async () => {
      trees.push(create(
        <QuestionPrompt
          request={request}
          onReject={() => undefined}
          onReply={() => {
            calls++;
            return new Promise<void>((_resolve, reject) => {
              rejectReply = reject;
            });
          }}
        />,
      ));
    });
    const pick = () =>
      trees[0].root.findAllByType('button').find((b) => b.props['aria-pressed'] !== undefined);
    await act(async () => {
      pick()?.props.onClick();
    });
    expect(text(trees[0])).toContain('Submitting');
    expect(calls).toBe(1);
    await act(async () => {
      rejectReply(new Error('Synthetic failure'));
    });
    expect(text(trees[0])).toContain('Could not submit');
    expect(pick()).toBeDefined();
    await act(async () => {
      pick()?.props.onClick();
    });
    expect(calls).toBe(2);
    await act(async () => {
      trees[0].unmount();
    });
  });
});

test('custom answers use the question reply, not discussion, and an in-flight click is ignored', async () => {
  const ref = React.createRef<import('./question-prompt').QuestionPromptHandle>();
  const replies: string[][][] = [];
  let finish: () => void = () => undefined;
  const trees: ReactTestRenderer[] = [];
  await act(async () => {
    trees.push(create(<QuestionPrompt ref={ref} request={request} onReject={() => undefined} onReply={(_id, answers) => {
      replies.push(answers);
      return new Promise<void>((resolve) => { finish = resolve; });
    }} />));
  });
  await act(async () => {
    ref.current?.submitCustomAnswer('Markdown with tables');
    ref.current?.submitCustomAnswer('Ignored second answer');
  });
  expect(replies).toEqual([[['Markdown with tables']]]);
  await act(async () => { finish(); });
  expect(text(trees[0])).toContain('Answers submitted');
  await act(async () => { trees[0].unmount(); });
});

test('multi-question review submits the selected answers with one final click', async () => {
  const ref = React.createRef<import('./question-prompt').QuestionPromptHandle>();
  const replies: string[][][] = [];
  const trees: ReactTestRenderer[] = [];
  await act(async () => {
    trees.push(create(<QuestionPrompt ref={ref} request={{ ...request, questions: [...request.questions, { ...request.questions[0], header: 'Length' }] }} onReject={() => undefined} onReply={(_id, answers) => { replies.push(answers); }} />));
  });
  await act(async () => { ref.current?.submitCustomAnswer('CSV'); });
  await act(async () => { ref.current?.submitCustomAnswer('Short'); });
  expect(replies).toEqual([]);
  expect(text(trees[0])).toContain('Submit answers');
  await act(async () => { ref.current?.performAction(); });
  expect(replies).toEqual([[['CSV'], ['Short']]]);
  expect(text(trees[0])).toContain('Answers submitted');
  await act(async () => { trees[0].unmount(); });
});

test('clarification is discussion and leaves the answer available', async () => {
  const replies: string[][][] = [];
  const discussion: string[] = [];
  const trees: ReactTestRenderer[] = [];
  await act(async () => {
    trees.push(create(<QuestionPrompt request={request} onReject={() => undefined} onReply={(_id, answers) => { replies.push(answers); }} onDiscuss={async (value) => { discussion.push(value); }} />));
  });
  const tree = trees[0];
  await act(async () => { tree.root.findAllByType('button').find((b) => b.children.includes('Ask for clarification'))?.props.onClick(); });
  await act(async () => { tree.root.findAllByType('textarea').find((input) => input.props.id.endsWith('-discussion'))?.props.onChange({ target: { value: 'Does this include tables?' } }); });
  await act(async () => { await tree.root.findAllByType('form')[1].props.onSubmit({ preventDefault() {} }); });
  expect(discussion).toHaveLength(1);
  expect(discussion[0]).toContain('Does this include tables?');
  expect(discussion[0]).toContain('not my answer');
  expect(replies).toEqual([]);
  expect(text(tree)).toContain('Custom answer');
  await act(async () => { tree.unmount(); });
});

test('an enabled answer submits while clarification is pending without duplicate delivery', async () => {
  const replies: string[][][] = [];
  const discussions: string[] = [];
  let finishDiscussion = () => {};
  let finishReply = () => {};
  const trees: ReactTestRenderer[] = [];
  await act(async () => {
    trees.push(create(<QuestionPrompt request={request} onReject={() => undefined}
      onReply={(_id, answers) => {
        replies.push(answers);
        return new Promise<void>((resolve) => { finishReply = resolve; });
      }}
      onDiscuss={(value) => {
        discussions.push(value);
        return new Promise<void>((resolve) => { finishDiscussion = resolve; });
      }} />));
  });
  const tree = trees[0];
  await act(async () => {
    tree.root.findAllByType('button').find((b) => b.children.includes('Ask for clarification'))?.props.onClick();
  });
  await act(async () => {
    tree.root.findAllByType('textarea').find((input) => input.props.id.endsWith('-discussion'))?.props.onChange({ target: { value: 'Does this include tables?' } });
  });
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    const form = tree.root.findAllByType('form')[1];
    pending = form.props.onSubmit({ preventDefault() {} });
    void form.props.onSubmit({ preventDefault() {} });
  });
  expect(discussions).toHaveLength(1);
  await act(async () => {
    const option = tree.root.findAllByType('button').find((b) => b.props['aria-pressed'] !== undefined);
    expect(option).toBeDefined();
    expect(option?.props.disabled).not.toBe(true);
    option?.props.onClick();
    option?.props.onClick();
  });
  expect(replies).toEqual([[['Text']]]);
  await act(async () => { finishDiscussion(); await pending; });
  expect(replies).toEqual([[['Text']]]);
  expect(text(tree)).toContain('Submitting');
  await act(async () => { finishReply(); });
  expect(text(tree)).toContain('Answers submitted');
  await act(async () => { tree.unmount(); });
});

// A host's locale must control the question controls, not only the surrounding page.
test("uses host translations for custom-answer and clarification controls", async () => {
  const messages = {
    ...defaultUiMessages,
    questionPrompt: {
      customAnswer: "Eigene Antwort",
      customPlaceholder: "Antwort eingeben",
      submitAnswer: "Antwort senden",
      askClarification: "Nachfragen",
    },
  };
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <UiProvider i18n={{ locale: "de", messages }}>
        <QuestionPrompt
          request={request}
          onReply={() => undefined}
          onReject={() => undefined}
          onDiscuss={async () => undefined}
        />
      </UiProvider>,
    );
  });
  expect(text(tree)).toContain("Eigene Antwort");
  expect(text(tree)).toContain("Antwort eingeben");
  expect(text(tree)).toContain("Antwort senden");
  expect(text(tree)).toContain("Nachfragen");
  expect(text(tree)).not.toContain("Custom answer");
  await act(async () => {
    tree.unmount();
  });
});
