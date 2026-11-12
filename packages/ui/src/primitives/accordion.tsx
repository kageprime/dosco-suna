'use client';

import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';
import { CaretDownIcon as ChevronDownIcon } from '@phosphor-icons/react';
import * as React from 'react';

import { asChildRender, openState, stateRender } from '../lib/base-ui-compat';
import { cn } from '../lib/utils';

type AccordionBaseProps = Omit<
  React.ComponentPropsWithoutRef<'div'>,
  'defaultValue' | 'dir' | 'onChange'
> & {
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
  dir?: 'ltr' | 'rtl';
  asChild?: boolean;
};

type AccordionSingleProps = AccordionBaseProps & {
  type: 'single';
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Lets the open item close again. Without it one item always stays open. */
  collapsible?: boolean;
};

type AccordionMultipleProps = AccordionBaseProps & {
  type: 'multiple';
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
};

type AccordionProps = AccordionSingleProps | AccordionMultipleProps;

const toArray = (value: string | string[] | undefined) =>
  value === undefined ? undefined : Array.isArray(value) ? value : value ? [value] : [];

/**
 * The Radix accordion contract on Base UI: `type="single"` takes and returns
 * a string, `type="multiple"` an array, and a single accordion without
 * `collapsible` keeps its open item open.
 */
function Accordion(props: AccordionProps) {
  const {
    type,
    value,
    defaultValue,
    onValueChange,
    collapsible: collapsibleProp,
    asChild,
    children,
    dir: _dir,
    ...rest
  } = props as AccordionBaseProps & {
    type: 'single' | 'multiple';
    value?: string | string[];
    defaultValue?: string | string[];
    onValueChange?: (value: never) => void;
    collapsible?: boolean;
  };
  const single = type === 'single';
  const collapsible = single ? collapsibleProp : true;
  const isControlled = value !== undefined;
  const [inner, setInner] = React.useState<string[]>(() => toArray(defaultValue) ?? []);
  const current = isControlled ? (toArray(value) ?? []) : inner;

  const handleChange = (next: unknown[]) => {
    const values = next as string[];
    if (single && !collapsible && values.length === 0) return;
    if (!isControlled) setInner(values);
    if (single) (onValueChange as ((v: string) => void) | undefined)?.(values[0] ?? '');
    else (onValueChange as ((v: string[]) => void) | undefined)?.(values);
  };

  const slot = asChildRender(asChild, children);
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      {...rest}
      multiple={!single}
      value={current}
      onValueChange={handleChange}
      render={slot.render}
    >
      {slot.children}
    </AccordionPrimitive.Root>
  );
}

function AccordionItem({
  className,
  asChild,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'div'>, 'onChange'> & {
  value: string;
  disabled?: boolean;
  asChild?: boolean;
}) {
  const slot = asChildRender(asChild, children);
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      {...props}
      className={cn('border-b last:border-b-0', className)}
      render={stateRender('div', openState, slot.render)}
    >
      {slot.children}
    </AccordionPrimitive.Item>
  );
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'button'>) {
  return (
    <AccordionPrimitive.Header className="flex" render={stateRender('h3', openState)}>
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        {...props}
        className={cn(
          'focus-visible:border-ring focus-visible:ring-ring/50 flex flex-1 cursor-pointer items-start justify-between gap-4 rounded-2xl py-4 text-left text-sm font-medium transition-colors outline-none hover:underline focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180',
          className,
        )}
        render={stateRender('button', openState)}
      >
        {children}
        <ChevronDownIcon className="text-muted-foreground pointer-events-none size-4 shrink-0 translate-y-0.5 transition-transform duration-moderate" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({
  className,
  children,
  forceMount,
  style,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & { forceMount?: true }) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      {...props}
      keepMounted={forceMount}
      className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden text-sm"
      // The keyframes in theme.css read the Radix variable name.
      style={
        {
          '--radix-accordion-content-height': 'var(--accordion-panel-height)',
          '--radix-accordion-content-width': 'var(--accordion-panel-width)',
          ...style,
        } as React.CSSProperties
      }
      render={stateRender('div', openState)}
    >
      <div className={cn('pt-0 pb-4', className)}>{children}</div>
    </AccordionPrimitive.Panel>
  );
}

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
