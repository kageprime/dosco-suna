'use client';

import { useState } from 'react';
import {
  SparkleIcon,
  PaperPlaneTiltIcon,
  ArrowsCounterClockwiseIcon,
  RobotIcon,
  UserIcon,
  CodeIcon,
  PlayIcon,
  XIcon,
} from '@phosphor-icons/react';

import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  ModalTitle,
} from '../../../primitives/modal';
import { AgentMark } from '../../../internal/components/agent-mark';
import { cn } from '../../../internal/lib/utils';
import { capitalizeWords } from '@kortix/shared';

interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  thought?: string;
}

interface AgentPlaygroundSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  prompt: string;
  description?: string;
  onStartSession?: () => void;
}

export function AgentPlaygroundSheet({
  open,
  onOpenChange,
  agentName,
  prompt,
  description,
  onStartSession,
}: AgentPlaygroundSheetProps) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'agent',
      content: `Hello! I am **${capitalizeWords(agentName)}**. ${
        description || 'How can I assist you in this project?'
      }\n\nTry sending me a test message to evaluate how I respond with your current instructions.`,
    },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [showPromptPreview, setShowPromptPreview] = useState(false);

  const handleSend = (textToSend?: string) => {
    const text = textToSend ?? input.trim();
    if (!text || isLoading) return;

    const userMessage: Message = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    // Simulate agent response based on draft prompt and persona
    setTimeout(() => {
      const isCode = text.toLowerCase().includes('code') || text.toLowerCase().includes('write');
      const sampleResponse = isCode
        ? `Here is an implementation based on your instructions:\n\n\`\`\`typescript\n// ${capitalizeWords(
            agentName,
          )} - verified logic\nexport function example() {\n  return "Execution successful";\n}\n\`\`\`\n\nI followed your guidelines and kept the implementation concise.`
        : `Understood. Based on my instructions:\n> "${(prompt || 'Be helpful and concise.').slice(
            0,
            90,
          )}..."\n\nI will proceed by breaking this task down step by step and validating each outcome. What would you like to execute next?`;

      const agentMessage: Message = {
        id: `a-${Date.now()}`,
        role: 'agent',
        thought: 'Analyzed draft instructions and context.',
        content: sampleResponse,
      };

      setMessages((prev) => [...prev, agentMessage]);
      setIsLoading(false);
    }, 600);
  };

  const handleClear = () => {
    setMessages([
      {
        id: 'welcome',
        role: 'agent',
        content: `Conversation reset. I am ready to test with ${capitalizeWords(
          agentName,
        )}'s latest draft configuration.`,
      },
    ]);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="flex flex-col sm:max-w-2xl h-[85vh] p-0 overflow-hidden">
        {/* Header */}
        <ModalHeader className="border-border/60 flex flex-row items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-3">
            <AgentMark slug={agentName} />
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <ModalTitle className="text-foreground text-sm font-semibold">
                  {capitalizeWords(agentName)} Playground
                </ModalTitle>
                <Badge variant="secondary" size="xs">
                  Interactive Test
                </Badge>
              </div>
              <p className="text-muted-foreground text-xs">
                Test prompts and verify agent behavior before saving.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleClear}
              title="Reset conversation"
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowsCounterClockwiseIcon className="size-3.5" />
            </Button>
            {onStartSession ? (
              <Button
                variant="secondary"
                size="xs"
                onClick={() => {
                  onOpenChange(false);
                  onStartSession();
                }}
                className="gap-1.5"
              >
                <PlayIcon weight="fill" className="size-3" />
                <span>Start Session</span>
              </Button>
            ) : null}
          </div>
        </ModalHeader>

        {/* Prompt Inspection Banner */}
        <div className="bg-muted/30 border-border/60 border-b px-5 py-2 text-xs flex items-center justify-between">
          <span className="text-muted-foreground truncate max-w-md">
            Active Prompt:{' '}
            <span className="text-foreground font-mono">
              {prompt ? `${prompt.slice(0, 60)}...` : '(Default instructions)'}
            </span>
          </span>
          <button
            type="button"
            onClick={() => setShowPromptPreview(!showPromptPreview)}
            className="text-foreground hover:underline font-medium ml-2 shrink-0 cursor-pointer"
          >
            {showPromptPreview ? 'Hide' : 'Inspect'}
          </button>
        </div>

        {showPromptPreview ? (
          <div className="bg-popover border-border/60 max-h-40 overflow-y-auto border-b p-4 font-mono text-xs leading-relaxed text-muted-foreground">
            {prompt || 'No custom system prompt specified.'}
          </div>
        ) : null}

        {/* Transcript Body */}
        <ModalBody className="flex-1 space-y-4 overflow-y-auto p-5">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                'flex gap-3 text-xs leading-relaxed',
                msg.role === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              {msg.role === 'agent' ? (
                <span className="bg-muted text-foreground flex size-6 shrink-0 items-center justify-center rounded-sm">
                  <RobotIcon className="size-3.5" />
                </span>
              ) : null}

              <div
                className={cn(
                  'max-w-[85%] rounded-md px-3.5 py-2.5',
                  msg.role === 'user'
                    ? 'bg-foreground text-background font-normal'
                    : 'bg-popover border-border/80 border text-foreground space-y-1.5',
                )}
              >
                {msg.thought ? (
                  <div className="text-muted-foreground border-b pb-1 text-xs font-mono">
                    ✦ {msg.thought}
                  </div>
                ) : null}
                <div className="whitespace-pre-wrap">{msg.content}</div>
              </div>

              {msg.role === 'user' ? (
                <span className="bg-foreground text-background flex size-6 shrink-0 items-center justify-center rounded-sm">
                  <UserIcon className="size-3.5" />
                </span>
              ) : null}
            </div>
          ))}

          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-sm">
                <RobotIcon className="size-3.5 animate-pulse" />
              </span>
              <span>Thinking...</span>
            </div>
          ) : null}
        </ModalBody>

        {/* Quick Suggestion Chips */}
        <div className="border-border/50 flex flex-wrap gap-1.5 border-t px-5 pt-2 pb-1">
          {[
            'What are your instructions?',
            'What tools can you use?',
            'How do you review code changes?',
          ].map((suggestion) => (
            <button
              type="button"
              key={suggestion}
              onClick={() => handleSend(suggestion)}
              className="bg-muted hover:bg-hover hover:text-foreground text-muted-foreground rounded-sm px-2 py-0.5 text-xs transition-colors cursor-pointer"
            >
              {suggestion}
            </button>
          ))}
        </div>

        {/* Input Footer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="border-border/60 flex items-center gap-2 border-t p-3 px-5"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Message ${capitalizeWords(agentName)} to test...`}
            className="bg-popover border-border/80 text-foreground placeholder:text-muted-foreground flex-1 rounded-md border px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button type="submit" size="sm" disabled={!input.trim() || isLoading} className="gap-1">
            <PaperPlaneTiltIcon weight="fill" className="size-3" />
            <span>Send</span>
          </Button>
        </form>
      </ModalContent>
    </Modal>
  );
}
