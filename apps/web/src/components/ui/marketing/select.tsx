'use client';

import { marketingButtonVariants } from '@/components/ui/marketing/button';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { cn } from '@kortix/ui';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectValue,
} from '@kortix/ui/select';
import { CaretDownIcon } from '@phosphor-icons/react';
import * as React from 'react';

type SelectSize = 'default' | 'sm' | 'lg';

function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: Omit<React.ComponentProps<'button'>, 'size' | 'value'> & {
  size?: SelectSize;
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        marketingButtonVariants({ variant: 'secondary', size }),
        'w-full justify-between font-medium',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="flex shrink-0">
        <CaretDownIcon className="size-4 shrink-0 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
