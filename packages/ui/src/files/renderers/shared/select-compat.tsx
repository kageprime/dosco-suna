'use client';

// Vendored extend.ai viewers (e.g. pdf-viewer.tsx) are written against
// extend.ai's own base-ui-powered `Select` (`modal` on the root,
// `alignItemWithTrigger` on the content/popup). `@kortix/ui`'s `Select` runs
// on Base UI too and accepts both props, but this shim drops them, so these
// viewers keep the non-modal, popper-positioned select they have always had.
import {
  SelectContent as SelectContentPrimitive,
  SelectItem,
  Select as SelectPrimitive,
  SelectTrigger,
  SelectValue,
} from '../../../primitives/select';
import * as React from 'react';

export { SelectItem, SelectTrigger, SelectValue };

type SelectCompatProps = React.ComponentProps<typeof SelectPrimitive> & {
  modal?: boolean;
};

export function Select({ modal: _modal, ...props }: SelectCompatProps) {
  return <SelectPrimitive {...props} />;
}

type SelectContentCompatProps = React.ComponentProps<typeof SelectContentPrimitive> & {
  alignItemWithTrigger?: boolean;
};

export function SelectContent({
  alignItemWithTrigger: _alignItemWithTrigger,
  ...props
}: SelectContentCompatProps) {
  return <SelectContentPrimitive {...props} />;
}
